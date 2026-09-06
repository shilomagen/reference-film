#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../src/entrypoint.mjs";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_FILES = new Set([
  ".env.example",
  ".gitignore",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "package-lock.json",
  "package.json",
]);
const LICENSE_FILES = new Set(["COPYING", "COPYING.md", "LICENSE", "LICENSE.md"]);
const SAFE_EXAMPLES = new Set([
  "examples/ASSET_PROVENANCE.md",
  "examples/creator-brief.json",
  "examples/creator-notes.md",
  "examples/lyrics.json",
  "examples/project.config.json",
  "examples/scene-plan.json",
  "examples/timings.json",
]);
const DIRECTORY_RULES = new Map([
  ["docs", new Set([".md"])],
  ["schemas", new Set([".json"])],
  ["scripts", new Set([".cjs", ".js", ".mjs"])],
  ["src", new Set([".cjs", ".js", ".mjs"])],
  ["test", new Set([".cjs", ".js", ".json", ".mjs"])],
  [".github/ISSUE_TEMPLATE", new Set([".md", ".yaml", ".yml"])],
  [".github/workflows", new Set([".yaml", ".yml"])],
]);
const EXACT_FILES = new Set([".github/pull_request_template.md"]);
const DENIED_SEGMENTS = new Set([
  ".checkpoints",
  ".exports",
  ".fullcycle",
  ".generated",
  ".git",
  "artifacts",
  "checkpoints",
  "export-staging",
  "generated",
  "node_modules",
  "outputs",
  "paid-checkpoints",
  "projects",
  "source-media",
]);
const MEDIA_EXTENSIONS = new Set([
  ".aac", ".aiff", ".avi", ".bmp", ".flac", ".gif", ".heic", ".jpeg", ".jpg",
  ".m4a", ".m4v", ".mkv", ".mov", ".mp3", ".mp4", ".mpeg", ".mpg", ".ogg",
  ".opus", ".png", ".tif", ".tiff", ".wav", ".webm", ".webp", ".wmv",
]);

function portable(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isDenied(relativePath) {
  const normalized = portable(relativePath);
  const segments = normalized.split("/");
  if (segments.some((segment) => DENIED_SEGMENTS.has(segment.toLowerCase()))) return true;
  const basename = segments.at(-1).toLowerCase();
  if ((basename === ".env" || basename.startsWith(".env.")) && normalized !== ".env.example") return true;
  return MEDIA_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase());
}

function isAllowlisted(relativePath) {
  const normalized = portable(relativePath);
  if (ROOT_FILES.has(normalized) || LICENSE_FILES.has(normalized) || EXACT_FILES.has(normalized) || SAFE_EXAMPLES.has(normalized)) return true;
  for (const [directory, extensions] of DIRECTORY_RULES) {
    if (normalized.startsWith(`${directory}/`) && extensions.has(path.posix.extname(normalized).toLowerCase())) return true;
  }
  return false;
}

function assertDirectoryNotSymlink(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${directory}`);
}

function inspectCandidate(sourceRoot, relativePath, records) {
  const sourcePath = path.join(sourceRoot, relativePath);
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`Source symlinks are not allowed: ${portable(relativePath)}`);
  if (!stat.isFile() || isDenied(relativePath) || !isAllowlisted(relativePath)) return;
  const content = fs.readFileSync(sourcePath);
  records.push({
    path: portable(relativePath),
    bytes: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    content,
  });
}

function walkAllowlistedDirectory(sourceRoot, relativeDirectory, records) {
  const directory = path.join(sourceRoot, relativeDirectory);
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error(`Source symlinks are not allowed: ${portable(relativeDirectory)}`);
  if (!stat.isDirectory()) return;
  for (const name of fs.readdirSync(directory).sort()) {
    const relativePath = path.join(relativeDirectory, name);
    const childStat = fs.lstatSync(path.join(sourceRoot, relativePath));
    if (childStat.isSymbolicLink()) throw new Error(`Source symlinks are not allowed: ${portable(relativePath)}`);
    if (childStat.isDirectory()) walkAllowlistedDirectory(sourceRoot, relativePath, records);
    else inspectCandidate(sourceRoot, relativePath, records);
  }
}

export function collectPublicFiles(sourceRoot) {
  const absoluteSource = path.resolve(sourceRoot);
  assertDirectoryNotSymlink(absoluteSource, "Source");
  const records = [];
  for (const relativePath of [...ROOT_FILES, ...LICENSE_FILES, ...EXACT_FILES, ...SAFE_EXAMPLES].sort()) {
    if (fs.existsSync(path.join(absoluteSource, relativePath))) inspectCandidate(absoluteSource, relativePath, records);
  }
  for (const directory of [...DIRECTORY_RULES.keys()].sort()) walkAllowlistedDirectory(absoluteSource, directory, records);
  records.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return records;
}

function canonicalProspectivePath(candidate) {
  let cursor = path.resolve(candidate);
  const missing = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`Cannot resolve destination: ${candidate}`);
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...missing);
}

function pathsOverlap(left, right) {
  const relation = path.relative(left, right);
  return relation === "" || (!relation.startsWith(`..${path.sep}`) && relation !== "..");
}

function assertSafeDestination(sourceRoot, destination) {
  const source = fs.realpathSync(sourceRoot);
  const target = canonicalProspectivePath(destination);
  if (pathsOverlap(source, target) || pathsOverlap(target, source)) {
    throw new Error("Source and destination must not overlap or contain one another");
  }
  if (fs.existsSync(destination)) throw new Error(`Destination must be a new, nonexistent directory: ${destination}`);
  const parent = path.dirname(path.resolve(destination));
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`Destination parent directory must already exist: ${parent}`);
  }
}

function licenseMetadata(records) {
  const files = records.filter((record) => LICENSE_FILES.has(record.path)).map((record) => record.path);
  if (files.length === 0) {
    return {
      status: "pending",
      notice: "No license file was present; this export does not grant an open-source license.",
    };
  }
  return {
    status: "included",
    files,
    notice: "Review the included license file(s) for the terms that apply.",
  };
}

export function exportPublicSource({ sourceRoot = SCRIPT_ROOT, destination }) {
  if (!destination || typeof destination !== "string") throw new Error("A destination directory is required");
  const absoluteSource = path.resolve(sourceRoot);
  const absoluteDestination = path.resolve(destination);
  assertDirectoryNotSymlink(absoluteSource, "Source");
  assertSafeDestination(absoluteSource, absoluteDestination);
  const records = collectPublicFiles(absoluteSource);
  const manifest = {
    formatVersion: 1,
    license: licenseMetadata(records),
    files: records.map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 })),
  };

  let created = false;
  try {
    fs.mkdirSync(absoluteDestination);
    created = true;
    for (const record of records) {
      const target = path.join(absoluteDestination, ...record.path.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, record.content, { flag: "wx", mode: 0o644 });
    }
    fs.writeFileSync(
      path.join(absoluteDestination, "EXPORT_MANIFEST.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o644 },
    );
  } catch (error) {
    if (created) fs.rmSync(absoluteDestination, { recursive: true, force: true });
    throw error;
  }
  return { destination: absoluteDestination, manifest };
}

function usage() {
  return `Usage: node scripts/export.mjs <new-destination-directory>\n\nCreates an allowlisted public-source copy and EXPORT_MANIFEST.json.\nIt never publishes or contacts an external service.\n`;
}

export function main(argv = process.argv.slice(2), io = process) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    io.stdout.write(usage());
    return 0;
  }
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    io.stderr.write(usage());
    return 2;
  }
  const result = exportPublicSource({ destination: argv[0] });
  io.stdout.write(`Exported ${result.manifest.files.length} allowlisted files to ${result.destination}\n`);
  io.stdout.write(`License status: ${result.manifest.license.status}\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`Export failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
