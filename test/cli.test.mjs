import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: { stdout: { write: (value) => { stdout += value; } }, stderr: { write: (value) => { stderr += value; } } },
    output: () => ({ stdout, stderr }),
  };
}

test("dry run compiles selected work with full timeline semantics and network denied", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("network denied by test"); };
  try {
    const sink = capture();
    const status = await main(["run", "--dry-run", "--scenes", "lantern_run", "--provider", "gemini"], sink.io);
    const output = JSON.parse(sink.output().stdout);
    assert.equal(status, 0);
    assert.equal(calls, 0);
    assert.equal(output.networkCalls, 0);
    assert.equal(output.providers.video, "gemini");
    assert.deepEqual(output.scenes.map((scene) => scene.scene_id), ["lantern_run"]);
    assert.equal(output.timeline.scenes.length, 4);
    assert.equal(output.timeline.total_duration_seconds, 20);
    assert.match(output.scenes[0].paths.root, /03_lantern_run$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validation is offline and status honestly reports missing media", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network denied by test"); };
  try {
    const validation = capture();
    await main(["validate"], validation.io);
    assert.equal(JSON.parse(validation.output().stdout).offline, true);
    const status = capture();
    await main(["status"], status.io);
    const result = JSON.parse(status.output().stdout);
    assert.equal(result.final.status, "missing");
    assert.ok(result.scenes.every((scene) => scene.image === "missing" && scene.video === "missing"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paid stage commands fail honestly without attempting network", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; };
  try {
    await assert.rejects(() => main(["images"], capture().io), /Paid generation requires yes/);
    await assert.rejects(() => main(["run"], capture().io), /Paid generation requires yes/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI runs from an external working directory with an explicit config", () => {
  const result = spawnSync(process.execPath, [path.join(root, "src", "cli.mjs"), "validate", "--config", path.join(root, "examples", "project.config.json")], {
    cwd: path.dirname(root), encoding: "utf8", env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "ok");
});

test("help does not load config or require generated assets", () => {
  const result = spawnSync(process.execPath, [path.join(root, "src", "cli.mjs"), "--help"], { cwd: "/", encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});
