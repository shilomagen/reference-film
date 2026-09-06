import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "assets") return [];
    return entry.isDirectory() ? walk(target) : [target];
  });
}

test("package contract is private, unlicensed, dependency-free, and positively allowlisted", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "UNLICENSED");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ["check", "dry-run", "example:assets", "test", "validate"]);
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0);
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
