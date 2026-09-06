import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assemble, buildTimeline } from "../src/assembly.mjs";
import { runProcess } from "../src/io.mjs";
import { scenePaths, writeSelection } from "../src/artifacts.mjs";

async function synthetic(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assembly-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scenes = ["red", "blue"].map((id) => ({ scene_id: id, section: "verse", lyrics: "", duration_seconds: .75, lock_duration: false, characters: ["p"], image_generation: { prompt: "x", negative_prompt: "x", aspect_ratio: "16:9" }, video_generation: { scene_description: "x", prompt: "x", camera: "x", motion: "x", ending_frame: "x" } }));
  const config = { metadata: { slug: "assembly-film" }, outputs: path.join(root, "assembly-film"), providers: { video: "xai" }, assembly: { width: 64, height: 48, fps: 10, codec: "libx264", crf: 30, audioBitrate: "64k", freezeFrameSeconds: .5 }, audio: path.join(root, "audio.wav") };
  const plan = { scenes, allScenes: scenes };
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", config.audio], { capture: true });
  for (const scene of scenes) {
    const paths = scenePaths(config, plan, scene, "xai");
    fs.mkdirSync(paths.video, { recursive: true });
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${scene.scene_id}:s=64x48:r=10:d=0.6`, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", paths.selectedVideo], { capture: true });
    const image = path.join(paths.image, "selected.jpg");
    fs.mkdirSync(paths.image, { recursive: true }); fs.writeFileSync(image, `still-${scene.scene_id}`);
    const imageSelection = await writeSelection(paths.imageSelection, image, { status: "selected", generationFingerprint: `ig-${scene.scene_id}`, qaFingerprint: "iq" });
    await writeSelection(paths.videoSelection, paths.selectedVideo, { status: "selected", sceneId: scene.scene_id, generationFingerprint: `g-${scene.scene_id}`, qaFingerprint: "q", sourceImageSha256: imageSelection.sha256, targetDuration: .75, technicalPassed: true });
  }
  return { root, config, plan };
}

test("timeline uses all scenes identically for filtered work and supports zero freeze", async (t) => {
  const { config, plan } = await synthetic(t);
  const full = await buildTimeline(config, plan);
  const filtered = await buildTimeline(config, { scenes: [plan.scenes[0]], allScenes: plan.allScenes });
  assert.deepEqual(filtered.scenes, full.scenes);
  config.assembly.freezeFrameSeconds = 0;
  const zero = await buildTimeline(config, plan);
  assert.equal(zero.freeze.duration_seconds, 0);
  assert.equal(zero.total_duration_seconds, 2);
});

test("timeline rejects partial, duplicate, unknown, lock conflicts, and inconsistent complete maps", async (t) => {
  const { config, plan } = await synthetic(t);
  await assert.rejects(buildTimeline(config, plan, { timings: { timings: [{ scene_id: "red", duration_seconds: 1 }] } }), /every scene/);
  await assert.rejects(buildTimeline(config, plan, { timings: { timings: [{ scene_id: "red", duration_seconds: .75 }, { scene_id: "red", duration_seconds: .75 }] } }), /Duplicate/);
  await assert.rejects(buildTimeline(config, plan, { timings: { timings: [{ scene_id: "red", duration_seconds: .75 }, { scene_id: "unknown", duration_seconds: .75 }] } }), /unknown/);
  plan.scenes[0].lock_duration = true;
  await assert.rejects(buildTimeline(config, plan, { timings: { timings: [{ scene_id: "red", duration_seconds: .9 }, { scene_id: "blue", duration_seconds: .6 }] } }), /locked/);
  plan.scenes[0].lock_duration = false;
  await assert.rejects(buildTimeline(config, plan, { timings: { timings: [{ scene_id: "red", duration_seconds: .5 }, { scene_id: "blue", duration_seconds: .5 }] } }), /but audio/);
});

test("assembly pads short clips, strips model audio, adds sole song, freeze and report", async (t) => {
  const { config, plan } = await synthetic(t);
  const report = await assemble({ config, plan });
  assert.equal(report.status, "complete");
  assert.deepEqual(report.sources.map((item) => item.scene_id), ["red", "blue"]);
  const final = path.join(config.outputs, "final-xai", "assembly-film.mp4");
  const { stdout } = await runProcess("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", final], { capture: true });
  const probe = JSON.parse(stdout);
  assert.deepEqual(probe.streams.map((stream) => stream.codec_type).sort(), ["audio", "video"]);
  assert.ok(Math.abs(Number(probe.format.duration) - 2) < .15);
  assert.equal(report.sha256.length, 64);
});
