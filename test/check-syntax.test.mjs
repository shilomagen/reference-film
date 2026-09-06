import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkJavaScriptSyntax, findJavaScriptFiles } from "../scripts/check-syntax.mjs";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    output: () => ({ stdout, stderr }),
  };
}

test("syntax checker recursively checks later nested JavaScript files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reference-film-check-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const providers = path.join(directory, "providers");
  fs.mkdirSync(providers);
  fs.writeFileSync(path.join(directory, "first.mjs"), "export const valid = true;\n");
  fs.writeFileSync(path.join(providers, "nested.js"), "const valid = true;\n");
  fs.writeFileSync(path.join(providers, "z-later.mjs"), "export const malformed = ;\n");
  fs.writeFileSync(path.join(providers, "ignored.json"), "not JavaScript");

  assert.deepEqual(findJavaScriptFiles([directory]).map((file) => path.relative(directory, file)), ["first.mjs", path.join("providers", "nested.js"), path.join("providers", "z-later.mjs")]);
  const sink = capture();
  assert.equal(checkJavaScriptSyntax([directory], sink.io), 1);
  assert.match(sink.output().stderr, /z-later\.mjs/);
  assert.match(sink.output().stderr, /failed for 1 of 3 JavaScript files/);
});
