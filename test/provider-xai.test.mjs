import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLogger, safeSerialize } from "../src/io.mjs";
import { createPaidOperationJournal, PaidOperationResultUnavailableError } from "../src/providers/journal.mjs";
import { createXaiProvider, usageCostUsd } from "../src/providers/xai.mjs";

function provider(fetch, journal) {
  return createXaiProvider({
    apiKey: "fake-xai-key", baseUrl: "http://127.0.0.1:45678/v1",
    testOrigins: ["http://127.0.0.1:45678"], fetch, journal, sleep: async () => {},
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

test("configured text output budget is sent and bounded independently", async () => {
  let body;
  const client = createXaiProvider({
    apiKey: "fake-xai-key", baseUrl: "http://127.0.0.1:45678/v1", testOrigins: ["http://127.0.0.1:45678"],
    textMaxOutputTokens: 16000, retry: { retries: 0 },
    fetch: async (_url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }); },
  });
  await client.generateText({ model: "text", prompt: "long output" });
  assert.equal(body.max_tokens, 16000);
  assert.throws(() => createXaiProvider({ apiKey: "fake", textMaxOutputTokens: 32001 }), /1000 to 32000/);
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

test("operationKey separates intentional identical image rounds and restart never duplicates", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xai-image-operations-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let posts = 0;
  const bodies = [];
  const fetch = async (_url, init) => {
    posts += 1;
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(`round-${posts}`).toString("base64") }], request_id: `request-${posts}` }), { status: 200 });
  };
  const request = { model: "image", prompt: "identical", referenceImages: ["data:image/png;base64,AA=="], count: 1, aspectRatio: "16:9" };
  const first = provider(fetch, createPaidOperationJournal(directory));
  assert.equal((await first.generateCandidates({ ...request, operationKey: "scene-7/image/round-1" })).images.length, 1);
  assert.equal((await first.generateCandidates({ ...request, operationKey: "scene-7/image/round-2" })).images.length, 1);
  assert.equal(posts, 2);
  assert.equal("operationKey" in bodies[0], false);
  assert.equal("workKey" in bodies[0], false);

  const restarted = provider(fetch, createPaidOperationJournal(directory));
  const error = await restarted.generateCandidates({ ...request, operationKey: "scene-7/image/round-1" }).catch((caught) => caught);
  assert.ok(error instanceof PaidOperationResultUnavailableError);
  assert.match(error.journalId, /^[a-f0-9]{32}$/);
  assert.equal(posts, 2);
});

test("lost synchronous result requires one-at-a-time acknowledged replacement and keeps audit metadata safe", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xai-result-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let posts = 0;
  const fetch = async () => {
    posts += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: `answer-${posts}` } }], request_id: `request-${posts}`, private_payload: "DO_NOT_PERSIST" }), { status: 200 });
  };
  const journal = createPaidOperationJournal(directory);
  const client = provider(fetch, journal);
  const options = { model: "text", prompt: "private prompt sentinel", operationKey: "script/draft-1" };
  assert.equal((await client.generateText(options)).text, "answer-1");
  const lost = await client.generateText(options).catch((caught) => caught);
  assert.ok(lost instanceof PaidOperationResultUnavailableError);
  assert.equal(posts, 1);
  assert.throws(() => journal.authorizeRetry(lost.journalId, "", { acknowledgeDuplicateRisk: true }), /non-empty reason/);
  assert.throws(() => journal.authorizeRetry(lost.journalId, "replace lost result"), /acknowledgeDuplicateRisk/);

  journal.authorizeRetry(lost.journalId, "local response was lost", { acknowledgeDuplicateRisk: true });
  assert.equal((await client.generateText(options)).text, "answer-2");
  const lostAgain = await client.generateText(options).catch((caught) => caught);
  assert.ok(lostAgain instanceof PaidOperationResultUnavailableError);
  assert.equal(posts, 2);
  journal.authorizeRetry(lostAgain.journalId, "second local response was lost", { acknowledgeDuplicateRisk: true });
  assert.equal((await client.generateText(options)).text, "answer-3");
  assert.equal(posts, 3);

  const raw = fs.readFileSync(journal.pathFor(lost.journalId), "utf8");
  assert.doesNotMatch(raw, /private prompt sentinel|script\/draft-1|DO_NOT_PERSIST|answer-/);
  const entry = JSON.parse(raw);
  assert.equal(entry.history.filter(({ state }) => state === "retry_authorized").length, 2);
  assert.equal(entry.history.filter(({ state }) => state === "submission_started").length, 3);
});

test("accepted video is recovered by operationKey without another POST and malformed success is uncertain", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xai-video-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let posts = 0;
  const fetch = async () => {
    posts += 1;
    return new Response(JSON.stringify(posts === 1 ? { request_id: "video-known-1" } : {}), { status: 200 });
  };
  const options = { model: "video", prompt: "move", sourceImage: "data:image/png;base64,AA==", duration: 5, aspectRatio: "16:9", resolution: "720p", operationKey: "scene-7/video/attempt-1" };
  const started = await provider(fetch, createPaidOperationJournal(directory)).startVideo(options);
  assert.equal(started.operationId, "video-known-1");
  const recovered = await provider(fetch, createPaidOperationJournal(directory)).startVideo(options);
  assert.equal(recovered.operationId, "video-known-1");
  assert.equal(recovered.reused, true);
  assert.equal(posts, 1);

  const invalid = await provider(fetch, createPaidOperationJournal(directory)).startVideo({ ...options, operationKey: "scene-7/video/attempt-2" }).catch((caught) => caught);
  assert.match(invalid.message, /invalid|operation/i);
  assert.equal(posts, 2);
  assert.equal(createPaidOperationJournal(directory).get(invalid.journalId).state, "uncertain");
});

test("invalid successful synchronous body is uncertain rather than completed", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xai-invalid-success-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = createPaidOperationJournal(directory);
  const client = provider(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }), journal);
  const error = await client.generateCandidates({
    model: "image", prompt: "scene", referenceImages: ["data:image/png;base64,AA=="],
    count: 1, aspectRatio: "16:9", operationKey: "scene/image/invalid-result",
  }).catch((caught) => caught);
  assert.match(error.message, /invalid/i);
  assert.equal(journal.get(error.journalId).state, "uncertain");
});

test("xAI retains the original integer duration interface for requests 5, 13, and 15", async () => {
  const requested = [];
  const client = provider(async (_url, init) => {
    requested.push(JSON.parse(init.body).duration);
    return new Response(JSON.stringify({ request_id: `video-${requested.length}` }), { status: 200 });
  });
  assert.deepEqual(client.supportedDurations("720p"), Array.from({ length: 15 }, (_, index) => index + 1));
  for (const duration of [5, 13, 15]) {
    await client.startVideo({ model: "video", prompt: "move", sourceImage: "data:image/png;base64,AA==", duration, aspectRatio: "16:9", resolution: "720p" });
  }
  assert.deepEqual(requested, [5, 13, 15]);
});
