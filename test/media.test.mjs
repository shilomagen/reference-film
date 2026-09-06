import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { approveArtifact, approveMedia, dryRunMedia, runMedia } from "../src/media.mjs";
import { scenePaths, writeSelection } from "../src/artifacts.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-engine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const face = path.join(root, "face.png");
  const audio = path.join(root, "song.wav");
  fs.writeFileSync(face, "face"); fs.writeFileSync(audio, "audio");
  const scene = { scene_id: "one", section: "verse", lyrics: "", duration_seconds: 2.5, lock_duration: false, characters: ["person"], image_generation: { prompt: "portrait", negative_prompt: "text", aspect_ratio: "16:9" }, video_generation: { scene_description: "blink", prompt: "blink", camera: "locked", motion: "blink", ending_frame: "portrait" } };
  const config = { metadata: { slug: "test-film", title: "Test" }, visualStyle: "natural", characters: { person: { description: "fictional person" } }, inputs: { faces: { person: [face] } }, outputs: path.join(root, "test-film"), providers: { image: "xai", judge: "xai", video: "xai", text: "xai" }, models: { image: "i", judge: "j", video: "v", geminiVideo: "g", text: "t" }, generation: { imageCandidates: 1, imageRounds: 1, videoAttempts: 1, concurrency: 1, pollTimeoutMs: 1000, pollIntervalMs: 1 }, quality: { judgeEnabled: false, imageIdentityMinimum: 70, imageAnatomyMinimum: 60, imageCharactersMinimum: 65, videoIdentityMinimum: 68, videoStabilityMinimum: 65, rubric: { identity: .45, correct_characters: .15, scene_readability: .12, anatomy: .12, cinematic_style: .1, creative_intent: .06 } }, assembly: { width: 32, height: 32, fps: 10, codec: "libx264", crf: 30, audioBitrate: "64k", freezeFrameSeconds: 0 }, audio };
  return { root, config, scene, plan: { scenes: [scene], allScenes: [scene], title: "Test" } };
}

test("rights approval is hash-bound and --yes is spend only", async (t) => {
  const { config, plan } = fixture(t);
  let paid = 0;
  const registry = { selected: { video: "xai" }, models: { video: "v" }, image: { async generateCandidates() { paid++; return { images: [{ data: Buffer.from("image").toString("base64") }], costUsd: null }; } }, judge: {}, video: {} };
  await assert.rejects(runMedia({ command: "images", config, plan, yes: true, registry }), /rights/);
  await approveMedia({ config, plan, acknowledgeRights: true });
  await assert.rejects(runMedia({ command: "images", config, plan, yes: false, registry }), /yes: true/);
  assert.equal(paid, 0);
  fs.writeFileSync(config.inputs.faces.person[0], "changed");
  await assert.rejects(runMedia({ command: "images", config, plan, yes: true, registry }), /rights/);
  assert.equal(paid, 0);
});

test("dry-run estimates unknown prices and never calls providers", async (t) => {
  const { config, plan } = fixture(t);
  const result = await dryRunMedia({ config, plan, process: async () => ({ stdout: "2.5\n" }) });
  assert.equal(result.networkCalls, 0);
  assert.equal(result.estimate.priceUnknown, true);
  assert.equal(result.estimate.imageRequestsUpperBound, 1);
});

test("manual approval binds checksum and cannot override video technical failure", async (t) => {
  const { config, plan, scene } = fixture(t);
  const paths = scenePaths(config, plan, scene);
  const imageCandidate = path.join(paths.image, "round_01", "candidate_01.jpg");
  fs.mkdirSync(path.dirname(imageCandidate), { recursive: true }); fs.writeFileSync(imageCandidate, "candidate");
  const checksum = (await import("../src/io.mjs")).sha256(imageCandidate);
  await writeSelection(paths.imageSelection, imageCandidate, { status: "needs_review", candidate: { path: path.relative(paths.root, imageCandidate), sha256: checksum }, generationFingerprint: "g", qaFingerprint: "q" });
  const approved = await approveArtifact({ config, plan, sceneId: scene.scene_id, stage: "image", checksum });
  assert.equal(approved.status, "selected");
  assert.equal(approved.sha256, checksum);

  const clip = path.join(paths.video, "attempt_01", "clip.mp4");
  fs.mkdirSync(path.dirname(clip), { recursive: true }); fs.writeFileSync(clip, "clip");
  const clipChecksum = (await import("../src/io.mjs")).sha256(clip);
  await writeSelection(paths.videoSelection, clip, { status: "needs_review", candidate: { path: path.relative(paths.root, clip), sha256: clipChecksum, technicalPassed: false } });
  await assert.rejects(approveArtifact({ config, plan, sceneId: scene.scene_id, stage: "video", checksum: clipChecksum }), /technical QA/);
});
