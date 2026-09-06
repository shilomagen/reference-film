import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildImagePrompt } from "../src/prompts.mjs";
import { evaluateImageCandidates, validateImageJudgeResult, validateVideoJudgeResult } from "../src/qa.mjs";

const scene = { scene_id: "pair", characters: ["alpha", "beta"], image_generation: { prompt: "standing together", negative_prompt: "none", aspect_ratio: "16:9" }, video_generation: { scene_description: "wave", prompt: "small wave", camera: "locked", motion: "small", ending_frame: "still" } };
const config = { visualStyle: "soft daylight", characters: { alpha: { description: "fictional person in blue" }, beta: { description: "fictional person in green" } }, inputs: { faces: { alpha: ["a1", "a2"], beta: ["b1"] } }, models: { judge: "judge" }, quality: { judgeEnabled: true, imageIdentityMinimum: 70, imageAnatomyMinimum: 60, imageCharactersMinimum: 65, videoIdentityMinimum: 68, videoStabilityMinimum: 65, rubric: { identity: .45, correct_characters: .15, scene_readability: .12, anatomy: .12, cinematic_style: .10, creative_intent: .06 } } };

function candidate(number, score = 80) { return { candidate: number, identity_scores: { alpha: score, beta: score }, correct_characters: score, scene_readability: score, anatomy: score, cinematic_style: score, creative_intent: score, rejected: false, rejection_reasons: [], notes: "ok" }; }

test("identity prompt maps every ordered reference without demographic invention", () => {
  const prompt = buildImagePrompt({ scene, config, plan: {} });
  assert.match(prompt, /<IMAGE_1>, <IMAGE_2>.*alpha/);
  assert.match(prompt, /<IMAGE_3>.*beta/);
  assert.match(prompt, /soft daylight/);
  for (const inventedTerm of ["wed" + "ding", "man", "woman", "older", "younger"]) assert.equal(prompt.toLowerCase().includes(inventedTerm), false);
});

test("judge validation rejects malformed scores, keys, and numbering", () => {
  assert.throws(() => validateImageJudgeResult({ candidates: [candidate(1), candidate(1)] }, scene.characters, 2), /duplicate/);
  assert.throws(() => validateImageJudgeResult({ candidates: [{ ...candidate(1), anatomy: 80.5 }] }, scene.characters, 1), /finite integer/);
  assert.throws(() => validateImageJudgeResult({ candidates: [{ ...candidate(1), identity_scores: { alpha: 80, beta: 80, extra: 80 } }] }, scene.characters, 1), /exactly/);
  assert.throws(() => validateVideoJudgeResult({ identity_scores: { alpha: 90, beta: 90 }, face_stability: NaN, anatomy: 80, continuity: 80, action_readability: 80, cinematic_quality: 80, rejected: false, rejection_reasons: [], notes: "" }, scene.characters), /finite integer/);
});

test("image QA honors configured rubric and no-judge requires review", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const refs = ["a1", "a2", "b1"].map((name) => path.join(dir, `${name}.png`));
  const candidates = [path.join(dir, "c1.png")];
  for (const file of [...refs, ...candidates]) fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const local = structuredClone(config);
  local.inputs.faces = { alpha: refs.slice(0, 2), beta: refs.slice(2) };
  let sent;
  const result = await evaluateImageCandidates({ client: { async judgeImages(request) { sent = request; return { json: { candidates: [candidate(1)] }, costUsd: null }; } }, config: local, scene, candidatePaths: candidates });
  assert.equal(sent.images.length, 4);
  assert.equal(result.candidates[0].weighted_score, 80);
  assert.equal(result.costUnknown, true);
  local.quality.judgeEnabled = false;
  const manual = await evaluateImageCandidates({ client: null, config: local, scene, candidatePaths: candidates });
  assert.equal(manual.status, "needs_review");
  assert.equal(manual.candidates[0].passed, false);
});
