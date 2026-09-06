import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readJson, validateCanonical, validateSchema } from "../src/schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const examples = [
  ["config", "project.config.json"],
  ["brief", "creator-brief.json"],
  ["lyrics", "lyrics.json"],
  ["plan", "scene-plan.json"],
  ["timings", "timings.json"],
];

for (const [schema, filename] of examples) {
  test(`canonical ${schema} schema accepts its example`, () => {
    const document = readJson(path.join(root, "examples", filename));
    assert.equal(validateCanonical(schema, document), document);
  });
}

test("schema validator rejects malformed and unknown properties clearly", () => {
  assert.throws(() => validateCanonical("timings", { timings: [{ scene_id: "BAD ID", duration_seconds: 0, surprise: true }] }), /scene_id.*does not match|duration_seconds.*must be >|surprise.*not allowed/s);
});

test("bounded schema engine supports every keyword used by canonical schemas", () => {
  const supported = new Set(["$schema", "$id", "title", "type", "additionalProperties", "required", "properties", "pattern", "maxLength", "minLength", "minProperties", "anyOf", "minItems", "maxItems", "items", "const", "enum", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "uniqueItems"]);
  function inspect(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (!["properties"].includes(key) && !supported.has(key) && !/^https?:/.test(key)) throw new Error(`Unsupported schema keyword: ${key}`);
      if (key === "properties") Object.values(child).forEach(inspect);
      else if (key === "additionalProperties" && typeof child === "object") inspect(child);
      else if (key === "items" && typeof child === "object") inspect(child);
      else if (key === "anyOf") child.forEach(inspect);
    }
  }
  for (const filename of fs.readdirSync(path.join(root, "schemas"))) inspect(readJson(path.join(root, "schemas", filename)));
  assert.doesNotThrow(() => validateSchema({ anyOf: [{ const: "a" }, { enum: ["b"] }] }, "b"));
});

test("malformed JSON reports the input path", () => {
  const target = path.join(root, "test", "definitely-malformed.tmp.json");
  fs.writeFileSync(target, "{");
  try {
    assert.throws(() => readJson(target, "fixture"), /fixture is malformed JSON.*definitely-malformed/s);
  } finally {
    fs.rmSync(target, { force: true });
  }
});
