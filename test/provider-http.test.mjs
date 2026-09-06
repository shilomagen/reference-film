import assert from "node:assert/strict";
import test from "node:test";
import {
  AmbiguousPaidRequestError, createHttpClient, parseRetryAfterMs, retryDelayMs,
} from "../src/providers/http.mjs";

const jsonResponse = (status, body, headers) => new Response(JSON.stringify(body), { status, headers });

test("safe GET retries transient responses and caps numeric/date Retry-After plus jitter", async () => {
  const delays = [];
  let calls = 0;
  const request = createHttpClient({
    fetch: async () => ++calls === 1
      ? jsonResponse(429, { error: { message: "wait" } }, { "retry-after": "999" })
      : jsonResponse(200, { ok: true }),
    sleep: async (delay) => delays.push(delay), random: () => 1,
    retries: 2, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0.5,
  });
  assert.deepEqual(await request("https://example.test/poll"), { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [100]);
  const now = Date.parse("2025-01-01T00:00:00Z");
  assert.equal(parseRetryAfterMs("Wed, 01 Jan 2025 00:00:02 GMT", now), 2000);
  assert.equal(retryDelayMs({ retryAfter: "Wed, 01 Jan 2025 00:00:20 GMT", now, attempt: 1, maxDelayMs: 1000, jitterRatio: 0.2, random: () => 1 }), 1000);
});

test("ambiguous paid POST network, body, and 5xx failures are never retried", async (t) => {
  for (const scenario of ["network", "body", "5xx"]) {
    await t.test(scenario, async () => {
      let calls = 0;
      const request = createHttpClient({ fetch: async () => {
        calls += 1;
        if (scenario === "network") throw new Error("socket lost with secret body");
        if (scenario === "body") return { ok: true, status: 200, text: async () => { throw new Error("stream reset"); }, headers: new Headers() };
        return jsonResponse(503, { error: { message: "internal failure" } });
      }, sleep: async () => {}, retries: 7 });
      await assert.rejects(request("https://example.test/paid", { method: "POST", paid: true, body: { prompt: "private" } }), AmbiguousPaidRequestError);
      assert.equal(calls, 1);
    });
  }
});

test("paid POST retries only explicit rate or unaccepted capacity rejection", async () => {
  let calls = 0;
  const request = createHttpClient({
    fetch: async () => ++calls === 1
      ? jsonResponse(503, { error: { code: "capacity_exhausted", message: "Request was not accepted because capacity is overloaded" } })
      : jsonResponse(200, { id: "ok" }),
    sleep: async () => {}, random: () => 0.5, baseDelayMs: 1,
  });
  assert.equal((await request("https://example.test/paid", { method: "POST", body: {} })).id, "ok");
  assert.equal(calls, 2);
});
