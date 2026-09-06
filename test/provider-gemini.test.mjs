import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { safeSerialize } from "../src/io.mjs";
import { createGeminiProvider } from "../src/providers/gemini.mjs";

const origin = "http://127.0.0.1:45679";
function provider(fetch) {
  return createGeminiProvider({ apiKey: "fake-gemini-key", baseUrl: `${origin}/v1beta`, testOrigins: [origin], fetch, sleep: async () => {}, retry: { retries: 0 } });
}

test("Gemini normalizes safety filtering and durations/audio capability", async () => {
  const client = provider(async () => new Response(JSON.stringify({ done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["Safety policy"] } } }), { status: 200 }));
  const result = await client.getVideo("operations/filtered-1");
  assert.equal(result.status, "filtered");
  assert.deepEqual(result.filteredReasons, ["Safety policy"]);
  assert.deepEqual(client.supportedDurations("720p"), [4, 6, 8]);
  assert.deepEqual(client.supportedDurations("1080p"), [8]);
  assert.equal(client.supportsAudioControl(), false);
});

test("Gemini rejects malicious operation and returned download origins before credentials are sent", async () => {
  let calls = 0;
  const client = provider(async () => {
    calls += 1;
    return new Response(JSON.stringify({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://evil.invalid/clip?token=secret" } }] } } }), { status: 200 });
  });
  await assert.rejects(client.getVideo("https://evil.invalid//operations/x"), /safe relative/);
  assert.equal(calls, 0);
  await assert.rejects(client.getVideo("operations/good"), /not trusted/);
  assert.equal(calls, 1);
});

test("Gemini rejects credential forwarding on a download redirect", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-download-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let seenKey;
  const client = provider(async (_url, init) => {
    seenKey = init.headers["x-goog-api-key"];
    return new Response(null, { status: 302, headers: { location: "https://evil.invalid/clip" } });
  });
  await assert.rejects(client.downloadVideo(`${origin}/clip`, path.join(directory, "clip.mp4")), /credentials across a redirect|unexpected origin/);
  assert.equal(seenKey, "fake-gemini-key");
});

test("provider error echoes cannot expose the Gemini credential", async () => {
  const key = "gemini-error-secret-sentinel";
  const client = createGeminiProvider({
    apiKey: key, baseUrl: `${origin}/v1beta`, testOrigins: [origin],
    fetch: async () => new Response(JSON.stringify({ error: {
      code: `invalid_${key}`, message: `credential ${key} was rejected`,
    } }), { status: 400 }),
    sleep: async () => {}, retry: { retries: 0 },
  });
  const error = await client.getVideo("operations/failure").catch((caught) => caught);
  assert.doesNotMatch(error.message, new RegExp(key));
  assert.doesNotMatch(JSON.stringify(error), new RegExp(key));
  assert.doesNotMatch(safeSerialize({ error }), new RegExp(key));
});

test("Gemini start preserves data URI payload and does not retry 5xx POST", async () => {
  let calls = 0;
  let body;
  const client = provider(async (_url, init) => {
    calls += 1;
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ error: { message: "backend unavailable" } }), { status: 500 });
  });
  await assert.rejects(client.startVideo({ model: "veo-model", prompt: "move", sourceImage: "data:image/png;base64,AQ==", duration: 8, aspectRatio: "16:9", resolution: "1080p" }), /uncertain/);
  assert.equal(calls, 1);
  assert.deepEqual(body.instances[0].image, { mimeType: "image/png", bytesBase64Encoded: "AQ==" });
});
