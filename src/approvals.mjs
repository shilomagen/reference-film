import fs from "node:fs";
import path from "node:path";
import { objectHash, readJson, sha256, writeJson } from "./io.mjs";

export const APPROVAL_KINDS = Object.freeze(["disclosure", "lyrics", "scenes", "media_rights", "spend"]);

export function approvalDirectory(projectDirectory) {
  return path.join(projectDirectory, "workflow", "approvals");
}

function approvalPath(projectDirectory, kind) {
  if (!APPROVAL_KINDS.includes(kind)) throw new Error(`Unknown approval kind '${kind}'`);
  return path.join(approvalDirectory(projectDirectory), `${kind}.json`);
}

export function contentHash(value) {
  return objectHash(value);
}

export function readApproval(projectDirectory, kind) {
  return readJson(approvalPath(projectDirectory, kind), null);
}

export function approveContent(projectDirectory, kind, value, { statement, metadata = {}, clock = () => new Date() } = {}) {
  if (!["disclosure", "lyrics", "scenes", "spend"].includes(kind)) throw new Error(`Content approval is not supported for '${kind}'`);
  if (typeof statement !== "string" || !statement.trim()) throw new Error(`${kind} approval requires an explicit statement`);
  const approval = {
    version: 1,
    kind,
    content_hash: contentHash(value),
    statement: statement.trim(),
    approved_at: clock().toISOString(),
    ...metadata,
  };
  writeJson(approvalPath(projectDirectory, kind), approval);
  return approval;
}

export function approveMediaRights(projectDirectory, files, { statement, clock = () => new Date() } = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("Media rights approval requires at least one file");
  if (typeof statement !== "string" || !statement.trim()) throw new Error("Media rights approval requires an explicit attestation");
  const hashes = {};
  for (const file of files) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Media file does not exist: ${resolved}`);
    hashes[resolved] = sha256(resolved);
  }
  const approval = {
    version: 1,
    kind: "media_rights",
    content_hash: contentHash(hashes),
    statement: statement.trim(),
    files: hashes,
    approved_at: clock().toISOString(),
  };
  writeJson(approvalPath(projectDirectory, "media_rights"), approval);
  return approval;
}

export function approvalCurrent(projectDirectory, kind, value) {
  const approval = readApproval(projectDirectory, kind);
  return Boolean(approval && approval.content_hash === contentHash(value));
}

export function mediaRightsCurrent(projectDirectory, files) {
  const approval = readApproval(projectDirectory, "media_rights");
  if (!approval) return false;
  const hashes = Object.fromEntries(files.map((file) => [path.resolve(file), sha256(path.resolve(file))]));
  return approval.content_hash === contentHash(hashes);
}

export function approvalStatus(projectDirectory, { brief = null, lyrics = null, plan = null, mediaFiles = [] } = {}) {
  return {
    disclosure: brief ? approvalCurrent(projectDirectory, "disclosure", brief) : false,
    lyrics: lyrics ? approvalCurrent(projectDirectory, "lyrics", lyrics) : false,
    scenes: plan ? approvalCurrent(projectDirectory, "scenes", plan) : false,
    media_rights: mediaFiles.length ? mediaRightsCurrent(projectDirectory, mediaFiles) : false,
    spend: Boolean(readApproval(projectDirectory, "spend")),
  };
}
