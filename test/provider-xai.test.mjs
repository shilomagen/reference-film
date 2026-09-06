import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, safeSerialize } from "../src/io.mjs";
import { createXaiProvider, usageCostUsd } from "../src/providers/xai.mjs";

function provider(fetch) {
  return createXaiProvider({
    apiKey: "fake-xai-key", baseUrl: "http://127.0.0.1:45678/v1",
    testOrigins: ["http://127.0.0.1:45678"], fetch, sleep: async () => {},
    retry: { retries: 0 },
  });
}

test("xAI uses documented multi-reference payload and silent video", async () => {
  const requests = [];
  const client = provider(async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify(requests.length === 1
      ? { data: [{ b64_json: "eA==" }], usage: { cost_in_usd_ticks: 10_000_000_000 } }
      : { request_id: "video-1" }), { status: 200 });
  });
  const images = await client.generateCandidates({ model: "image", prompt: "scene", referenceImages: ["data:image/jpeg;base64,AA==", "data:image/jpeg;base64,AQ=="], count: 1, aspectRatio: "16:9", resolution: "2k", quality: "medium" });
  const video = await client.startVideo({ model: "video", prompt: "move", sourceImage: "data:image/jpeg;base64,AA==", duration: 6, aspectRatio: "16:9", resolution: "1080p" });
  assert.deepEqual(requests[0].images, [{ url: "data:image/jpeg;base64,AA==" }, { url: "data:image/jpeg;base64,AQ==" }]);
  assert.equal(requests[1].generate_audio, false);
  assert.equal(images.costUsd, 1);
  assert.equal(video.operationId, "video-1");
  assert.equal(video.costUsd, null);
  assert.equal(usageCostUsd({}), null);
});

test("text/judge schema fallback occurs only for explicit unsupported response format", async () => {
  let calls = 0;
  const client = provider(async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: { code: "unsupported_response_format", message: "response_format json_schema is not supported" } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"score\":9}" } }] }), { status: 200 });
  });
  const result = await client.judgeImages({ model: "judge", prompt: "judge", images: ["data:image/png;base64,AA=="], schema: { name: "score", value: { type: "object" } } });
  assert.deepEqual(result.json, { score: 9 });
  assert.equal(calls, 2);

  let arbitraryCalls = 0;
  const noFallback = provider(async () => {
    arbitraryCalls += 1;
    return new Response(JSON.stringify({ error: { message: "bad prompt" } }), { status: 400 });
  });
  await assert.rejects(noFallback.generateText({ model: "text", prompt: "p", schema: { name: "x", value: {} } }), /HTTP 400/);
  assert.equal(arbitraryCalls, 1);
});

test("provider error echoes cannot expose the xAI credential", async () => {
  const key = "xai-error-secret-sentinel";
  const logs = [];
  const client = createXaiProvider({
    apiKey: key, baseUrl: "http://127.0.0.1:45678/v1",
    testOrigins: ["http://127.0.0.1:45678"], sleep: async () => {}, retry: { retries: 0 },
    logger: (message, metadata) => logs.push(JSON.stringify({ message, metadata })),
    fetch: async () => new Response(JSON.stringify({ error: {
      code: `invalid_${key}`,
      message: `credential ${key}; response_format json_schema is not supported`,
    } }), { status: 401 }),
  });
  const error = await client.generateText({ model: "text", prompt: "p" }).catch((caught) => caught);
  assert.doesNotMatch(error.message, new RegExp(key));
  assert.doesNotMatch(JSON.stringify(error), new RegExp(key));
  assert.doesNotMatch(safeSerialize({ error }), new RegExp(key));
  const output = [];
  createLogger({ stream: { write: (line) => output.push(line) } })("provider failure", { error });
  assert.doesNotMatch(output.join(""), new RegExp(key));
  assert.doesNotMatch(logs.join("\n"), new RegExp(key));
});

test("structured output parse does not trigger paid repair", async () => {
  let calls = 0;
  const client = provider(async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 });
  });
  await assert.rejects(client.generateText({ model: "text", prompt: "p", schema: { name: "x", value: {} } }), /invalid JSON/);
  assert.equal(calls, 1);
});
