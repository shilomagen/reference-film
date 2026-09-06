#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadProject, parseArgs } from "./config.mjs";
import { approveArtifact, approveMedia, reconcilePaidOperation, runMedia } from "./media.mjs";

export function parseMediaArgs(argv) {
  const extra = { yes: false, action: null, acknowledgeRights: false, acknowledgeDuplicateRisk: false, sceneId: null, stage: null, checksum: null, operationId: null, reason: null };
  const filtered = [];
  let positionalDryRun = false;
  const valueOptions = new Set(["--scene", "--stage", "--checksum", "--operation-id", "--reason"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "approve-rights" || arg === "approve-artifact" || arg === "reconcile") { extra.action = arg; continue; }
    if (arg === "dry-run") { positionalDryRun = true; continue; }
    if (arg === "--yes") { extra.yes = true; continue; }
    if (arg === "--acknowledge-rights") { extra.acknowledgeRights = true; continue; }
    if (arg === "--acknowledge-duplicate-risk") { extra.acknowledgeDuplicateRisk = true; continue; }
    if (valueOptions.has(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      const key = { "--scene": "sceneId", "--stage": "stage", "--checksum": "checksum", "--operation-id": "operationId", "--reason": "reason" }[arg];
      extra[key] = value;
      continue;
    }
    filtered.push(arg);
  }
  if (extra.action) filtered.unshift("status");
  if (positionalDryRun) filtered.unshift("run", "--dry-run");
  return { options: parseArgs(filtered), extra };
}

export async function main(argv = process.argv.slice(2), io = process) {
  const { options, extra } = parseMediaArgs(argv);
  if (options.help) {
    io.stdout.write("Media CLI: commands run/images/videos/assemble/status/validate plus approve-rights, approve-artifact, reconcile. Paid generation needs --yes; rights approval needs --acknowledge-rights.\n");
    return 0;
  }
  const project = loadProject(options);
  let result;
  if (extra.action === "approve-rights") result = await approveMedia({ ...project, acknowledgeRights: extra.acknowledgeRights });
  else if (extra.action === "approve-artifact") result = await approveArtifact({ ...project, sceneId: extra.sceneId, stage: extra.stage, checksum: extra.checksum });
  else if (extra.action === "reconcile") result = reconcilePaidOperation({ config: project.config, operationId: extra.operationId, reason: extra.reason, acknowledgeDuplicateRisk: extra.acknowledgeDuplicateRisk });
  else result = await runMedia({ command: options.dryRun ? "dry-run" : options.command, ...project, yes: extra.yes });
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main().catch((error) => { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; });
