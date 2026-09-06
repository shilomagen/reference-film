import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPaidOperationJournal, PaidOperationBlockedError } from "../src/providers/journal.mjs";

test("journal prevents duplicate after restart and explicit reconciliation permits exactly one", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-journal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const first = createPaidOperationJournal(directory);
  await assert.rejects(first.run({ id: "image-1", provider: "xai", operation: "image", model: "m", fingerprint: "fp" }, async () => {
    calls += 1;
    throw new Error("connection lost after submit");
  }), /connection lost/);
  assert.equal(calls, 1);

  const restarted = createPaidOperationJournal(directory);
  await assert.rejects(restarted.run({ id: "image-1", provider: "xai", operation: "image", model: "m", fingerprint: "fp" }, async () => { calls += 1; }), PaidOperationBlockedError);
  assert.equal(calls, 1);
  assert.throws(() => restarted.authorizeRetry("image-1", "checked provider", {}), /acknowledgeDuplicateRisk/);
  restarted.authorizeRetry("image-1", "provider confirmed no accepted request", { acknowledgeDuplicateRisk: true });
  const result = await restarted.run({ id: "image-1", provider: "xai", operation: "image", model: "m", fingerprint: "fp" }, async () => {
    calls += 1;
    return { state: "completed", metadata: { requestId: "req-2", operationId: "operations/completed-2", costUsd: 0.25, url: "https://secret.invalid/signed?token=x", prompt: "private payload" }, result: { bytes: "not persisted" } };
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.result, { bytes: "not persisted" });
  await assert.doesNotReject(async () => restarted.run({ id: "image-1", provider: "xai", operation: "image", model: "m", fingerprint: "fp" }, async () => { calls += 1; }));
  assert.equal(calls, 2);

  const raw = fs.readFileSync(path.join(directory, "image-1.json"), "utf8");
  assert.doesNotMatch(raw, /not persisted|secret\.invalid|private payload/);
  const entry = JSON.parse(raw);
  assert.equal(entry.state, "completed");
  assert.equal(entry.operationId, "operations/completed-2");
  assert.equal(entry.costUsd, 0.25);
  assert.ok(entry.history.some((event) => event.state === "uncertain"));
  assert.ok(entry.history.some((event) => event.state === "retry_authorized"));
});

test("video acceptance checkpoints operation id before polling", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-journal-video-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = createPaidOperationJournal(directory);
  await journal.run({ id: "video-1", provider: "gemini", operation: "video", model: "v", fingerprint: "fp" }, async ({ checkpointAccepted }) => {
    await checkpointAccepted({ operationId: "operations/abc" });
    const onDisk = JSON.parse(fs.readFileSync(path.join(directory, "video-1.json"), "utf8"));
    assert.equal(onDisk.state, "accepted");
    assert.equal(onDisk.operationId, "operations/abc");
    return { state: "accepted", metadata: { operationId: "operations/abc" } };
  });
});
