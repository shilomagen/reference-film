import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, parseArgs } from "../src/config.mjs";
import {
  createProviderRegistry, finalArtifactDirectory, finalArtifactPath,
  requestedVideoDuration, validateProviderSelection, videoArtifactDirectory,
} from "../src/providers/index.mjs";

test("registry selects each capability and rejects unsupported combinations", () => {
  const config = {
    providers: { text: "xai", image: "xai", judge: "xai", video: "gemini" },
    models: { text: "t", image: "i", judge: "j", video: "xv", geminiVideo: "gv" },
    credentials: { xai: { apiKey: "fake-x" }, gemini: { apiKey: "fake-g" } },
  };
  const registry = createProviderRegistry(config, { fetch: async () => { throw new Error("offline"); } });
  assert.equal(registry.models.video, "gv");
  assert.equal(registry.text, registry.image);
  assert.notEqual(registry.video, registry.text);
  assert.throws(() => validateProviderSelection({ providers: { text: "gemini" } }), /does not support/);
});

test("text-only generation does not require credentials for selected Gemini video", async () => {
  const requests = [];
  const config = {
    providers: { text: "xai", image: "xai", judge: "xai", video: "gemini" },
    credentials: { xai: { apiKey: "fake-x" } },
  };
  const registry = createProviderRegistry(config, {
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { content: "offline result" } }] }), { status: 200 });
    },
  });

  const result = await registry.text.generateText({ model: "text-model", prompt: "hello" });
  assert.equal(result.text, "offline result");
  assert.equal(requests.length, 1);
  assert.throws(() => registry.video, /Gemini apiKey is required/);

  config.credentials.gemini = { apiKey: "fake-g" };
  assert.equal(registry.video, registry.video);
});

test("Gemini-only video access does not require xAI credentials", () => {
  const registry = createProviderRegistry({
    providers: { video: "gemini" },
    quality: { judgeEnabled: false },
    credentials: { gemini: { apiKey: "fake-g" } },
  }, { fetch: async () => { throw new Error("offline"); } });

  assert.equal(registry.selected.video, "gemini");
  assert.equal(registry.video, registry.video);
});

test("unavailable selected capabilities still fail during registry creation", () => {
  assert.throws(() => createProviderRegistry({
    providers: { text: "gemini", video: "gemini" },
    credentials: { gemini: { apiKey: "fake-g" } },
  }), /gemini does not support the text capability/);
});

test("actual loader credentials, URLs, and retry controls map to isolated adapters", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const environment = {
    XAI_API_KEY: "xai-loader-sentinel",
    XAI_API_BASE_URL: "http://127.0.0.1:45701/v1",
    GEMINI_API_KEY: "gemini-loader-sentinel",
    GEMINI_API_BASE_URL: "http://127.0.0.1:45702/v1beta",
  };
  const config = loadConfig(parseArgs(["validate", "--config", path.join(root, "examples", "project.config.json")]), { environment });
  config.providers.video = "gemini";
  config.generation.retry = { attempts: 2, baseDelayMs: 17, maxDelayMs: 31, jitter: 0 };
  const requests = [];
  const registry = createProviderRegistry(config, {
    testOrigins: ["http://127.0.0.1:45701", "http://127.0.0.1:45702"],
    trustedOrigins: ["http://127.0.0.1:45702"],
    sleep: async () => {},
    fetch: async (url, init) => {
      requests.push({ url: String(url), headers: init.headers });
      if (String(url).includes(":45701")) return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      return new Response(JSON.stringify({ done: false }), { status: 200 });
    },
  });
  await registry.text.generateText({ model: "text-model", prompt: "hello" });
  await registry.video.getVideo("operations/video-1");
  assert.deepEqual(requests.map(({ url }) => url), [
    "http://127.0.0.1:45701/v1/chat/completions",
    "http://127.0.0.1:45702/v1beta/operations/video-1",
  ]);
  assert.equal(requests[0].headers.Authorization, "Bearer xai-loader-sentinel");
  assert.equal(requests[0].headers["x-goog-api-key"], undefined);
  assert.equal(requests[1].headers["x-goog-api-key"], "gemini-loader-sentinel");
  assert.equal(requests[1].headers.Authorization, undefined);

  let attempts = 0;
  const delays = [];
  const retryRegistry = createProviderRegistry(config, {
    testOrigins: ["http://127.0.0.1:45701", "http://127.0.0.1:45702"],
    trustedOrigins: ["http://127.0.0.1:45702"],
    sleep: async (delay) => delays.push(delay), random: () => 0,
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    },
  });
  await assert.rejects(retryRegistry.text.generateText({ model: "text-model", prompt: "hello" }), /HTTP 429/);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [17, 31]);
});

test("package allowlist includes providers and docs without generated assets or secrets", () => {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8",
  }));
  const files = packed[0].files.map(({ path: filePath }) => filePath);
  assert.ok(files.includes("src/providers/index.mjs"));
  assert.ok(files.includes("src/providers/xai.mjs"));
  assert.ok(files.includes("src/providers/gemini.mjs"));
  assert.ok(files.includes("docs/provider-contracts.md"));
  assert.equal(files.some((filePath) => filePath.startsWith(".generated/") || (/(?:^|\/)\.env(?:\.|$)/.test(filePath) && filePath !== ".env.example")), false);
});

test("Gemini never inherits the legacy xAI top-level apiKey", () => {
  const registry = createProviderRegistry({
    providers: { video: "gemini" },
    apiKey: "xai-only-sentinel",
  });
  assert.throws(() => registry.video, /Gemini apiKey is required/);
});

test("provider artifact and duration helpers are generic", () => {
  const video = { supportedDurations: () => [4, 6, 8] };
  assert.equal(requestedVideoDuration(video, "720p", 5.2), 6);
  assert.equal(videoArtifactDirectory("gemini"), "video-gemini");
  assert.equal(finalArtifactDirectory("xai"), "final-xai");
  assert.equal(finalArtifactPath("out", "xai", "My Film!"), "out/final-xai/my-film.mp4");
});
