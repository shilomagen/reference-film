import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Return whether an ES module is the script Node was asked to execute.
 * Both paths are canonicalized so file symlinks, directory symlinks, and
 * platform aliases such as macOS /tmp -> /private/tmp compare correctly.
 */
export function isMain(importMetaUrl, argvEntry = process.argv[1]) {
  if (!argvEntry) return false;
  try {
    return fs.realpathSync(fileURLToPath(importMetaUrl)) === fs.realpathSync(path.resolve(argvEntry));
  } catch {
    return false;
  }
}
