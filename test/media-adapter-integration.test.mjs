import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPaidOperationJournal } from "../src/providers/journal.mjs";
import { createProviderRegistry } from "../src/providers/index.mjs";
import { generateVideos, imageFingerprints } from "../src/generation.mjs";
import { approveArtifact, approveMedia, runMedia } from "../src/media.mjs";
import { scenePaths, writeSelection } from "../src/artifacts.mjs";
import { runProcess } from "../src/io.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const face = path.join(root, "face.jpg"); fs.writeFileSync(face, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const scene = { scene_id: "one", section: "verse", lyrics: "", duration_seconds: 1, lock_duration: false, characters: ["p"], image_generation: { prompt: "same prompt", negative_prompt: "none", aspect_ratio: "16:9" }, video_generation: { scene_description: "blink", prompt: "blink", camera: "locked", motion: "small", ending_frame: "still" } };
  const config = { apiKey: "test-key", apiBaseUrl: "http://127.0.0.1:9876/v1", metadata: { slug: "adapter-film" }, visualStyle: "natural", characters: { p: { description: "person" } }, inputs: { faces: { p: [face] } }, outputs: path.join(root, "adapter-film"), providers: { text: "xai", image: "xai", judge: "xai", video: "xai" }, models: { text: "text-model", image: "image-model", judge: "judge-model", video: "video-model", geminiVideo: "gemini-model" }, generation: { imageCandidates: 1, imageRounds: 2, videoAttempts: 1, concurrency: 1, pollTimeoutMs: 20, pollIntervalMs: 1, videoResolution: "720p" }, quality: { judgeEnabled: true, imageIdentityMinimum: 70, imageAnatomyMinimum: 60, imageCharactersMinimum: 65, videoIdentityMinimum: 68, videoStabilityMinimum: 65, rubric: { identity: .45, correct_characters: .15, scene_readability: .12, anatomy: .12, cinematic_style: .1, creative_intent: .06 } }, assembly: { width: 64, height: 48, fps: 10, codec: "libx264", crf: 30, audioBitrate: "64k", freezeFrameSeconds: 0 }, audio: null, allowSilent: true, force: false };
  return { root, config, scene, plan: { scenes: [scene], allScenes: [scene] } };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function failingJudgeResponse() {
  return { choices: [{ message: { content: JSON.stringify({ candidates: [{ candidate: 1, identity_scores: { p: 10 }, correct_characters: 10, scene_readability: 10, anatomy: 10, cinematic_style: 10, creative_intent: 10, rejected: true, rejection_reasons: ["bad"], notes: "bad" }] }) } }], usage: { cost_usd: .1 } };
}

test("production xAI adapters and durable journal separate rounds, resume, and force epochs", async (t) => {
  const { config, plan } = fixture(t);
  await approveMedia({ config, plan, acknowledgeRights: true });
  const bodies = []; let imagePosts = 0; let judgePosts = 0;
  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    if (body) bodies.push(body);
    if (pathname.endsWith("/images/edits")) { imagePosts++; return jsonResponse({ data: [{ b64_json: Buffer.from("jpeg").toString("base64") }], request_id: `image-${imagePosts}`, usage: { cost_usd: .5 } }); }
    if (pathname.endsWith("/chat/completions")) { judgePosts++; return jsonResponse(failingJudgeResponse()); }
    throw new Error(`unexpected request ${pathname}`);
  };
  const args = { command: "images", config, plan, yes: true, fetch, testOrigins: ["http://127.0.0.1:9876"] };
  await assert.rejects(runMedia(args), /no image candidate passed/);
  assert.deepEqual([imagePosts, judgePosts], [2, 2], "identical request bodies in deliberate rounds must both submit");
  await assert.rejects(runMedia(args), /no image candidate passed/);
  assert.deepEqual([imagePosts, judgePosts], [2, 2], "resuming the same rounds must use local durable results");
  config.force = true;
  await assert.rejects(runMedia(args), /no image candidate passed/);
  assert.deepEqual([imagePosts, judgePosts], [4, 4], "force advances the durable generation epoch");
  assert.equal(bodies.some((body) => Object.hasOwn(body, "operationKey") || Object.hasOwn(body, "workKey")), false, "operation identity must not enter HTTP bodies");
  assert.equal(fs.existsSync(path.join(config.outputs, "generation-epochs.json")), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.outputs, "media-run.json"))).status, "failed");
  await assert.rejects(runMedia(args), /no image candidate passed/);
  assert.deepEqual([imagePosts, judgePosts], [6, 6], "a fresh completed force invocation advances the epoch again");
});

test("force cannot bypass an uncertain adapter journal submission", async (t) => {
  const { config, plan } = fixture(t);
  config.quality.judgeEnabled = false; config.generation.imageRounds = 1;
  await approveMedia({ config, plan, acknowledgeRights: true });
  let posts = 0;
  const fetch = async () => { posts++; throw new TypeError("ambiguous network loss"); };
  const args = { command: "images", config, plan, yes: true, fetch, testOrigins: ["http://127.0.0.1:9876"] };
  await assert.rejects(runMedia(args), /outcome is uncertain/);
  config.force = true;
  await assert.rejects(runMedia(args), /will not be submitted automatically/);
  assert.equal(posts, 1);
});

test("no-judge production chain reaches checksum approvals and assembly", async (t) => {
  const { root, config, plan, scene } = fixture(t);
  config.quality.judgeEnabled = false; config.generation.imageRounds = 1;
  await approveMedia({ config, plan, acknowledgeRights: true });
  const clip = path.join(root, "chain.mp4");
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=64x48:r=10:d=1", "-f", "lavfi", "-i", "sine=frequency=900:duration=1", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip], { capture: true });
  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/images/edits")) return jsonResponse({ data: [{ b64_json: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") }], request_id: "image-chain" });
    if (pathname.endsWith("/videos/generations") && options.method === "POST") return jsonResponse({ request_id: "video-chain" });
    if (pathname.endsWith("/videos/video-chain")) return jsonResponse({ status: "done", video: { url: "http://127.0.0.1:9876/chain.mp4" } });
    if (pathname === "/chain.mp4") return new Response(fs.readFileSync(clip), { status: 200 });
    throw new Error(`unexpected request ${pathname}`);
  };
  const dependencies = { config, plan, yes: true, fetch, testOrigins: ["http://127.0.0.1:9876"] };
  const images = await runMedia({ command: "images", ...dependencies });
  assert.equal(images[0].status, "needs_review");
  assert.ok(images[0].candidate.path);
  await approveArtifact({ config, plan, sceneId: scene.scene_id, stage: "image", checksum: images[0].candidate.sha256 });
  const videos = await runMedia({ command: "videos", ...dependencies });
  assert.equal(videos[0].status, "needs_review");
  await approveArtifact({ config, plan, sceneId: scene.scene_id, stage: "video", checksum: videos[0].candidate.sha256 });
  const final = await runMedia({ command: "assemble", config, plan });
  assert.equal(final.status, "complete");
  const probe = JSON.parse((await runProcess("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", path.join(config.outputs, "final-xai", "adapter-film.mp4")], { capture: true })).stdout);
  assert.deepEqual(probe.streams.map((stream) => stream.codec_type), ["video"], "provider audio must be removed from silent assembly");
});

test("Gemini-only no-judge video executes without xAI credentials or requests", async (t) => {
  const { root, config, plan, scene } = fixture(t);
  delete config.apiKey;
  delete config.apiBaseUrl;
  config.providers.video = "gemini";
  config.quality.judgeEnabled = false;
  config.audio = null;
  config.allowSilent = true;
  scene.duration_seconds = 4;
  const credentialReads = [];
  const credentials = new Proxy({
    geminiApiKey: "gemini-test-key",
    geminiBaseUrl: "http://127.0.0.1:9876",
  }, {
    get(target, property, receiver) {
      credentialReads.push(String(property));
      if (String(property).startsWith("xai")) throw new Error(`unused xAI credential accessed: ${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  });
  Object.defineProperty(config, "credentials", { enumerable: false, value: credentials });
  await approveMedia({ config, plan, acknowledgeRights: true });

  const paths = scenePaths(config, plan, scene, "gemini");
  fs.mkdirSync(paths.image, { recursive: true });
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=64x48", "-frames:v", "1", paths.selectedImage], { capture: true });
  const imageExpected = imageFingerprints(config, plan, scene);
  await writeSelection(paths.imageSelection, paths.selectedImage, { status: "selected", generationEpoch: 0, generationFingerprint: imageExpected.generation, qaFingerprint: imageExpected.qa });
  const clip = path.join(root, "gemini.mp4");
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=64x48:r=10:d=4", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], { capture: true });

  const requests = [];
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ url: parsed.toString(), method: options.method ?? "GET", headers: options.headers ?? {} });
    if (parsed.pathname.endsWith("/models/gemini-model:predictLongRunning") && options.method === "POST") {
      return jsonResponse({ name: "projects/test/locations/us/operations/video-one" });
    }
    if (parsed.pathname.endsWith("/projects/test/locations/us/operations/video-one")) {
      return jsonResponse({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "http://127.0.0.1:9876/gemini.mp4" } }] } } });
    }
    if (parsed.pathname === "/gemini.mp4") return new Response(fs.readFileSync(clip), { status: 200 });
    throw new Error(`unexpected request ${parsed.pathname}`);
  };
  const videos = await runMedia({ command: "videos", config, plan, yes: true, fetch, sleep: async () => {}, testOrigins: ["http://127.0.0.1:9876"] });
  assert.equal(videos[0].status, "needs_review");
  assert.equal(videos[0].candidate.technicalPassed, true);
  assert.match(videos[0].reason, /manually approve/i);
  assert.equal(requests.length, 3, "Gemini submit, poll, and clip download must all execute");
  assert.equal(requests.some(({ url }) => /api\.x\.ai|xai/i.test(url)), false);
  assert.equal(credentialReads.some((key) => key.startsWith("xai")), false);
  assert.equal(requests.every(({ headers }) => headers.Authorization === undefined), true, "no xAI bearer credential may be sent");
});

test("direct-photo-only images use local FFmpeg without provider credentials or model validation", async (t) => {
  const { root, config, plan, scene } = fixture(t);
  const source = path.join(root, "direct-source.jpg");
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=80x60", "-frames:v", "1", source], { capture: true });
  scene.source_image_mode = "direct_animation";
  scene.source_image = source;
  config.models.image = "example-image";
  config.models.judge = "placeholder-judge";
  config.quality.judgeEnabled = true;
  delete config.apiKey;
  delete config.apiBaseUrl;
  let credentialReads = 0;
  Object.defineProperty(config, "credentials", { enumerable: false, value: new Proxy({}, { get() { credentialReads++; throw new Error("unused provider credential accessed"); } }) });
  await approveMedia({ config, plan, acknowledgeRights: true });

  let fetchCalls = 0;
  const images = await runMedia({ command: "images", config, plan, yes: true, fetch: async () => { fetchCalls++; throw new Error("provider request was not expected"); }, testOrigins: ["http://127.0.0.1:9876"] });
  assert.equal(images[0].status, "selected");
  assert.equal(images[0].sourceMode, "direct_animation");
  assert.equal(images[0].technicalPassed, true);
  assert.equal(images[0].costUsd, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(credentialReads, 0);
  const output = scenePaths(config, plan, scene).selectedImage;
  const probe = JSON.parse((await runProcess("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", output], { capture: true })).stdout);
  assert.deepEqual(probe.streams, [{ width: 64, height: 48, codec_type: "video" }]);
});

test("accepted adapter video survives loss before request.json without another POST", async (t) => {
  const { root, config, plan, scene } = fixture(t);
  config.quality.judgeEnabled = false;
  const paths = scenePaths(config, plan, scene);
  fs.mkdirSync(paths.image, { recursive: true }); fs.writeFileSync(paths.selectedImage, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const imageExpected = imageFingerprints(config, plan, scene);
  await writeSelection(paths.imageSelection, paths.selectedImage, { status: "selected", generationEpoch: 0, generationFingerprint: imageExpected.generation, qaFingerprint: imageExpected.qa });
  const clip = path.join(root, "clip.mp4");
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=64x48:r=10:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], { capture: true });
  let posts = 0; let gets = 0;
  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (options.method === "POST") { posts++; return jsonResponse({ request_id: "op-known" }); }
    if (pathname.endsWith("/videos/op-known")) { gets++; return gets === 1 ? jsonResponse({ error: "crash simulation" }, 400) : jsonResponse({ status: "done", video: { url: "http://127.0.0.1:9876/clip.mp4" } }); }
    if (pathname === "/clip.mp4") return new Response(fs.readFileSync(clip), { status: 200 });
    throw new Error(`unexpected request ${pathname}`);
  };
  const journal = createPaidOperationJournal(path.join(config.outputs, "paid-operations"));
  const registry = createProviderRegistry(config, { fetch, journal, testOrigins: ["http://127.0.0.1:9876"], sleep: async () => {} });
  await assert.rejects(generateVideos({ registry, config, plan, yes: true }), /HTTP 400/);
  const requestPath = path.join(paths.video, "attempt_01", "request.json");
  assert.equal(posts, 1);
  fs.rmSync(requestPath);
  const result = await generateVideos({ registry, config, plan, yes: true });
  assert.equal(posts, 1);
  assert.equal(result[0].status, "needs_review");
  assert.equal(result[0].candidate.technicalPassed, true);
});
