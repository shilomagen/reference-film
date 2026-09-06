import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson, download, mapLimit, objectHash, redact, safeSerialize, sanitizeUrl, writeJson } from "../src/io.mjs";

test("mapLimit drains remaining work before reporting item failures", async () => {
  const visited = [];
  await assert.rejects(mapLimit([1, 2, 3, 4], 2, async (value) => {
    visited.push(value);
    if (value === 2) throw new Error("item two failed");
    return value * 2;
  }), /1 item\(s\) failed.*item two failed/);
  assert.deepEqual([...visited].sort(), [1, 2, 3, 4]);
});

test("canonical hashes ignore object key insertion order and JSON writes atomically", (t) => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(objectHash({ b: 2, a: 1 }), objectHash({ a: 1, b: 2 }));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "io-json-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "nested", "value.json");
  writeJson(target, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ok: true });
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["value.json"]);
});

test("redaction removes secrets, auth, arbitrary URL parameters, and embedded base64", () => {
  const encoded = "A".repeat(120);
  const clean = safeSerialize({
    apiKey: "fake-key-sentinel", authorization: "Bearer abc.def",
    media: `prefix data:image/png;base64,${encoded} suffix`,
    url: "https://assets.example/clip?api_key=query-sentinel&bespoke_signature=other#fragment-sentinel",
    message: "Bearer abc.def fake-key-sentinel",
  }, { secrets: ["fake-key-sentinel"] });
  assert.doesNotMatch(clean, /fake-key-sentinel|abc\.def|query-sentinel|other|fragment-sentinel|AAAAA/);
  assert.match(clean, /prefix \[REDACTED BASE64\] suffix/);
  assert.equal(sanitizeUrl("https://user:password@assets.example/path/file.mp4?harmless_name=secret#private"), "https://assets.example/path/file.mp4");
  assert.equal(redact("ordinary creative prose"), "ordinary creative prose");
});

test("download retries safe GET atomically and refuses cross-origin credential redirects", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "io-download-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const target = path.join(directory, "clip.bin");
  await download("http://127.0.0.1:9999/clip", target, {
    allowedOrigins: ["http://127.0.0.1:9999"],
    fetch: async () => ++calls === 1 ? new Response("wait", { status: 503 }) : new Response("bytes"),
    retries: 1, sleep: async () => {},
  });
  assert.equal(fs.readFileSync(target, "utf8"), "bytes");
  assert.equal(calls, 2);

  await assert.rejects(download("http://127.0.0.1:9999/secret", path.join(directory, "bad"), {
    headers: { Authorization: "Bearer fake" },
    allowedOrigins: ["http://127.0.0.1:9999"], credentialOrigins: ["http://127.0.0.1:9999"], retries: 0,
    fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.invalid/file" } }),
  }), /credentials across a redirect|unexpected origin/);
});
