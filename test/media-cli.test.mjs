import assert from "node:assert/strict";
import test from "node:test";
import { parseMediaArgs } from "../src/media-cli.mjs";

test("media CLI removes approval and spend options before shared parsing", () => {
  const paid = parseMediaArgs(["images", "--yes", "--config", "x.json"]);
  assert.equal(paid.options.command, "images");
  assert.equal(paid.extra.yes, true);
  const approval = parseMediaArgs(["approve-artifact", "--scene", "one", "--stage", "image", "--checksum", "a".repeat(64), "--config", "x.json"]);
  assert.equal(approval.options.command, "status");
  assert.equal(approval.extra.sceneId, "one");
  assert.equal(approval.extra.stage, "image");
  const dry = parseMediaArgs(["dry-run", "--config", "x.json"]);
  assert.equal(dry.options.command, "run");
  assert.equal(dry.options.dryRun, true);
});
