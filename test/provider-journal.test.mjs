import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { objectHash } from "../src/io.mjs";
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
  await journal.run({ id: "video-1", provider: "gemini", operation: "video", model: "v", fingerprint: "fp", resultMode: "asynchronous" }, async ({ checkpointAccepted }) => {
    await checkpointAccepted({ operationId: "operations/abc" });
    const onDisk = JSON.parse(fs.readFileSync(path.join(directory, "video-1.json"), "utf8"));
    assert.equal(onDisk.state, "accepted");
    assert.equal(onDisk.operationId, "operations/abc");
    return { state: "accepted", metadata: { operationId: "operations/abc" } };
  });
  assert.throws(() => journal.authorizeRetry("video-1", "resubmit", { acknowledgeDuplicateRisk: true }), /must be resumed by polling/);
});

test("an exception after accepted checkpoint remains recoverable as accepted", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-journal-crash-window-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const details = { provider: "xai", operation: "video", model: "v", fingerprint: "fp", operationKey: "scene/video/attempt-1", resultMode: "asynchronous", resumeAccepted: true };
  const journal = createPaidOperationJournal(directory);
  await assert.rejects(journal.run(details, async ({ checkpointAccepted }) => {
    await checkpointAccepted({ operationId: "video-known" });
    throw new Error("caller crashed before request.json");
  }), /caller crashed/);
  const id = objectHash({ provider: details.provider, operation: details.operation, model: details.model, operationKey: details.operationKey, fingerprint: details.fingerprint }).slice(0, 32);
  const entry = journal.get(id);
  assert.equal(entry.state, "accepted");
  assert.equal(entry.operationId, "video-known");
  let calls = 0;
  const resumed = await createPaidOperationJournal(directory).run(details, async () => { calls += 1; });
  assert.equal(resumed.reused, true);
  assert.equal(resumed.entry.operationId, "video-known");
  assert.equal(calls, 0);
});
