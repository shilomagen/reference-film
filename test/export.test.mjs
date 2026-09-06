import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectPublicFiles, exportPublicSource } from "../scripts/export.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reference-film-export-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function put(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function fixture(t) {
  const temporary = temporaryDirectory(t);
  const source = path.join(temporary, "synthetic-source");
  fs.mkdirSync(source);
  put(source, "README.md", "# Synthetic public project\n");
  put(source, ".env.example", "API_KEY=\n");
  put(source, ".gitignore", ".env\n");
  put(source, "CONTRIBUTING.md", "Use synthetic fixtures.\n");
  put(source, "docs/privacy.md", "Synthetic privacy notes.\n");
  put(source, ".github/workflows/ci.yml", "name: synthetic\n");
  put(source, ".github/ISSUE_TEMPLATE/bug.md", "Synthetic bug form.\n");
  put(source, ".github/pull_request_template.md", "Synthetic PR form.\n");
  put(source, "src/nested/cli.mjs", "export const value = 1;\n");
  put(source, "schemas/config.schema.json", "{}\n");
  put(source, "scripts/tool.js", "export {};\n");
  put(source, "test/tool.test.mjs", "// synthetic\n");
  put(source, "examples/creator-notes.md", "fictional people only\n");
  put(source, "examples/scene-plan.json", "{}\n");
  return { temporary, source };
}

function hashTree(root) {
  const values = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isSymbolicLink()) values.push(`${relative}:symlink:${fs.readlinkSync(absolute)}`);
      else values.push(`${relative}:${crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`);
    }
  }
  visit(root);
  return values;
}

function exportedPaths(destination) {
  const paths = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      if (fs.statSync(absolute).isDirectory()) visit(absolute);
      else paths.push(path.relative(destination, absolute).split(path.sep).join("/"));
    }
  }
  visit(destination);
  return paths.sort();
}

test("exports only allowlisted public source with deterministic checksums", (t) => {
  const { temporary, source } = fixture(t);
  const privateSentinels = [
    put(source, ".env", "REAL_KEY=sentinel-secret\n"),
    put(source, ".env.local", "REAL_KEY=sentinel-secret\n"),
    put(source, ".fullcycle/notes.md", "sentinel-private\n"),
    put(source, "projects/person/project.config.json", "{\"person\":\"sentinel\"}\n"),
    put(source, "source-media/face.jpg", "sentinel-face\n"),
    put(source, "outputs/result.mp4", "sentinel-video\n"),
    put(source, "examples/private-project.json", "{\"secret\":true}\n"),
    put(source, "unknown-private.txt", "sentinel-private\n"),
    put(source, "docs/raw-notes.txt", "sentinel-private\n"),
    put(source, "src/leaked.png", "sentinel-media\n"),
  ];
  const before = hashTree(source);
  const firstDestination = path.join(temporary, "first-export");
  const secondDestination = path.join(temporary, "second-export");
  const first = exportPublicSource({ sourceRoot: source, destination: firstDestination });
  const second = exportPublicSource({ sourceRoot: source, destination: secondDestination });

  const expected = [
    ".env.example",
    ".gitignore",
    ".github/ISSUE_TEMPLATE/bug.md",
    ".github/pull_request_template.md",
    ".github/workflows/ci.yml",
    "CONTRIBUTING.md",
    "docs/privacy.md",
    "examples/creator-notes.md",
    "examples/scene-plan.json",
    "README.md",
    "schemas/config.schema.json",
    "scripts/tool.js",
    "src/nested/cli.mjs",
    "test/tool.test.mjs",
  ].sort();
  assert.deepEqual(first.manifest.files.map((file) => file.path).sort(), expected);
  assert.deepEqual(exportedPaths(firstDestination), [...expected, "EXPORT_MANIFEST.json"].sort());
  assert.deepEqual(first.manifest, second.manifest);
  for (const file of first.manifest.files) {
    const content = fs.readFileSync(path.join(firstDestination, ...file.path.split("/")));
    assert.equal(file.bytes, content.length);
    assert.equal(file.sha256, crypto.createHash("sha256").update(content).digest("hex"));
  }
  assert.deepEqual(hashTree(source), before, "source files must not be mutated");
  for (const sentinel of privateSentinels) assert.equal(fs.existsSync(sentinel), true);

  const manifestText = fs.readFileSync(path.join(firstDestination, "EXPORT_MANIFEST.json"), "utf8");
  assert.doesNotMatch(manifestText, /sentinel|REAL_KEY|private-project|source-media/);
  assert.deepEqual(first.manifest.license, {
    status: "pending",
    notice: "No license file was present; this export does not grant an open-source license.",
  });
});

test("rejects source symlinks before creating a destination", (t) => {
  const { temporary, source } = fixture(t);
  const external = put(temporary, "outside.mjs", "export const secret = true;\n");
  const link = path.join(source, "src", "linked.mjs");
  try {
    fs.symlinkSync(external, link);
  } catch (error) {
    if (error.code === "EPERM") return t.skip("symlinks are unavailable on this platform");
    throw error;
  }
  const destination = path.join(temporary, "export");
  assert.throws(() => exportPublicSource({ sourceRoot: source, destination }), /symlinks are not allowed/);
  assert.equal(fs.existsSync(destination), false);
});

test("rejects existing destinations and source/destination overlap", (t) => {
  const { temporary, source } = fixture(t);
  const existingEmpty = path.join(temporary, "existing-empty");
  fs.mkdirSync(existingEmpty);
  assert.throws(() => exportPublicSource({ sourceRoot: source, destination: existingEmpty }), /new, nonexistent directory/);

  const existingNonempty = path.join(temporary, "existing-nonempty");
  put(existingNonempty, "keep.txt", "do not mutate\n");
  assert.throws(() => exportPublicSource({ sourceRoot: source, destination: existingNonempty }), /new, nonexistent directory/);
  assert.equal(fs.readFileSync(path.join(existingNonempty, "keep.txt"), "utf8"), "do not mutate\n");

  assert.throws(() => exportPublicSource({ sourceRoot: source, destination: path.join(source, "nested-export") }), /must not overlap/);
  assert.throws(() => exportPublicSource({ sourceRoot: source, destination: temporary }), /must not overlap/);
});

test("current checkout export has valid CLI syntax and help", (t) => {
  const temporary = temporaryDirectory(t);
  const destination = path.join(temporary, "public-source");
  const before = collectPublicFiles(REPOSITORY_ROOT).map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 }));
  exportPublicSource({ sourceRoot: REPOSITORY_ROOT, destination });
  const syntax = spawnSync(process.execPath, ["--check", path.join(destination, "src", "cli.mjs")], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const exportedCli = fs.realpathSync(path.join(destination, "src", "cli.mjs"));
  const help = spawnSync(process.execPath, [exportedCli, "--help"], { cwd: fs.realpathSync(destination), encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
  const after = collectPublicFiles(REPOSITORY_ROOT).map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 }));
  assert.deepEqual(after, before, "export must not modify the checkout");
});
