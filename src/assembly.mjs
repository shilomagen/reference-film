import fs from "node:fs";
import path from "node:path";
import { ensureDir, existsNonEmpty, readJson, runProcess, sha256, writeJsonAtomic } from "./io.mjs";
import { finalArtifactPath, requestedVideoDuration } from "./providers/index.mjs";
import { imageFingerprints, videoFingerprints, videoProviderContract } from "./generation.mjs";
import { scenePaths, summarizeCosts, validArtifact } from "./artifacts.mjs";

export async function mediaDuration(filePath, process = runProcess) {
  const { stdout } = await process("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath], { capture: true });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not determine positive media duration: ${filePath}`);
  return duration;
}

function timingEntries(timings) {
  if (!timings) return [];
  if (typeof timings === "string") {
    const value = readJson(timings, null);
    if (!value) throw new Error(`Timings file could not be read: ${timings}`);
    timings = value;
  }
  if (!Array.isArray(timings.timings)) throw new Error("Timings document must contain timings[]");
  return timings.timings;
}

export async function buildTimeline(config, plan, { timings = null, process = runProcess, tolerance = 0.08 } = {}) {
  const scenes = plan.allScenes ?? plan.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) throw new Error("Timeline requires at least one scene");
  const entries = timingEntries(timings ?? config.timingsDocument ?? config.timings);
  const ids = new Set(scenes.map((scene) => scene.scene_id));
  const override = new Map();
  for (const entry of entries) {
    if (!ids.has(entry.scene_id)) throw new Error(`Timing references unknown scene '${entry.scene_id}'`);
    if (override.has(entry.scene_id)) throw new Error(`Duplicate timing for scene '${entry.scene_id}'`);
    if (!Number.isFinite(entry.duration_seconds) || entry.duration_seconds <= 0) throw new Error(`Timing for '${entry.scene_id}' must be positive and finite`);
    override.set(entry.scene_id, entry.duration_seconds);
  }
  if (override.size > 0 && override.size !== scenes.length) throw new Error("Timing overrides must provide every scene exactly once; partial maps are not allowed");
  for (const scene of scenes) {
    if (scene.lock_duration && override.has(scene.scene_id) && Math.abs(override.get(scene.scene_id) - scene.duration_seconds) > tolerance) throw new Error(`Timing for locked scene '${scene.scene_id}' conflicts with its plan duration`);
  }
  const freeze = Number(config.assembly.freezeFrameSeconds ?? 0);
  if (!Number.isFinite(freeze) || freeze < 0) throw new Error("freezeFrameSeconds must be finite and non-negative");
  const audioDuration = config.audio ? await mediaDuration(config.audio, process) : null;
  const completeOverrides = override.size === scenes.length;
  const natural = scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0);
  const locked = scenes.filter((scene) => scene.lock_duration).reduce((sum, scene) => sum + scene.duration_seconds, 0);
  const unlockedNatural = scenes.filter((scene) => !scene.lock_duration).reduce((sum, scene) => sum + scene.duration_seconds, 0);
  let scale = 1;
  let durations;
  if (completeOverrides) {
    durations = scenes.map((scene) => override.get(scene.scene_id));
    const total = durations.reduce((sum, value) => sum + value, 0) + freeze;
    if (audioDuration !== null && Math.abs(total - audioDuration) > tolerance) throw new Error(`Complete timing overrides total ${total.toFixed(3)}s but audio is ${audioDuration.toFixed(3)}s including freeze`);
  } else if (audioDuration !== null) {
    const available = audioDuration - freeze - locked;
    if (available < -tolerance) throw new Error("Audio is too short for locked scenes and the final freeze");
    if (unlockedNatural === 0) {
      if (Math.abs(available) > tolerance) throw new Error("All scenes are locked but their durations and freeze do not match the audio");
      scale = 1;
    } else {
      if (available <= 0) throw new Error("Audio leaves no positive duration for unlocked scenes");
      scale = available / unlockedNatural;
    }
    durations = scenes.map((scene) => scene.lock_duration ? scene.duration_seconds : scene.duration_seconds * scale);
  } else {
    durations = scenes.map((scene) => scene.duration_seconds);
  }
  let cursor = 0;
  const timelineScenes = scenes.map((scene, index) => {
    const duration = durations[index];
    const item = { scene_id: scene.scene_id, source_duration_seconds: scene.duration_seconds, locked_duration: Boolean(scene.lock_duration), start_seconds: Number(cursor.toFixed(6)), duration_seconds: Number(duration.toFixed(6)), end_seconds: Number((cursor + duration).toFixed(6)) };
    cursor += duration;
    return item;
  });
  const freezeItem = { source_scene_id: scenes.at(-1).scene_id, start_seconds: Number(cursor.toFixed(6)), duration_seconds: freeze, end_seconds: Number((cursor + freeze).toFixed(6)) };
  return { source: completeOverrides ? "timings" : audioDuration !== null ? "audio-proportional" : "plan", audio_duration_seconds: audioDuration, natural_scene_duration_seconds: natural, locked_scene_duration_seconds: locked, duration_scale: Number(scale.toFixed(8)), scenes: timelineScenes, freeze: freezeItem, total_duration_seconds: freezeItem.end_seconds, warnings: scale < 0.75 || scale > 1.35 ? [`Large scene retiming requested (${scale.toFixed(2)}x)`] : [] };
}

async function normalizeClip(input, output, targetDuration, config, process) {
  const sourceDuration = await mediaDuration(input, process);
  if (![sourceDuration, targetDuration].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Clip durations must be positive finite numbers");
  const speed = targetDuration / sourceDuration;
  const tolerancePadding = 1 / config.assembly.fps;
  const filter = [
    `scale=${config.assembly.width}:${config.assembly.height}:force_original_aspect_ratio=decrease`,
    `pad=${config.assembly.width}:${config.assembly.height}:(ow-iw)/2:(oh-ih)/2:black`,
    `setpts=${speed.toFixed(10)}*PTS`, `fps=${config.assembly.fps}`,
    `tpad=stop_mode=clone:stop_duration=${tolerancePadding.toFixed(6)}`,
    `trim=duration=${targetDuration.toFixed(6)}`, "setpts=PTS-STARTPTS",
    "setsar=1", "format=yuv420p",
  ].join(",");
  await process("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-map", "0:v:0", "-an", "-vf", filter, "-c:v", config.assembly.codec, "-crf", String(config.assembly.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", output], { capture: true });
}

async function freezeClip(source, output, duration, config, process) {
  await process("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-sseof", `-${(1 / config.assembly.fps).toFixed(6)}`, "-i", source, "-map", "0:v:0", "-an", "-vf", `select='eq(n,0)',setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${duration.toFixed(6)},trim=duration=${duration.toFixed(6)},fps=${config.assembly.fps},format=yuv420p`, "-c:v", config.assembly.codec, "-crf", String(config.assembly.crf), "-pix_fmt", "yuv420p", output], { capture: true });
}

function concatLine(file) { return `file '${file.replaceAll("'", "'\\''")}'`; }

function jsonFiles(directory, name) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(child, name) : entry.name === name ? [child] : [];
  });
}

function historicalCosts(config, plan, provider) {
  const records = [];
  for (const scene of plan.allScenes ?? plan.scenes) {
    const paths = scenePaths(config, plan, scene, provider);
    for (const file of jsonFiles(paths.image, "generation.json")) records.push(readJson(file, null));
    for (const file of jsonFiles(paths.image, "qa.json")) records.push(readJson(file, null));
    for (const resultFile of jsonFiles(paths.video, "result.json")) {
      const result = readJson(resultFile, null);
      const request = readJson(path.join(path.dirname(resultFile), "request.json"), null);
      records.push(Number.isFinite(result?.costUsd) ? result : request);
    }
    for (const requestFile of jsonFiles(paths.video, "request.json")) {
      if (!fs.existsSync(path.join(path.dirname(requestFile), "result.json"))) records.push(readJson(requestFile, null));
    }
    for (const file of jsonFiles(paths.video, "qa.json")) records.push(readJson(file, null));
  }
  return summarizeCosts(records);
}

export async function assemble({ config, plan, timings = null, provider = config.providers.video, videoProvider = null, process = runProcess, clock = () => new Date() }) {
  const scenes = plan.allScenes ?? plan.scenes;
  const finalVideo = finalArtifactPath(config.outputs, provider, config.metadata.slug);
  const finalDirectory = path.dirname(finalVideo);
  const work = path.join(finalDirectory, "work");
  ensureDir(work);
  const timeline = await buildTimeline(config, { ...plan, allScenes: scenes }, { timings, process });
  await writeJsonAtomic(path.join(finalDirectory, "timeline.json"), timeline);
  const normalized = [];
  const sources = [];
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    const paths = scenePaths(config, { ...plan, allScenes: scenes }, scene, provider);
    const selection = readJson(paths.videoSelection, null);
    const imageSelection = readJson(paths.imageSelection, null);
    const imageExpected = imageFingerprints(config, plan, scene, { epoch: imageSelection?.generationEpoch ?? 0 });
    if (!validArtifact(paths.selectedImage, imageSelection, { generationFingerprint: imageExpected.generation, qaFingerprint: imageExpected.qa })) throw new Error(`${scene.scene_id}: selected source still is missing, stale, or corrupt`);
    const targetDuration = timeline.scenes[index].duration_seconds;
    const requestedDuration = Number(selection?.requestedDuration);
    const targetMetadata = Number(selection?.targetDuration);
    if (![targetDuration, requestedDuration, targetMetadata].every((value) => Number.isFinite(value) && value > 0)) throw new Error(`${scene.scene_id}: selected clip has missing or non-finite duration metadata`);
    if (Math.abs(targetMetadata - targetDuration) > 1e-6) throw new Error(`${scene.scene_id}: selected clip is timing-incompatible`);
    const model = provider === "gemini" ? config.models.geminiVideo : config.models.video;
    const durationProvider = videoProvider ?? videoProviderContract(provider);
    if (requestedVideoDuration(durationProvider, config.generation.videoResolution ?? "720p", targetDuration) !== requestedDuration) throw new Error(`${scene.scene_id}: selected clip requested duration is stale`);
    const expected = videoFingerprints({ config, plan, scene, providerName: provider, imageSelection, targetDuration, requestedDuration, model, audioControl: durationProvider.supportsAudioControl(), epoch: selection?.generationEpoch ?? 0 });
    if (!validArtifact(paths.selectedVideo, selection, { generationFingerprint: expected.generation, qaFingerprint: expected.qa }) || selection.technicalPassed !== true || selection.sourceImageSha256 !== imageSelection.sha256) throw new Error(`${scene.scene_id}: selected clip is missing, stale, corrupt, configuration-incompatible, or failed technical QA`);
    const output = path.join(work, `${String(index + 1).padStart(3, "0")}.mp4`);
    await normalizeClip(paths.selectedVideo, output, timeline.scenes[index].duration_seconds, config, process);
    normalized.push(output);
    sources.push({ scene_id: scene.scene_id, stillSha256: imageSelection.sha256, clipSha256: selection.sha256, generationFingerprint: selection.generationFingerprint, qaFingerprint: selection.qaFingerprint });
  }
  if (timeline.freeze.duration_seconds > 0) {
    const output = path.join(work, "freeze.mp4");
    await freezeClip(normalized.at(-1), output, timeline.freeze.duration_seconds, config, process);
    normalized.push(output);
  }
  const list = path.join(work, "concat.txt");
  fs.writeFileSync(list, `${normalized.map(concatLine).join("\n")}\n`);
  const silent = path.join(work, "silent.mp4");
  await process("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-map", "0:v:0", "-an", "-c", "copy", "-movflags", "+faststart", silent], { capture: true });
  if (config.audio) {
    await process("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", silent, "-i", config.audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", config.assembly.audioBitrate, "-t", timeline.total_duration_seconds.toFixed(6), "-movflags", "+faststart", finalVideo], { capture: true });
  } else fs.copyFileSync(silent, finalVideo);
  if (!existsNonEmpty(finalVideo)) throw new Error("FFmpeg did not create the final video");
  const poster = path.join(finalDirectory, "poster.jpg");
  await process("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", finalVideo, "-frames:v", "1", poster], { capture: true });
  const costs = historicalCosts(config, plan, provider);
  const report = { status: "complete", createdAt: clock().toISOString(), provider, providers: { image: config.providers.image, judge: config.providers.judge, video: provider }, models: { image: config.models.image, judge: config.models.judge, video: provider === "gemini" ? config.models.geminiVideo : config.models.video }, sceneCount: scenes.length, silent: !config.audio, output: path.basename(finalVideo), outputBytes: fs.statSync(finalVideo).size, sha256: sha256(finalVideo), posterSha256: sha256(poster), sources, timeline: "timeline.json", costs: { knownUsd: costs.knownUsd, hasUnknownCosts: costs.unknown, note: costs.unknown ? "Known total excludes one or more unreported provider costs." : "All recorded provider costs were reported." } };
  await writeJsonAtomic(path.join(finalDirectory, "report.json"), report);
  return report;
}
