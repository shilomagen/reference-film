import fs from "node:fs";
import path from "node:path";
import { executableAvailable, readJson, sha256, writeJsonAtomic } from "./io.mjs";
import { createProviderRegistry, finalArtifactPath, requestedVideoDuration } from "./providers/index.mjs";
import { createPaidOperationJournal } from "./providers/journal.mjs";
import { assemble, buildTimeline } from "./assembly.mjs";
import { buildImagePrompt, buildVideoPrompt } from "./prompts.mjs";
import { generateImages, generateVideos, imageFingerprints, videoFingerprints, videoProviderContract } from "./generation.mjs";
import { hasRightsApproval, scenePaths, validArtifact, writeRightsApproval, writeSelection } from "./artifacts.mjs";

function requireRights(config, plan) {
  if (!hasRightsApproval(config, plan)) throw new Error("Current reference/direct-photo/audio hashes do not have a rights and consent approval; call approveMedia first");
}

function requireSpend(yes) {
  if (yes !== true) throw new Error("Paid generation requires yes: true (CLI: --yes). This acknowledges spend only, not rights or editorial approval");
}

function registryConfig(config) {
  return config;
}

function makeRuntime(config, dependencies) {
  const journal = dependencies.journal ?? createPaidOperationJournal(path.join(config.outputs, "paid-operations"), { clock: dependencies.clock });
  const registry = dependencies.registry ?? createProviderRegistry(registryConfig(config), { ...dependencies, journal });
  return { registry, journal };
}

function manifestPath(config) { return path.join(config.outputs, "media-run.json"); }
function epochsPath(config) { return path.join(config.outputs, "generation-epochs.json"); }

async function operationEpochs(config, plan) {
  const prior = readJson(epochsPath(config), { version: 1, scenes: {} });
  const previousRun = readJson(manifestPath(config), null);
  const resumeInterruptedRun = previousRun?.status === "running" || (previousRun?.status === "failed" && previousRun.preserveGenerationEpoch === true);
  const scenes = { ...prior.scenes };
  for (const scene of plan.scenes) {
    const value = Number(scenes[scene.scene_id] ?? 0);
    scenes[scene.scene_id] = Number.isSafeInteger(value) && value >= 0 ? value + (config.force && !resumeInterruptedRun ? 1 : 0) : (config.force ? 1 : 0);
  }
  const value = { version: 1, scenes };
  await writeJsonAtomic(epochsPath(config), value);
  return scenes;
}

async function writeRun(config, value, clock = () => new Date()) {
  const prior = readJson(manifestPath(config), {});
  const safe = { version: 1, project: config.metadata.slug, providers: config.providers, models: config.models, ...prior, ...value, updatedAt: clock().toISOString() };
  await writeJsonAtomic(manifestPath(config), safe);
  return safe;
}

function assertPaidModels(config, plan, command) {
  const needsGeneratedImages = plan.scenes.some((scene) => scene.source_image_mode !== "direct_animation");
  const keys = command === "images"
    ? [...(needsGeneratedImages ? ["image"] : []), ...(needsGeneratedImages && config.quality.judgeEnabled ? ["judge"] : [])]
    : command === "videos"
      ? [config.providers.video === "gemini" ? "geminiVideo" : "video", ...(config.quality.judgeEnabled ? ["judge"] : [])]
      : [...(needsGeneratedImages ? ["image"] : []), config.providers.video === "gemini" ? "geminiVideo" : "video", ...(config.quality.judgeEnabled ? ["judge"] : [])];
  for (const key of keys) {
    const model = config.models[key];
    if (!model || /^(?:example(?:[-_ ].*)?|placeholder(?:[-_ ].*)?|your[-_ ]|change[-_ ]me|grok-(?:text|vision)$|veo-fast$)/i.test(model)) throw new Error(`Paid generation requires a non-placeholder models.${key}`);
  }
}

async function preflight({ config, plan, timings, command, process }) {
  for (const [name, files] of Object.entries(config.inputs.faces)) for (const file of files) if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`Missing face reference for ${name}`);
  for (const scene of plan.allScenes) if (scene.source_image && (!fs.existsSync(scene.source_image) || fs.statSync(scene.source_image).size === 0)) throw new Error(`Missing source image for ${scene.scene_id}`);
  if (["run", "videos"].includes(command) && !config.audio && !config.allowSilent) throw new Error("Full/video generation requires audio unless --allow-silent is set");
  if (config.audio && (!fs.existsSync(config.audio) || fs.statSync(config.audio).size === 0)) throw new Error("Configured audio is missing or empty");
  const timeline = ["run", "videos"].includes(command) ? await buildTimeline(config, { ...plan, scenes: plan.allScenes }, { timings, process }) : null;
  if (["run", "videos"].includes(command)) {
    const ffmpeg = process ? true : await executableAvailable("ffmpeg");
    const ffprobe = process ? true : await executableAvailable("ffprobe");
    if (!ffmpeg || !ffprobe) throw new Error("FFmpeg and ffprobe are required before paid full-run generation");
  }
  assertPaidModels(config, plan, command);
  return timeline;
}

export async function approveMedia({ config, plan, acknowledgeRights, clock = () => new Date() }) {
  if (acknowledgeRights !== true) throw new Error("Rights approval requires acknowledgeRights: true");
  return writeRightsApproval(config, plan, { clock });
}

export async function approveArtifact({ config, plan, sceneId, stage, checksum, provider = config.providers.video, clock = () => new Date() }) {
  if (!sceneId || !["image", "video"].includes(stage)) throw new Error("Manual approval requires sceneId and stage 'image' or 'video'");
  if (!/^[a-f0-9]{64}$/.test(checksum ?? "")) throw new Error("Manual approval requires an exact SHA256 checksum");
  const scene = plan.allScenes.find((item) => item.scene_id === sceneId);
  if (!scene) throw new Error(`Unknown scene '${sceneId}'`);
  const paths = scenePaths(config, plan, scene, provider);
  const metadataPath = stage === "image" ? paths.imageSelection : paths.videoSelection;
  const selectedPath = stage === "image" ? paths.selectedImage : paths.selectedVideo;
  const metadata = readJson(metadataPath, null);
  if (metadata?.status !== "needs_review" || !metadata.candidate) throw new Error(`${sceneId} ${stage} has no manually reviewable candidate`);
  const candidatePath = path.resolve(paths.root, metadata.candidate.path);
  if (!fs.existsSync(candidatePath) || sha256(candidatePath) !== checksum || metadata.candidate.sha256 !== checksum) throw new Error("Candidate checksum does not match the approval request");
  if (stage === "video" && metadata.candidate.technicalPassed !== true) throw new Error("Manual approval cannot override failed technical QA");
  fs.mkdirSync(path.dirname(selectedPath), { recursive: true });
  fs.copyFileSync(candidatePath, selectedPath);
  return writeSelection(metadataPath, selectedPath, { ...metadata, status: "selected", selectedAt: clock().toISOString(), manualApproval: { checksum, approvedAt: clock().toISOString() }, technicalPassed: stage === "video" ? true : metadata.technicalPassed ?? true });
}

export function reconcilePaidOperation({ config, operationId, reason, acknowledgeDuplicateRisk, journal }) {
  const instance = journal ?? createPaidOperationJournal(path.join(config.outputs, "paid-operations"));
  return instance.authorizeRetry(operationId, reason, { acknowledgeDuplicateRisk });
}

export async function mediaStatus({ config, plan, timings = null, provider = config.providers.video, videoProvider = null, process }) {
  let timeline = null;
  try { timeline = await buildTimeline(config, { ...plan, scenes: plan.allScenes }, { timings, process }); } catch { /* status remains no-spend and reports timing staleness below */ }
  const scenes = plan.allScenes.map((scene, index) => {
    const paths = scenePaths(config, plan, scene, provider);
    const image = readJson(paths.imageSelection, null);
    const video = readJson(paths.videoSelection, null);
    const expectedImage = imageFingerprints(config, plan, scene, { epoch: image?.generationEpoch ?? 0 });
    const imageValid = validArtifact(paths.selectedImage, image, { generationFingerprint: expectedImage.generation, qaFingerprint: expectedImage.qa });
    let videoValid = false;
    if (imageValid && timeline && Number.isFinite(video?.requestedDuration) && Number.isFinite(video?.targetDuration)) {
      const model = provider === "gemini" ? config.models.geminiVideo : config.models.video;
      const adapter = videoProvider ?? videoProviderContract(provider);
      const expectedVideo = videoFingerprints({ config, plan, scene, providerName: provider, imageSelection: image, targetDuration: timeline.scenes[index].duration_seconds, requestedDuration: video.requestedDuration, model, audioControl: adapter.supportsAudioControl(), epoch: video.generationEpoch ?? 0 });
      const expectedRequested = requestedVideoDuration(adapter, config.generation.videoResolution ?? "720p", timeline.scenes[index].duration_seconds);
      videoValid = validArtifact(paths.selectedVideo, video, { generationFingerprint: expectedVideo.generation, qaFingerprint: expectedVideo.qa }) && video.technicalPassed === true && video.targetDuration === timeline.scenes[index].duration_seconds && video.requestedDuration === expectedRequested;
    }
    return { scene_id: scene.scene_id, image: imageValid ? image.status : image ? "stale" : "missing", imageChecksumValid: imageValid, video: videoValid ? video.status : video ? "stale" : "missing", videoChecksumValid: videoValid, provider };
  });
  const final = finalArtifactPath(config.outputs, provider, config.metadata.slug);
  return { project: config.metadata.slug, rightsApproved: hasRightsApproval(config, plan), provider, scenes, timelineValid: Boolean(timeline), run: readJson(manifestPath(config), null), final: fs.existsSync(final) ? { status: "present", bytes: fs.statSync(final).size, sha256: sha256(final) } : { status: "missing" } };
}

export async function validateMedia({ config, plan, timings = null, process }) {
  const timeline = await buildTimeline(config, plan, { timings, process });
  const ffmpeg = process ? true : await executableAvailable("ffmpeg");
  const ffprobe = process ? true : await executableAvailable("ffprobe");
  if (!ffmpeg || !ffprobe) throw new Error("FFmpeg and ffprobe are required");
  return { status: "ok", offline: true, scenes: plan.allScenes.length, timeline, tools: { ffmpeg, ffprobe }, rightsApproved: hasRightsApproval(config, plan) };
}

export function mediaWorkloadEstimate(config, plan) {
  return { imageRequestsUpperBound: plan.scenes.filter((scene) => scene.source_image_mode !== "direct_animation").length * config.generation.imageRounds, judgeRequestsUpperBound: config.quality.judgeEnabled ? plan.scenes.filter((scene) => scene.source_image_mode !== "direct_animation").length * config.generation.imageRounds + plan.scenes.length * config.generation.videoAttempts : 0, videoRequestsUpperBound: plan.scenes.length * config.generation.videoAttempts, priceUsd: null, priceUnknown: true };
}

export async function dryRunMedia({ config, plan, timings = null, process }) {
  const timeline = await buildTimeline(config, plan, { timings, process });
  return { dryRun: true, networkCalls: 0, paidRequests: 0, project: config.metadata, providers: config.providers, outputs: config.outputs, estimate: mediaWorkloadEstimate(config, plan), timeline, scenes: plan.scenes.map((scene) => ({ scene_id: scene.scene_id, imagePrompt: buildImagePrompt({ scene, config, plan }), videoPrompt: buildVideoPrompt({ scene, config, plan }), paths: scenePaths(config, plan, scene) })) };
}

export async function runMedia({ command, config, plan, timings = null, yes = false, registry = null, journal = null, fetch, sleep, random, clock = () => new Date(), clockMs, logger, onEstimate, testOrigins, trustedOrigins, process, download } = {}) {
  if (!config || !plan) throw new Error("runMedia requires config and plan");
  if (command === "status") return mediaStatus({ config, plan, timings, videoProvider: registry?.video, process });
  if (command === "validate") return validateMedia({ config, plan, timings, process });
  if (command === "dry-run" || config.dryRun) return dryRunMedia({ config, plan, timings, process });
  if (command === "assemble") return assemble({ config, plan, timings, videoProvider: registry?.video, process, clock });
  if (!["images", "videos", "run"].includes(command)) throw new Error(`Unsupported media command '${command}'`);
  requireSpend(yes);
  requireRights(config, plan);
  await preflight({ config, plan, timings, command, process });
  const dependencies = { registry, journal, fetch, sleep, random, clock, logger, testOrigins, trustedOrigins };
  const runtime = makeRuntime(config, dependencies);
  const epochs = await operationEpochs(config, plan);
  const estimate = mediaWorkloadEstimate(config, plan);
  if (onEstimate) await onEstimate(estimate);
  await writeRun(config, { status: "running", stage: command, force: Boolean(config.force), selectedScenes: plan.scenes.map((scene) => scene.scene_id), generationEpochs: epochs, estimate }, clock);
  try {
    if (command === "images") {
      const images = await generateImages({ registry: runtime.registry, config, plan, yes, clock, process, download, operationEpochs: epochs });
      await writeRun(config, { status: images.some((item) => item.status !== "selected") ? "needs_review" : "complete", stage: "images" }, clock);
      return images;
    }
    if (command === "videos") {
      const videos = await generateVideos({ registry: runtime.registry, config, plan, yes, clock, clockMs, sleep, process, operationEpochs: epochs });
      await writeRun(config, { status: videos.some((item) => item.status !== "selected") ? "needs_review" : "complete", stage: "videos" }, clock);
      return videos;
    }
  const images = await generateImages({ registry: runtime.registry, config, plan, yes, clock, process, download, operationEpochs: epochs });
  if (images.some((item) => item.status !== "selected")) { await writeRun(config, { status: "needs_review", stage: "images" }, clock); return { status: "needs_review", stage: "images", images }; }
  const videos = await generateVideos({ registry: runtime.registry, config, plan, yes, clock, clockMs, sleep, process, operationEpochs: epochs });
  if (videos.some((item) => item.status !== "selected")) { await writeRun(config, { status: "needs_review", stage: "videos" }, clock); return { status: "needs_review", stage: "videos", images, videos }; }
  const final = await assemble({ config, plan, timings, videoProvider: runtime.registry.video, process, clock });
  await writeRun(config, { status: "complete", stage: "assemble", final: { sha256: final.sha256, output: final.output }, costs: final.costs }, clock);
  return { status: "complete", images, videos, final };
  } catch (error) {
    const safelyExhausted = /no (?:image candidate|video) passed (?:image |technical and visual )?QA/i.test(error.message);
    await writeRun(config, { status: "failed", stage: command, preserveGenerationEpoch: !safelyExhausted, failure: { name: error.name, code: error.code ?? null, journalId: error.journalId ?? null } }, clock);
    throw error;
  }
}
