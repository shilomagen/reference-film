import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIT_LICENSE_BYTES = 1068;
const MIT_LICENSE_SHA256 = "77a12817ae0d70aa2f603dfa574cdcb2d0ebd9f4a44a6ef49d9311cb2f196458";

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "assets") return [];
    return entry.isDirectory() ? walk(target) : [target];
  });
}

test("package contract is private against publication, MIT-licensed, dependency-free, and positively allowlisted", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const license = fs.readFileSync(path.join(root, "LICENSE"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "MIT");
  assert.equal(lock.packages[""].license, "MIT");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ["check", "dry-run", "example:assets", "test", "validate"]);
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("LICENSE"));
  assert.equal(license.length, MIT_LICENSE_BYTES);
  assert.equal(crypto.createHash("sha256").update(license).digest("hex"), MIT_LICENSE_SHA256);
  assert.match(license.toString("utf8"), /^MIT License\n\nCopyright \(c\) 2026 Shilo Magen\n/);
  assert.equal(Object.keys(pkg.scripts).some((name) => /install|postinstall|preinstall/.test(name)), false);
});

test("repository does not contain private media and ignores generated media", () => {
  const trackedLike = walk(root).map((file) => path.relative(root, file));
  assert.equal(trackedLike.some((file) => /\.(png|jpe?g|wav|mp3|mp4)$/i.test(file)), false);
  const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const value of [".env", ".generated/", "outputs/", "*.png", "*.wav", "*.mp4"]) assert.match(ignore, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("public JSON and markdown use generic example terms", () => {
  const content = walk(root).filter((file) => /\.(json|md|mjs)$/.test(file) && !file.endsWith("contracts.test.mjs")).map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const forbidden = ["wed" + "ding", "Su" + "no", "corporate " + "integration"];
  for (const term of forbidden) assert.equal(content.toLowerCase().includes(term.toLowerCase()), false, `found forbidden term: ${term}`);
});
