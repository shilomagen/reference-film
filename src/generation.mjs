import fs from "node:fs";
import path from "node:path";
import {
  download as downloadFile, ensureDir, existsNonEmpty, mapLimit, objectHash, readJson,
  runProcess, sha256, sleep as defaultSleep, toDataUri, writeJsonAtomic,
} from "./io.mjs";
import { requestedVideoDuration } from "./providers/index.mjs";
import { buildGeminiVideoPrompt, buildImagePrompt, buildVideoPrompt } from "./prompts.mjs";
import { chooseCandidate, evaluateImageCandidates, evaluateVideoFrames, imageQaFingerprint, videoQaFingerprint } from "./qa.mjs";
import { generationFingerprint, invalidateSelection, qualityFingerprint, scenePaths, validArtifact, writeSelection } from "./artifacts.mjs";
import { buildTimeline } from "./assembly.mjs";

function now(clock) { return clock().toISOString(); }
function rounds(config) { return config.generation.imageRounds ?? 1; }
function videoAttempts(config) { return config.generation.videoAttempts ?? 1; }
function imageFiles(directory, count) { return Array.from({ length: count }, (_, index) => path.join(directory, `candidate_${String(index + 1).padStart(2, "0")}.jpg`)); }
function cleanCost(value) { return Number.isFinite(value) ? value : null; }

async function saveImageCandidates(response, targets, download) {
  if (!Array.isArray(response?.images) || response.images.length !== targets.length) throw new Error(`Image provider returned ${response?.images?.length ?? 0} candidates; expected ${targets.length}`);
  for (let index = 0; index < targets.length; index += 1) {
    const item = response.images[index];
    ensureDir(path.dirname(targets[index]));
    if (typeof item?.data === "string") fs.writeFileSync(targets[index], Buffer.from(item.data, "base64"));
    else if (typeof item?.url === "string") await download(item.url, targets[index]);
    else throw new Error(`Image candidate ${index + 1} contained no data`);
    if (!existsNonEmpty(targets[index])) throw new Error(`Image candidate ${index + 1} is empty`);
  }
}

function validCandidateCache(metadata, targets, fingerprint) {
  return metadata?.generationFingerprint === fingerprint && Array.isArray(metadata.candidates) && metadata.candidates.length === targets.length && targets.every((file, index) => existsNonEmpty(file) && metadata.candidates[index]?.sha256 === sha256(file));
}

async function fitDirectPhoto(source, target, config, process = runProcess) {
  ensureDir(path.dirname(target));
  const { width, height } = config.assembly;
  const filter = `[0:v]split=2[b][f];[b]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28[bg];[f]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[out]`;
  await process("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-q:v", "2", target], { capture: true });
}

export function imageFingerprints(config, plan, scene, { epoch = 0 } = {}) {
  const references = scene.characters.flatMap((name) => config.inputs.faces[name].map((file) => ({ character: name, hash: sha256(file) })));
  const prompt = buildImagePrompt({ scene, config, plan });
  return {
    prompt,
    generation: generationFingerprint(scene.source_image_mode === "direct_animation" ? { epoch, mode: "direct_animation", source: sha256(scene.source_image), size: [config.assembly.width, config.assembly.height], aspectRatio: scene.image_generation.aspect_ratio } : { epoch, prompt, references, model: config.models.image, count: config.generation.imageCandidates, rounds: rounds(config), resolution: config.generation.imageResolution ?? null, quality: config.generation.imageQuality ?? null, aspectRatio: scene.image_generation.aspect_ratio ?? plan.aspect_ratio ?? "16:9" }),
    qa: qualityFingerprint(imageQaFingerprint(config)),
  };
}

function operationIdentity(sceneId, stage, epoch, unit, fingerprints) {
  return [sceneId, stage, `epoch-${epoch}`, unit, ...fingerprints.map((item) => String(item).slice(0, 24))].join("/");
}

function epochWorkDirectory(root, epoch) {
  return epoch === 0 ? root : path.join(root, `epoch_${String(epoch).padStart(4, "0")}`);
}

export async function generateImages({ registry, providers = registry, config, plan, yes = false, clock = () => new Date(), process = runProcess, download = downloadFile, operationEpochs = {} }) {
  if (!yes) throw new Error("Paid image generation requires yes: true (spend acknowledgement)");
  const imageProvider = providers.image;
  const judgeProvider = providers.judge;
  return mapLimit(plan.scenes, config.generation.concurrency, async (scene) => {
    const paths = scenePaths(config, plan, scene);
    ensureDir(paths.image);
    const epoch = operationEpochs[scene.scene_id] ?? 0;
    const fingerprints = imageFingerprints(config, plan, scene, { epoch });
    await writeJsonAtomic(paths.scene, { ...scene, generationEpoch: epoch, compiledPrompts: { image: fingerprints.prompt, video: buildVideoPrompt({ scene, config, plan }) } });
    const prior = readJson(paths.imageSelection, null);
    if (validArtifact(paths.selectedImage, prior, { generationFingerprint: fingerprints.generation, qaFingerprint: fingerprints.qa })) return prior;
    if (prior) await invalidateSelection(paths.imageSelection, "image generation or QA fingerprint changed, or selected checksum is invalid", { generationFingerprint: fingerprints.generation, qaFingerprint: fingerprints.qa });

    if (scene.source_image_mode === "direct_animation") {
      await fitDirectPhoto(scene.source_image, paths.selectedImage, config, process);
      return writeSelection(paths.imageSelection, paths.selectedImage, { sceneId: scene.scene_id, status: "selected", sourceMode: "direct_animation", generationEpoch: epoch, generationFingerprint: fingerprints.generation, qaFingerprint: fingerprints.qa, selectedAt: now(clock), costUsd: 0, costUnknown: false, technicalPassed: true });
    }

    const references = scene.characters.flatMap((name) => config.inputs.faces[name]).map(toDataUri);
    const history = [];
    let bestNeedsReview = null;
    for (let round = 1; round <= rounds(config); round += 1) {
      const directory = path.join(epochWorkDirectory(paths.image, epoch), `round_${String(round).padStart(2, "0")}`);
      const generationPath = path.join(directory, "generation.json");
      const qaPath = path.join(directory, "qa.json");
      const targets = imageFiles(directory, config.generation.imageCandidates);
      ensureDir(directory);
      let generation = readJson(generationPath, null);
      if (!validCandidateCache(generation, targets, fingerprints.generation)) {
        const requestAndPersist = async () => {
          const response = await imageProvider.generateCandidates({ model: config.models.image, prompt: fingerprints.prompt, referenceImages: references, count: targets.length, aspectRatio: scene.image_generation.aspect_ratio ?? plan.aspect_ratio ?? "16:9", resolution: config.generation.imageResolution, quality: config.generation.imageQuality, operationKey: operationIdentity(scene.scene_id, "image", epoch, `round-${round}`, [fingerprints.generation]) });
          if (response?.reused && (!Array.isArray(response.images) || response.images.length === 0)) throw new Error(`${scene.scene_id}: paid image result is unavailable locally; reconcile the provider journal entry before replacement`);
          await saveImageCandidates(response, targets, download);
          const persisted = { sceneId: scene.scene_id, round, generationFingerprint: fingerprints.generation, generatedAt: now(clock), requestId: response.requestId ?? null, costUsd: cleanCost(response.costUsd), costUnknown: !Number.isFinite(response.costUsd), candidates: targets.map((file) => ({ file: path.basename(file), sha256: sha256(file) })) };
          await writeJsonAtomic(generationPath, persisted);
          return { response, persisted };
        };
        generation = (await requestAndPersist()).persisted;
      }
      let qa = readJson(qaPath, null);
      if (qa?.qaFingerprint !== fingerprints.qa || qa?.candidateFingerprint !== objectHash(generation.candidates)) {
        const judgeAndPersist = async () => {
          const judged = await evaluateImageCandidates({ client: judgeProvider, config, scene, candidatePaths: targets, operationKey: operationIdentity(scene.scene_id, "image-qa", epoch, `round-${round}`, [fingerprints.generation, fingerprints.qa, objectHash(generation.candidates)]) });
          const persisted = { ...judged, qaFingerprint: fingerprints.qa, candidateFingerprint: objectHash(generation.candidates), judgedAt: now(clock) };
          await writeJsonAtomic(qaPath, persisted);
          return persisted;
        };
        qa = await judgeAndPersist();
      }
      const candidates = qa.candidates.map((candidate, index) => ({ ...candidate, round, path: path.relative(paths.root, targets[index]), sha256: generation.candidates[index].sha256 }));
      history.push({ round, generation, qa: { ...qa, candidates } });
      const selected = chooseCandidate(candidates);
      if (!config.quality.judgeEnabled) {
        bestNeedsReview ??= selected;
        break;
      }
      if (selected?.passed) {
        fs.copyFileSync(targets[selected.candidate - 1], paths.selectedImage);
        return writeSelection(paths.imageSelection, paths.selectedImage, { sceneId: scene.scene_id, status: "selected", generationEpoch: epoch, generationFingerprint: fingerprints.generation, qaFingerprint: fingerprints.qa, selectedAt: now(clock), selected: { round, candidate: selected.candidate, sourceSha256: selected.sha256, score: selected.weighted_score }, attempts: history, costUsd: history.reduce((sum, item) => sum + Number(item.generation.costUsd ?? 0) + Number(item.qa.costUsd ?? 0), 0), costUnknown: history.some((item) => item.generation.costUnknown || item.qa.costUnknown) });
      }
    }
    const status = config.quality.judgeEnabled ? "failed" : "needs_review";
    await writeJsonAtomic(paths.imageSelection, { sceneId: scene.scene_id, status, generationEpoch: epoch, generationFingerprint: fingerprints.generation, qaFingerprint: fingerprints.qa, candidate: bestNeedsReview, attempts: history, reason: status === "needs_review" ? "Automated judging disabled; manually approve a candidate checksum" : "No candidate passed image QA" });
    if (status === "failed") throw new Error(`${scene.scene_id}: no image candidate passed QA`);
    return readJson(paths.imageSelection);
  });
}

export async function inspectVideo(filePath, process = runProcess) {
  const { stdout } = await process("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type,width,height,pix_fmt,avg_frame_rate:format=duration", "-of", "json", filePath], { capture: true });
  const value = JSON.parse(stdout);
  value.duration = Number(value.format?.duration ?? 0);
  return value;
}

async function extractFrames(filePath, directory, duration, process = runProcess) {
  ensureDir(directory);
  const files = [];
  for (const [index, fraction] of [0.12, 0.5, 0.88].entries()) {
    const output = path.join(directory, `frame_${String(index + 1).padStart(2, "0")}.jpg`);
    await process("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", Math.max(0, duration * fraction).toFixed(3), "-i", filePath, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "2", output], { capture: true });
    files.push(output);
  }
  return files;
}

async function pollExisting({ provider, operationId, timeoutMs, intervalMs, clockMs, sleep }) {
  const deadline = clockMs() + timeoutMs;
  while (clockMs() <= deadline) {
    const result = await provider.getVideo(operationId);
    if (result.status === "done") return result;
    if (["failed", "filtered", "expired"].includes(result.status)) { const error = new Error(`Video operation ${operationId} ${result.status}`); error.definitiveVideoFailure = true; error.result = result; throw error; }
    await sleep(intervalMs);
  }
  const error = new Error(`Video operation ${operationId} polling timed out; rerun to resume the same operation`);
  error.resumeRequired = true;
  throw error;
}

function technicalFailures(probe, requestedDuration) {
  const failures = [];
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  if (!video) failures.push("missing video stream");
  if (!Number.isFinite(probe.duration) || probe.duration <= 0) failures.push("invalid duration");
  else if (Math.abs(probe.duration - requestedDuration) > Math.max(1.5, requestedDuration * 0.25)) failures.push(`duration ${probe.duration.toFixed(3)} differs from requested ${requestedDuration}`);
  return failures;
}

function configuredVideoModel(config, providerName, registry) {
  return registry?.models?.video ?? (providerName === "gemini" ? config.models.geminiVideo : config.models.video);
}

export function videoProviderContract(providerName) {
  if (providerName === "xai") return { supportedDurations: () => Array.from({ length: 15 }, (_, index) => index + 1), supportsAudioControl: () => true };
  if (providerName === "gemini") return { supportedDurations: (resolution) => String(resolution).toLowerCase() === "720p" ? [4, 6, 8] : [8], supportsAudioControl: () => false };
  throw new Error(`Unsupported video provider '${providerName}'`);
}

export function videoFingerprints({ config, plan, scene, providerName = config.providers.video, imageSelection, targetDuration, requestedDuration, model, audioControl, epoch = 0 }) {
  if (![targetDuration, requestedDuration].every((value) => Number.isFinite(value) && value > 0)) throw new Error(`${scene.scene_id}: targetDuration and requestedDuration must be positive finite numbers`);
  const expectedImage = imageFingerprints(config, plan, scene, { epoch: imageSelection?.generationEpoch ?? 0 });
  const prompt = providerName === "gemini" ? buildGeminiVideoPrompt({ scene, config, plan }) : buildVideoPrompt({ scene, config, plan });
  const referenceHashes = scene.characters.flatMap((name) => config.inputs.faces[name].map((file) => ({ character: name, sha256: sha256(file) })));
  const generation = generationFingerprint({ epoch, prompt, sourceSha256: imageSelection?.sha256, sourceGenerationFingerprint: imageSelection?.generationFingerprint, expectedImageGenerationFingerprint: expectedImage.generation, provider: providerName, model, requestedDuration, targetDuration, resolution: config.generation.videoResolution ?? "720p", aspectRatio: scene.image_generation.aspect_ratio ?? plan.aspect_ratio ?? "16:9", audioPolicy: audioControl ? "disabled" : "strip-in-assembly" });
  const qa = qualityFingerprint(videoQaFingerprint(config, { direct: scene.source_image_mode === "direct_animation", sourceStillSha256: imageSelection?.sha256, referenceHashes }));
  return { prompt, generation, qa, expectedImage, referenceHashes };
}

export async function generateVideos({ registry, providers = registry, config, plan, yes = false, clock = () => new Date(), clockMs = Date.now, sleep = defaultSleep, process = runProcess, operationEpochs = {} }) {
  if (!yes) throw new Error("Paid video generation requires yes: true (spend acknowledgement)");
  const provider = providers.video;
  const judge = providers.judge;
  const providerName = registry?.selected?.video ?? config.providers.video;
  const timeline = await buildTimeline(config, { ...plan, scenes: plan.allScenes });
  const durations = new Map(timeline.scenes.map((item) => [item.scene_id, item.duration_seconds]));
  return mapLimit(plan.scenes, config.generation.concurrency, async (scene) => {
    const paths = scenePaths(config, plan, scene, providerName);
    ensureDir(paths.video);
    const imageSelection = readJson(paths.imageSelection, null);
    const expectedImage = imageFingerprints(config, plan, scene, { epoch: imageSelection?.generationEpoch ?? 0 });
    if (!validArtifact(paths.selectedImage, imageSelection, { generationFingerprint: expectedImage.generation, qaFingerprint: expectedImage.qa })) throw new Error(`${scene.scene_id}: selected still metadata/status/fingerprint/checksum is missing, stale, or invalid`);
    const epoch = operationEpochs[scene.scene_id] ?? 0;
    const targetDuration = durations.get(scene.scene_id);
    const resolution = config.generation.videoResolution ?? "720p";
    const requestedDuration = requestedVideoDuration(provider, resolution, targetDuration);
    const model = configuredVideoModel(config, providerName, registry);
    const fingerprints = videoFingerprints({ config, plan, scene, providerName, imageSelection, targetDuration, requestedDuration, model, audioControl: provider.supportsAudioControl(), epoch });
    const { prompt, generation, qa: qaFingerprint } = fingerprints;
    const previous = readJson(paths.videoSelection, null);
    if (validArtifact(paths.selectedVideo, previous, { generationFingerprint: generation, qaFingerprint })) return previous;
    if (previous) await invalidateSelection(paths.videoSelection, "video generation or QA fingerprint changed, or selected checksum is invalid", { generationFingerprint: generation, qaFingerprint });
    const attempts = [];

    for (let attempt = 1; attempt <= videoAttempts(config); attempt += 1) {
      const directory = path.join(epochWorkDirectory(paths.video, epoch), `attempt_${String(attempt).padStart(2, "0")}`);
      const requestPath = path.join(directory, "request.json");
      const resultPath = path.join(directory, "result.json");
      const clipPath = path.join(directory, "clip.mp4");
      const qaPath = path.join(directory, "qa.json");
      ensureDir(directory);
      let request = readJson(requestPath, null);
      if (request?.generationFingerprint !== generation) request = null;
      if (!request) {
        const started = await provider.startVideo({ model, prompt, sourceImage: toDataUri(paths.selectedImage), duration: requestedDuration, aspectRatio: scene.image_generation.aspect_ratio ?? plan.aspect_ratio ?? "16:9", resolution, options: { generateAudio: false }, operationKey: operationIdentity(scene.scene_id, "video", epoch, `attempt-${attempt}`, [generation]) });
        if (!started?.operationId) throw new Error(`${scene.scene_id}: video provider omitted operationId`);
        request = { sceneId: scene.scene_id, attempt, epoch, provider: providerName, model, operationId: started.operationId, requestId: started.requestId ?? null, generationFingerprint: generation, requestedDuration, targetDuration, resolution, status: "pending", reused: Boolean(started.reused), startedAt: now(clock), costUsd: cleanCost(started.costUsd), costUnknown: !Number.isFinite(started.costUsd) };
        await writeJsonAtomic(requestPath, request);
      }
      let result = readJson(resultPath, null);
      if (!existsNonEmpty(clipPath) || result?.generationFingerprint !== generation || result?.sha256 !== sha256(clipPath)) {
        try {
          result = await pollExisting({ provider, operationId: request.operationId, timeoutMs: config.generation.pollTimeoutMs, intervalMs: config.generation.pollIntervalMs, clockMs, sleep });
          await writeJsonAtomic(resultPath, { status: "done", operationId: request.operationId, generationFingerprint: generation, completedAt: now(clock), costUsd: cleanCost(result.costUsd), costUnknown: !Number.isFinite(result.costUsd), downloadPending: true });
          if (!result.video?.url) throw Object.assign(new Error("Completed video operation omitted its download URL; rerun to re-poll"), { resumeRequired: true });
          await provider.downloadVideo(result.video.url, clipPath);
          if (!existsNonEmpty(clipPath)) throw Object.assign(new Error("Downloaded video is empty; rerun to re-poll"), { resumeRequired: true });
          result = { status: "done", operationId: request.operationId, generationFingerprint: generation, completedAt: now(clock), sha256: sha256(clipPath), costUsd: cleanCost(result.costUsd), costUnknown: !Number.isFinite(result.costUsd) };
          await writeJsonAtomic(resultPath, result);

        } catch (error) {
          if (!error.definitiveVideoFailure) throw error;
          attempts.push({ attempt, operationId: request.operationId, status: error.result.status, passed: false, costUsd: request.costUsd, costUnknown: request.costUnknown });
          await writeJsonAtomic(resultPath, { status: error.result.status, operationId: request.operationId, generationFingerprint: generation, failedAt: now(clock) });

          continue;
        }
      }
      const probe = await inspectVideo(clipPath, process);
      const failures = technicalFailures(probe, requestedDuration);
      const framePaths = failures.includes("missing video stream") ? [] : await extractFrames(clipPath, path.join(directory, "qa_frames"), probe.duration || requestedDuration, process);
      let qa = readJson(qaPath, null);
      const clipSha = sha256(clipPath);
      if (qa?.qaFingerprint !== qaFingerprint || qa?.clipSha256 !== clipSha) {
        const judgeAndPersist = async () => {
          const judged = framePaths.length ? await evaluateVideoFrames({ client: judge, config, scene, sourceStill: paths.selectedImage, framePaths, operationKey: operationIdentity(scene.scene_id, "video-qa", epoch, `attempt-${attempt}`, [generation, qaFingerprint, clipSha]) }) : { passed: false, automatedJudge: config.quality.judgeEnabled, costUsd: 0, costUnknown: false };
          const persisted = { ...judged, qaFingerprint, clipSha256: clipSha, technical_failures: failures, technicalPassed: failures.length === 0, passed: judged.passed && failures.length === 0, judgedAt: now(clock) };
          await writeJsonAtomic(qaPath, persisted);
          return persisted;
        };
        qa = await judgeAndPersist();
      }
      const generationCost = Number.isFinite(result.costUsd) ? result.costUsd : request.costUsd;
      const summary = { attempt, operationId: request.operationId, status: qa.needs_review ? "needs_review" : qa.passed ? "passed" : "failed", passed: qa.passed, clipSha256: clipSha, technicalPassed: failures.length === 0, qa, costUsd: Number(generationCost ?? 0) + Number(qa.costUsd ?? 0), costUnknown: !Number.isFinite(generationCost) || qa.costUnknown };
      attempts.push(summary);
      if (qa.passed) {
        fs.copyFileSync(clipPath, paths.selectedVideo);
        return writeSelection(paths.videoSelection, paths.selectedVideo, { sceneId: scene.scene_id, provider: providerName, status: "selected", generationEpoch: epoch, generationFingerprint: generation, qaFingerprint, sourceImageSha256: imageSelection.sha256, targetDuration, requestedDuration, selectedAttempt: attempt, selectedAt: now(clock), technicalPassed: true, attempts, costUsd: attempts.reduce((sum, item) => sum + Number(item.costUsd ?? 0), 0), costUnknown: attempts.some((item) => item.costUnknown) });
      }
      if (qa.needs_review) {
        await writeJsonAtomic(paths.videoSelection, { sceneId: scene.scene_id, provider: providerName, status: "needs_review", generationEpoch: epoch, generationFingerprint: generation, qaFingerprint, sourceImageSha256: imageSelection.sha256, targetDuration, requestedDuration, candidate: { attempt, path: path.relative(paths.root, clipPath), sha256: clipSha, technicalPassed: failures.length === 0 }, attempts, reason: "Automated judging disabled; manually approve this checksum" });
        return readJson(paths.videoSelection);
      }
    }
    await writeJsonAtomic(paths.videoSelection, { sceneId: scene.scene_id, provider: providerName, status: "failed", generationFingerprint: generation, qaFingerprint, attempts, reason: "No video attempt passed technical and visual QA" });
    throw new Error(`${scene.scene_id}: no video passed QA`);
  });
}
