import { toDataUri } from "./io.mjs";
import { directPhotoJudgePrompt, imageJudgePrompt, videoJudgePrompt } from "./prompts.mjs";

const scoreField = Object.freeze({ type: "integer", minimum: 0, maximum: 100 });
const IMAGE_FIELDS = ["correct_characters", "scene_readability", "anatomy", "cinematic_style", "creative_intent"];
const VIDEO_FIELDS = ["face_stability", "anatomy", "continuity", "action_readability", "cinematic_quality"];

function identitySchema(characters) {
  return { type: "object", additionalProperties: false, properties: Object.fromEntries(characters.map((name) => [name, scoreField])), required: [...characters] };
}

export function imageQaSchema(characters, count) {
  const scoreProperties = Object.fromEntries(IMAGE_FIELDS.map((key) => [key, scoreField]));
  const candidate = {
    type: "object", additionalProperties: false,
    properties: {
      candidate: { type: "integer", minimum: 1, maximum: count },
      identity_scores: identitySchema(characters), ...scoreProperties,
      rejected: { type: "boolean" },
      rejection_reasons: { type: "array", items: { type: "string" } },
      notes: { type: "string" },
    },
    required: ["candidate", "identity_scores", ...IMAGE_FIELDS, "rejected", "rejection_reasons", "notes"],
  };
  return {
    name: "image_candidate_evaluation",
    value: {
      type: "object", additionalProperties: false,
      properties: { candidates: { type: "array", minItems: count, maxItems: count, items: candidate } },
      required: ["candidates"],
    },
  };
}

export function videoQaSchema(characters) {
  const properties = Object.fromEntries(VIDEO_FIELDS.map((key) => [key, scoreField]));
  return { name: "video_frame_evaluation", value: { type: "object", additionalProperties: false, properties: { identity_scores: identitySchema(characters), ...properties, rejected: { type: "boolean" }, rejection_reasons: { type: "array", items: { type: "string" } }, notes: { type: "string" } }, required: ["identity_scores", ...VIDEO_FIELDS, "rejected", "rejection_reasons", "notes"] } };
}

export function directPhotoQaSchema() {
  const fields = ["group_identity_preservation", "person_count_stability", ...VIDEO_FIELDS];
  return { name: "direct_photo_video_evaluation", value: { type: "object", additionalProperties: false, properties: { ...Object.fromEntries(fields.map((key) => [key, scoreField])), rejected: { type: "boolean" }, rejection_reasons: { type: "array", items: { type: "string" } }, notes: { type: "string" } }, required: [...fields, "rejected", "rejection_reasons", "notes"] } };
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function exactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
}

function score(value, label) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${label} must be a finite integer from 0 to 100`);
  return value;
}

function common(value, fields, label) {
  assertPlainObject(value, label);
  for (const field of fields) score(value[field], `${label}.${field}`);
  if (typeof value.rejected !== "boolean") throw new Error(`${label}.rejected must be boolean`);
  if (!Array.isArray(value.rejection_reasons) || value.rejection_reasons.some((item) => typeof item !== "string")) throw new Error(`${label}.rejection_reasons must be strings`);
  if (typeof value.notes !== "string") throw new Error(`${label}.notes must be a string`);
}

function identities(value, characters, label) {
  exactKeys(value, characters, label);
  for (const name of characters) score(value[name], `${label}.${name}`);
  return Math.min(...characters.map((name) => value[name]));
}

export function validateImageJudgeResult(value, characters, count) {
  exactKeys(value, ["candidates"], "image judge result");
  if (!Array.isArray(value.candidates) || value.candidates.length !== count) throw new Error(`Judge returned ${value.candidates?.length ?? 0} candidates; expected ${count}`);
  const numbers = new Set();
  for (const candidate of value.candidates) {
    exactKeys(candidate, ["candidate", "identity_scores", ...IMAGE_FIELDS, "rejected", "rejection_reasons", "notes"], "image candidate");
    common(candidate, IMAGE_FIELDS, `candidate ${candidate.candidate}`);
    score(candidate.candidate, "candidate number");
    if (candidate.candidate < 1 || candidate.candidate > count || numbers.has(candidate.candidate)) throw new Error("Judge returned duplicate, missing, or out-of-range candidate numbers");
    numbers.add(candidate.candidate);
    identities(candidate.identity_scores, characters, `candidate ${candidate.candidate}.identity_scores`);
  }
  if (numbers.size !== count || Array.from({ length: count }, (_, index) => index + 1).some((number) => !numbers.has(number))) throw new Error("Judge returned duplicate or missing candidate numbers");
  return value;
}

export function validateVideoJudgeResult(value, characters, { direct = false } = {}) {
  const fields = direct ? ["group_identity_preservation", "person_count_stability", ...VIDEO_FIELDS] : ["identity_scores", ...VIDEO_FIELDS];
  exactKeys(value, [...fields, "rejected", "rejection_reasons", "notes"], "video judge result");
  common(value, direct ? fields : VIDEO_FIELDS, "video judge result");
  if (!direct) identities(value.identity_scores, characters, "video identity_scores");
  return value;
}

function judgeJson(response) {
  if (response?.json !== null && response?.json !== undefined) return response.json;
  if (typeof response?.text === "string") {
    try { return JSON.parse(response.text); } catch { throw new Error("Judge returned invalid JSON"); }
  }
  throw new Error("Judge did not return JSON");
}

function costs(response) {
  return { costUsd: Number.isFinite(response?.costUsd) ? response.costUsd : null, costUnknown: !Number.isFinite(response?.costUsd) };
}

export function imageQaFingerprint(config) {
  return { judgeEnabled: config.quality.judgeEnabled, judgeModel: config.models.judge, thresholds: { identity: config.quality.imageIdentityMinimum, anatomy: config.quality.imageAnatomyMinimum, characters: config.quality.imageCharactersMinimum }, rubric: config.quality.rubric };
}

export function videoQaFingerprint(config, { direct = false } = {}) {
  return { judgeEnabled: config.quality.judgeEnabled, judgeModel: config.models.judge, thresholds: { identity: config.quality.videoIdentityMinimum, stability: config.quality.videoStabilityMinimum, anatomy: 60, continuity: 60, personCount: direct ? 80 : null }, direct };
}

export async function evaluateImageCandidates({ client, config, scene, candidatePaths }) {
  if (!config.quality.judgeEnabled) return { automatedJudge: false, status: "needs_review", passed: false, candidates: candidatePaths.map((_, index) => ({ candidate: index + 1, passed: false, needs_review: true, rejection_reasons: [], notes: "Automated judging disabled; checksum-bound manual approval required." })), costUsd: 0, costUnknown: false };
  const references = scene.characters.flatMap((name) => config.inputs.faces[name]);
  const response = await client.judgeImages({ model: config.models.judge, prompt: imageJudgePrompt(scene, candidatePaths.length, config), images: [...references, ...candidatePaths].map(toDataUri), schema: imageQaSchema(scene.characters, candidatePaths.length) });
  const parsed = validateImageJudgeResult(judgeJson(response), scene.characters, candidatePaths.length);
  const rubric = config.quality.rubric;
  const candidates = [...parsed.candidates].sort((a, b) => a.candidate - b.candidate).map((candidate) => {
    const minimum_identity = Math.min(...scene.characters.map((name) => candidate.identity_scores[name]));
    const weighted_score = Number((minimum_identity * rubric.identity + IMAGE_FIELDS.reduce((total, field) => total + candidate[field] * rubric[field], 0)).toFixed(2));
    const threshold_failures = [];
    if (minimum_identity < config.quality.imageIdentityMinimum) threshold_failures.push(`identity ${minimum_identity} < ${config.quality.imageIdentityMinimum}`);
    if (candidate.anatomy < config.quality.imageAnatomyMinimum) threshold_failures.push(`anatomy ${candidate.anatomy} < ${config.quality.imageAnatomyMinimum}`);
    if (candidate.correct_characters < config.quality.imageCharactersMinimum) threshold_failures.push(`correct_characters ${candidate.correct_characters} < ${config.quality.imageCharactersMinimum}`);
    return { ...candidate, minimum_identity, weighted_score, threshold_failures, passed: !candidate.rejected && threshold_failures.length === 0 };
  });
  return { automatedJudge: true, model: response.model ?? config.models.judge, candidates, ...costs(response) };
}

export async function evaluateVideoFrames({ client, config, scene, sourceStill, framePaths }) {
  if (!config.quality.judgeEnabled) return { automatedJudge: false, status: "needs_review", passed: false, needs_review: true, notes: "Automated judging disabled; checksum-bound manual approval required.", costUsd: 0, costUnknown: false };
  const direct = scene.source_image_mode === "direct_animation";
  const references = direct ? [] : scene.characters.flatMap((name) => config.inputs.faces[name]);
  const response = await client.judgeImages({ model: config.models.judge, prompt: direct ? directPhotoJudgePrompt(scene, framePaths.length) : videoJudgePrompt(scene, framePaths.length, config), images: [...references, sourceStill, ...framePaths].map(toDataUri), schema: direct ? directPhotoQaSchema() : videoQaSchema(scene.characters) });
  const parsed = validateVideoJudgeResult(judgeJson(response), scene.characters, { direct });
  const minimum_identity = direct ? parsed.group_identity_preservation : Math.min(...scene.characters.map((name) => parsed.identity_scores[name]));
  const threshold_failures = [];
  if (minimum_identity < config.quality.videoIdentityMinimum) threshold_failures.push(`identity ${minimum_identity} < ${config.quality.videoIdentityMinimum}`);
  if (parsed.face_stability < config.quality.videoStabilityMinimum) threshold_failures.push(`face_stability ${parsed.face_stability} < ${config.quality.videoStabilityMinimum}`);
  if (parsed.anatomy < 60) threshold_failures.push("anatomy < 60");
  if (parsed.continuity < 60) threshold_failures.push("continuity < 60");
  if (direct && parsed.person_count_stability < 80) threshold_failures.push("person_count_stability < 80");
  return { ...parsed, automatedJudge: true, model: response.model ?? config.models.judge, minimum_identity, threshold_failures, passed: !parsed.rejected && threshold_failures.length === 0, ...costs(response) };
}

export function chooseCandidate(evaluations) {
  const passing = evaluations.filter((candidate) => candidate.passed);
  const pool = passing.length ? passing : evaluations;
  return [...pool].sort((a, b) => (b.weighted_score ?? -1) - (a.weighted_score ?? -1) || a.candidate - b.candidate)[0];
}
