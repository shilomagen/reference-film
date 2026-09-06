import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = path.join(root, "examples", "project.config.json");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reference-film-entrypoint-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function symlink(t, target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("symlinks are unavailable on this platform");
      return false;
    }
    throw error;
  }
  return true;
}

function run(entry, args, cwd) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

function assertHelp(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.ok(result.stdout.trim().length > 0, `${label} produced empty help output`);
  assert.match(result.stdout, /Usage:|Media CLI:/);
}

test("CLI entrypoints execute through file and directory symlinks from an unrelated cwd", (t) => {
  const temporary = temporaryDirectory(t);
  const cwd = path.join(temporary, "unrelated-cwd");
  const links = path.join(temporary, "links");
  fs.mkdirSync(cwd);
  fs.mkdirSync(links);

  const directoryLink = path.join(links, "checkout");
  if (!symlink(t, root, directoryLink, process.platform === "win32" ? "junction" : "dir")) return;
  const cliLink = path.join(links, "cli.mjs");
  const mediaCliLink = path.join(links, "media-cli.mjs");
  if (!symlink(t, path.join(root, "src", "cli.mjs"), cliLink, "file")) return;
  if (!symlink(t, path.join(root, "src", "media-cli.mjs"), mediaCliLink, "file")) return;

  assertHelp(run(path.join(directoryLink, "src", "cli.mjs"), ["--help"], cwd), "directory-symlink CLI");
  assertHelp(run(mediaCliLink, ["--help"], cwd), "file-symlink media CLI");

  for (const [label, entry] of [
    ["file-symlink CLI", cliLink],
    ["directory-symlink media CLI", path.join(directoryLink, "src", "media-cli.mjs")],
  ]) {
    const validation = run(entry, ["validate", "--config", config], cwd);
    assert.equal(validation.status, 0, `${label}: ${validation.stderr}`);
    assert.ok(validation.stdout.trim().length > 0, `${label} produced empty validation output`);
    const parsed = JSON.parse(validation.stdout);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.offline, true);
    assert.ok(parsed.scenes > 0);
  }
});

test("export and syntax entrypoints execute through symlinked paths from an unrelated cwd", (t) => {
  const temporary = temporaryDirectory(t);
  const cwd = path.join(temporary, "unrelated-cwd");
  const links = path.join(temporary, "links");
  fs.mkdirSync(cwd);
  fs.mkdirSync(links);

  const directoryLink = path.join(links, "checkout");
  const exportLink = path.join(links, "export.mjs");
  if (!symlink(t, root, directoryLink, process.platform === "win32" ? "junction" : "dir")) return;
  if (!symlink(t, path.join(root, "scripts", "export.mjs"), exportLink, "file")) return;

  const help = run(exportLink, ["--help"], cwd);
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.trim().length > 0, "symlinked export entrypoint produced empty output");
  assert.match(help.stdout, /Creates an allowlisted public-source copy/);

  const destination = path.join(temporary, "public-source");
  const exported = run(exportLink, [destination], cwd);
  assert.equal(exported.status, 0, exported.stderr);
  assert.ok(exported.stdout.trim().length > 0, "symlinked export entrypoint produced empty export output");
  assert.match(exported.stdout, /Exported \d+ allowlisted files/);
  assert.ok(fs.statSync(path.join(destination, "EXPORT_MANIFEST.json")).size > 0);

  const syntax = run(path.join(directoryLink, "scripts", "check-syntax.mjs"), [path.join(root, "src", "entrypoint.mjs")], cwd);
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.ok(syntax.stdout.trim().length > 0, "symlinked syntax entrypoint produced empty output");
  assert.match(syntax.stdout, /Syntax checked 1 JavaScript files\./);
});

test("entrypoint modules remain side-effect free when imported", (t) => {
  const cwd = temporaryDirectory(t);
  for (const entry of ["src/cli.mjs", "src/media-cli.mjs", "scripts/export.mjs", "scripts/check-syntax.mjs"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(path.join(root, entry))})`], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${entry}: ${result.stderr}`);
    assert.equal(result.stdout, "", `${entry} wrote stdout while imported`);
    assert.equal(result.stderr, "", `${entry} wrote stderr while imported`);
  }
  assert.deepEqual(fs.readdirSync(cwd), []);
});
