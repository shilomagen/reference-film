import fs from "node:fs";
import path from "node:path";
import { existsNonEmpty, objectHash, readJson, sceneDirectory, sha256, writeJsonAtomic } from "./io.mjs";

export function scenePaths(config, plan, scene, provider = config.providers.video) {
  const root = sceneDirectory(config.outputs, plan.allScenes, scene);
  return {
    root,
    scene: path.join(root, "scene.json"),
    image: path.join(root, "image"),
    selectedImage: path.join(root, "image", "selected.jpg"),
    imageSelection: path.join(root, "image", "selection.json"),
    video: path.join(root, `video-${provider}`),
    selectedVideo: path.join(root, `video-${provider}`, "selected.mp4"),
    videoSelection: path.join(root, `video-${provider}`, "selection.json"),
  };
}

export function hashesFor(paths) {
  return paths.map((file) => ({ file: path.basename(file), sha256: sha256(file) }));
}

export function validArtifact(filePath, metadata, { generationFingerprint, qaFingerprint, acceptedStatuses = ["selected"] } = {}) {
  if (!existsNonEmpty(filePath) || !metadata || !acceptedStatuses.includes(metadata.status)) return false;
  if (!/^[a-f0-9]{64}$/.test(metadata.sha256 ?? "") || sha256(filePath) !== metadata.sha256) return false;
  if (generationFingerprint !== undefined && metadata.generationFingerprint !== generationFingerprint) return false;
  if (qaFingerprint !== undefined && metadata.qaFingerprint !== qaFingerprint) return false;
  return true;
}

export async function invalidateSelection(metadataPath, reason, extra = {}) {
  const prior = readJson(metadataPath, null);
  await writeJsonAtomic(metadataPath, {
    ...(prior ?? {}), ...extra, status: "stale", reason,
    invalidatedAt: new Date().toISOString(),
  });
}

export async function writeSelection(metadataPath, filePath, value) {
  if (!existsNonEmpty(filePath)) throw new Error(`Cannot select missing or empty artifact: ${filePath}`);
  const metadata = { ...value, sha256: sha256(filePath) };
  await writeJsonAtomic(metadataPath, metadata);
  return metadata;
}

export function generationFingerprint(value) { return objectHash({ version: 1, ...value }); }
export function qualityFingerprint(value) { return objectHash({ version: 1, ...value }); }

export function summarizeCosts(items) {
  let knownUsd = 0;
  let unknown = false;
  for (const item of items.flat(Infinity).filter(Boolean)) {
    if (Number.isFinite(item.costUsd)) knownUsd += item.costUsd;
    else if (item.costUnknown || item.costUsd === null) unknown = true;
  }
  return { knownUsd: Number(knownUsd.toFixed(6)), unknown };
}

export function approvalPath(outputs) { return path.join(outputs, "rights-approval.json"); }

export function sourceHashes(config, plan) {
  const references = Object.fromEntries(Object.entries(config.inputs.faces).map(([name, files]) => [name, files.map((file) => sha256(file))]));
  const directPhotos = Object.fromEntries(plan.allScenes.filter((scene) => scene.source_image).map((scene) => [scene.scene_id, sha256(scene.source_image)]));
  return { references, directPhotos, audio: config.audio ? sha256(config.audio) : null };
}

export function rightsFingerprint(config, plan) { return objectHash(sourceHashes(config, plan)); }

export function hasRightsApproval(config, plan) {
  const approval = readJson(approvalPath(config.outputs), null);
  return Boolean(approval?.acknowledged === true && approval.sourceFingerprint === rightsFingerprint(config, plan));
}

export async function writeRightsApproval(config, plan, { clock = () => new Date() } = {}) {
  const value = { version: 1, acknowledged: true, approvedAt: clock().toISOString(), sourceFingerprint: rightsFingerprint(config, plan), sourceHashes: sourceHashes(config, plan) };
  await writeJsonAtomic(approvalPath(config.outputs), value);
  return value;
}
