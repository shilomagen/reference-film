import fs from "node:fs";
import path from "node:path";
import { executableAvailable, readJson, sha256, writeJsonAtomic } from "./io.mjs";
import { createProviderRegistry, finalArtifactPath } from "./providers/index.mjs";
import { createPaidOperationJournal } from "./providers/journal.mjs";
import { assemble, buildTimeline } from "./assembly.mjs";
import { buildImagePrompt, buildVideoPrompt } from "./prompts.mjs";
import { generateImages, generateVideos } from "./generation.mjs";
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
  const registry = dependencies.registry ?? createProviderRegistry(registryConfig(config), { ...dependencies, journal: undefined });
  return { registry, journal };
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

export function mediaStatus({ config, plan, provider = config.providers.video }) {
  const scenes = plan.allScenes.map((scene) => {
    const paths = scenePaths(config, plan, scene, provider);
    const image = readJson(paths.imageSelection, null);
    const video = readJson(paths.videoSelection, null);
    return { scene_id: scene.scene_id, image: image?.status ?? "missing", imageChecksumValid: validArtifact(paths.selectedImage, image), video: video?.status ?? "missing", videoChecksumValid: validArtifact(paths.selectedVideo, video), provider };
  });
  const final = finalArtifactPath(config.outputs, provider, config.metadata.slug);
  return { project: config.metadata.slug, rightsApproved: hasRightsApproval(config, plan), provider, scenes, final: fs.existsSync(final) ? { status: "present", bytes: fs.statSync(final).size, sha256: sha256(final) } : { status: "missing" } };
}

export async function validateMedia({ config, plan, timings = null, process }) {
  const timeline = await buildTimeline(config, plan, { timings, process });
  const ffmpeg = process ? true : await executableAvailable("ffmpeg");
  const ffprobe = process ? true : await executableAvailable("ffprobe");
  if (!ffmpeg || !ffprobe) throw new Error("FFmpeg and ffprobe are required");
  return { status: "ok", offline: true, scenes: plan.allScenes.length, timeline, tools: { ffmpeg, ffprobe }, rightsApproved: hasRightsApproval(config, plan) };
}

export async function dryRunMedia({ config, plan, timings = null, process }) {
  const timeline = await buildTimeline(config, plan, { timings, process });
  return { dryRun: true, networkCalls: 0, paidRequests: 0, project: config.metadata, providers: config.providers, outputs: config.outputs, estimate: { imageRequestsUpperBound: plan.scenes.filter((scene) => scene.source_image_mode !== "direct_animation").length * config.generation.imageRounds, judgeRequestsUpperBound: config.quality.judgeEnabled ? plan.scenes.filter((scene) => scene.source_image_mode !== "direct_animation").length * config.generation.imageRounds + plan.scenes.length * config.generation.videoAttempts : 0, videoRequestsUpperBound: plan.scenes.length * config.generation.videoAttempts, priceUsd: null, priceUnknown: true }, timeline, scenes: plan.scenes.map((scene) => ({ scene_id: scene.scene_id, imagePrompt: buildImagePrompt({ scene, config, plan }), videoPrompt: buildVideoPrompt({ scene, config, plan }), paths: scenePaths(config, plan, scene) })) };
}

export async function runMedia({ command, config, plan, timings = null, yes = false, registry = null, journal = null, fetch, sleep, random, clock, clockMs, logger, testOrigins, trustedOrigins, process, download } = {}) {
  if (!config || !plan) throw new Error("runMedia requires config and plan");
  if (command === "status") return mediaStatus({ config, plan });
  if (command === "validate") return validateMedia({ config, plan, timings, process });
  if (command === "dry-run" || config.dryRun) return dryRunMedia({ config, plan, timings, process });
  if (command === "assemble") return assemble({ config, plan, timings, process, clock });
  if (!["images", "videos", "run"].includes(command)) throw new Error(`Unsupported media command '${command}'`);
  requireSpend(yes);
  requireRights(config, plan);
  const dependencies = { registry, journal, fetch, sleep, random, clock, logger, testOrigins, trustedOrigins };
  const runtime = makeRuntime(config, dependencies);
  if (command === "images") return generateImages({ registry: runtime.registry, journal: runtime.journal, config, plan, yes, clock, process, download });
  if (command === "videos") return generateVideos({ registry: runtime.registry, journal: runtime.journal, config, plan, yes, clock, clockMs, sleep, process });
  const images = await generateImages({ registry: runtime.registry, journal: runtime.journal, config, plan, yes, clock, process, download });
  if (images.some((item) => item.status !== "selected")) return { status: "needs_review", stage: "images", images };
  const videos = await generateVideos({ registry: runtime.registry, journal: runtime.journal, config, plan, yes, clock, clockMs, sleep, process });
  if (videos.some((item) => item.status !== "selected")) return { status: "needs_review", stage: "videos", images, videos };
  const final = await assemble({ config, plan, timings, process, clock });
  return { status: "complete", images, videos, final };
}
