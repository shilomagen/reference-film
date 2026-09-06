import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateImages, generateVideos, imageFingerprints } from "../src/generation.mjs";
import { approveMedia } from "../src/media.mjs";
import { scenePaths, writeSelection } from "../src/artifacts.mjs";
import { runProcess } from "../src/io.mjs";

function fixture(t, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generation-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const face = path.join(root, "face.png"); fs.writeFileSync(face, Buffer.from([0x89,0x50,0x4e,0x47]));
  const scenes = Array.from({ length: count }, (_, i) => ({ scene_id: `scene_${i + 1}`, section: "verse", lyrics: "", duration_seconds: 1, lock_duration: false, characters: ["p"], image_generation: { prompt: `portrait ${i}`, negative_prompt: "text", aspect_ratio: "16:9" }, video_generation: { scene_description: "blink", prompt: "blink", camera: "locked", motion: "blink", ending_frame: "still" } }));
  const config = { metadata: { slug: "gen-film" }, visualStyle: "natural", characters: { p: { description: "fictional person" } }, inputs: { faces: { p: [face] } }, outputs: path.join(root, "gen-film"), providers: { image: "xai", judge: "xai", video: "xai" }, models: { image: "i", judge: "j", video: "v" }, generation: { imageCandidates: 1, imageRounds: 1, videoAttempts: 1, concurrency: 2, pollTimeoutMs: 10, pollIntervalMs: 1, videoResolution: "720p" }, quality: { judgeEnabled: true, imageIdentityMinimum: 70, imageAnatomyMinimum: 60, imageCharactersMinimum: 65, videoIdentityMinimum: 68, videoStabilityMinimum: 65, rubric: { identity: .45, correct_characters: .15, scene_readability: .12, anatomy: .12, cinematic_style: .1, creative_intent: .06 } }, assembly: { width: 64, height: 48, fps: 10, codec: "libx264", crf: 30, audioBitrate: "64k", freezeFrameSeconds: 0 }, audio: null };
  return { root, config, plan: { scenes, allScenes: scenes }, scenes };
}
function imageJudge() { return { json: { candidates: [{ candidate: 1, identity_scores: { p: 90 }, correct_characters: 90, scene_readability: 90, anatomy: 90, cinematic_style: 90, creative_intent: 90, rejected: false, rejection_reasons: [], notes: "ok" }] }, costUsd: .1 }; }

test("generation separates generation/QA cache and drains scene queue", async (t) => {
  const { config, plan } = fixture(t, 2);
  let generated = 0; let judged = 0;
  const registry = { image: { async generateCandidates({ prompt }) { generated++; if (prompt.includes("portrait 0")) throw new Error("scene failure"); return { images: [{ data: Buffer.from("jpeg").toString("base64") }], costUsd: 1 }; } }, judge: { async judgeImages() { judged++; return imageJudge(); } } };
  await assert.rejects(generateImages({ registry, config, plan, yes: true }), AggregateError);
  assert.equal(generated, 2);
  assert.equal(judged, 1);
  const second = scenePaths(config, plan, plan.scenes[1]);
  assert.equal(fs.existsSync(second.selectedImage), true);
});

test("image generation cache survives QA policy change without repaying generation", async (t) => {
  const { config, plan } = fixture(t);
  let generated = 0; let judged = 0;
  const registry = { image: { async generateCandidates() { generated++; return { images: [{ data: Buffer.from("jpeg").toString("base64") }], costUsd: null }; } }, judge: { async judgeImages() { judged++; return imageJudge(); } } };
  await generateImages({ registry, config, plan, yes: true });
  config.quality.imageIdentityMinimum = 71;
  await generateImages({ registry, config, plan, yes: true });
  assert.equal(generated, 1);
  assert.equal(judged, 2);
});

test("video persists operation before polling and resumes it after interruption", async (t) => {
  const { root, config, plan, scenes } = fixture(t);
  const paths = scenePaths(config, plan, scenes[0]);
  fs.mkdirSync(paths.image, { recursive: true }); fs.writeFileSync(paths.selectedImage, "still");
  const fingerprints = imageFingerprints(config, plan, scenes[0]);
  await writeSelection(paths.imageSelection, paths.selectedImage, { status: "selected", generationFingerprint: fingerprints.generation, qaFingerprint: fingerprints.qa });
  const generatedClip = path.join(root, "provider.mp4");
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x48:r=10:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", generatedClip], { capture: true });
  let starts = 0; let polls = 0;
  const video = { supportedDurations: () => [1], supportsAudioControl: () => true, async startVideo() { starts++; return { operationId: "op-1", costUsd: null }; }, async getVideo() { polls++; if (polls === 1) throw new Error("temporary GET failure"); return { status: "done", video: { url: "https://temporary.invalid/signed" }, costUsd: 2 }; }, async downloadVideo(_url, target) { fs.copyFileSync(generatedClip, target); } };
  const judge = { async judgeImages() { return { json: { identity_scores: { p: 90 }, face_stability: 90, anatomy: 90, continuity: 90, action_readability: 90, cinematic_quality: 90, rejected: false, rejection_reasons: [], notes: "ok" }, costUsd: .2 }; } };
  const registry = { selected: { video: "xai" }, models: { video: "v" }, video, judge };
  await assert.rejects(generateVideos({ registry, config, plan, yes: true }), /temporary GET/);
  assert.equal(starts, 1);
  const request = JSON.parse(fs.readFileSync(path.join(paths.video, "attempt_01", "request.json")));
  assert.equal(request.operationId, "op-1");
  await generateVideos({ registry, config, plan, yes: true });
  assert.equal(starts, 1);
  assert.equal(polls, 2);
});
