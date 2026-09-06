import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDirectories = ["src", "scripts", "test"].map((directory) => path.join(projectRoot, directory));
const extensions = new Set([".js", ".mjs"]);

function collectJavaScript(entry, files) {
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(entry).sort()) collectJavaScript(path.join(entry, child), files);
  } else if (stat.isFile() && extensions.has(path.extname(entry))) files.push(entry);
}

export function findJavaScriptFiles(entries) {
  const files = [];
  for (const entry of entries) collectJavaScript(path.resolve(entry), files);
  return files.sort();
}

export function checkJavaScriptSyntax(entries, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const files = findJavaScriptFiles(entries);
  let failures = 0;
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);
    if (result.error) stderr.write(`${file}: ${result.error.message}\n`);
    if (result.status !== 0) failures += 1;
  }
  if (failures) {
    stderr.write(`Syntax check failed for ${failures} of ${files.length} JavaScript files.\n`);
    return 1;
  }
  stdout.write(`Syntax checked ${files.length} JavaScript files.\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = process.argv.length > 2 ? process.argv.slice(2).map((entry) => path.resolve(entry)) : defaultDirectories;
  process.exitCode = checkJavaScriptSyntax(entries);
}
