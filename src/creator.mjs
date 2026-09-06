import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { approvalCurrent, approvalStatus, approveContent, approveMediaRights, readApproval } from "./approvals.mjs";
import { compileLyricsPrompt, compileStoryboardPrompt, lyricsContract, storyboardContract } from "./creative-prompts.mjs";
import { objectHash, readJson, sanitizeMetadata, writeJson } from "./io.mjs";
import { approveMedia } from "./media.mjs";
import { createProviderRegistry } from "./providers/index.mjs";
import { createPaidOperationJournal } from "./providers/journal.mjs";
import { validateCanonical } from "./schema.mjs";

export const CREATOR_FILES = Object.freeze({
  brief: "brief.json", lyrics: "lyrics.json", lyricsPreview: "lyrics.md", musicBrief: "music-brief.md",
  plan: "scene-plan.json", config: "project.config.json",
});

const PRIVATE_IGNORE_ENTRIES = Object.freeze([
  ".private/", "brief.json", "lyrics.json", "lyrics.md", "music-brief.md", "scene-plan.json", "project.config.json", "workflow/",
]);
const BLOCKING_OPERATION_STATES = new Set(["submission_started", "accepted", "uncertain", "retry_authorized"]);

function splitList(value) {
  return String(value ?? "").split(/\s*[;|]\s*/u).map((item) => item.trim()).filter(Boolean);
}

function slug(value, separator = "-") {
  return String(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, separator).replace(new RegExp(`^\\${separator}+|\\${separator}+$`, "g"), "").slice(0, 64);
}

function parseIdentity(value) {
  const [displayName, pronouns = "", characterId = ""] = String(value).split("|").map((item) => item.trim());
  if (!displayName) throw new Error("Subject name is required");
  const id = characterId || slug(displayName, "_");
  if (!id) throw new Error("Provide an ASCII character ID after the second |, for example: 名前||subject");
  return { character_id: id, display_name: displayName, ...(pronouns ? { pronouns } : {}), reference_files: [] };
}

function parseSupporting(value) {
  if (!String(value).trim()) return [];
  return splitList(value).map((item) => {
    const [displayName, relationship = "supporting person", pronouns = "", explicitId = ""] = item.split("~").map((part) => part.trim());
    const characterId = explicitId || slug(displayName, "_");
    if (!displayName || !characterId) throw new Error("Supporting people use Name~relationship~pronouns~ascii_id, separated by ;");
    return { character_id: characterId, display_name: displayName, ...(pronouns ? { pronouns } : {}), relationship, reference_files: [] };
  });
}

export const QUESTIONNAIRE = Object.freeze([
  "1/6 Subject: display name | optional pronouns | optional ASCII character_id: ",
  "2/6 Occasion, your relationship, and intended message (occasion | relationship | message): ",
  "3/6 True memories/details/personality/interests (four | groups; items separated by ;): ",
  "4/6 Supporting people (Name~relationship~pronouns~id; ...), or blank: ",
  "5/6 Language and music (language | characteristics separated by ; | tone | seconds): ",
  "6/6 Boundaries separated by ;, then type CONSENT after | to allow disclosure to the configured text provider: ",
]);

export function briefFromAnswers(answers, { projectSlug } = {}) {
  if (!Array.isArray(answers) || answers.length !== 6) throw new Error("Exactly six questionnaire answers are required");
  const subject = parseIdentity(answers[0]);
  const [occasion, relationship, intendedMessage] = String(answers[1]).split("|").map((item) => item.trim());
  const factGroups = String(answers[2]).split("|").map(splitList);
  if (!occasion || !relationship || !intendedMessage || factGroups.length !== 4) throw new Error("Answer 2 needs occasion | relationship | message and answer 3 needs four | groups");
  const supportingCharacters = parseSupporting(answers[3]);
  const [language, characteristicsRaw, tone, durationRaw] = String(answers[4]).split("|").map((item) => item.trim());
  const duration = Number(durationRaw);
  const consentParts = String(answers[5]).split("|");
  const consentToken = consentParts.pop()?.trim();
  const boundaries = splitList(consentParts.join("|"));
  if (consentToken !== "CONSENT") throw new Error("Consent is not inferred: answer 6 must end with | CONSENT");
  const ids = [subject.character_id, ...supportingCharacters.map((item) => item.character_id)];
  if (new Set(ids).size !== ids.length) throw new Error("Character IDs must be unique");
  const brief = {
    project_slug: projectSlug || slug(subject.display_name), subject, occasion, relationship,
    intended_message: intendedMessage,
    facts: { memories: factGroups[0], details: factGroups[1], personality: factGroups[2], interests: factGroups[3] },
    supporting_characters: supportingCharacters,
    language,
    music: { characteristics: splitList(characteristicsRaw), tone, target_duration_seconds: duration },
    boundaries,
    consent: { personal_details_provider_disclosure: true, statement: "Creator explicitly consented to provider disclosure." },
  };
  return validateCanonical("brief", brief, "creator brief");
}

export async function askSixQuestions({ ask } = {}) {
  if (ask) {
    const answers = [];
    for (const question of QUESTIONNAIRE) answers.push(await ask(question));
    return answers;
  }
  const terminal = readline.createInterface({ input, output });
  try {
    const answers = [];
    for (const question of QUESTIONNAIRE) answers.push(await terminal.question(question));
    return answers;
  } finally { terminal.close(); }
}

function ensureNew(file, force) {
  if (!fs.existsSync(file)) return;
  if (!force) throw new Error(`Refusing to overwrite edited file: ${file}. Pass --force only after reviewing it.`);
}

function creatorPaths(projectDirectory) {
  const root = path.resolve(projectDirectory);
  return Object.fromEntries(Object.entries(CREATOR_FILES).map(([key, file]) => [key, path.join(root, file)]));
}

function characterEntries(brief) {
  return [brief.subject, ...brief.supporting_characters];
}

function ensurePrivateGitignore(projectDirectory) {
  const target = path.join(projectDirectory, ".gitignore");
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const additions = PRIVATE_IGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (!additions.length) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(target, `${prefix}${existing ? "\n" : ""}# Reference Film private creator workspace\n${additions.join("\n")}\n`, { mode: 0o600 });
}

function generatedConfig(brief) {
  const characters = Object.fromEntries(characterEntries(brief).map((person) => [person.character_id, {
    description: `${person.display_name}${person.pronouns ? ` (${person.pronouns})` : ""}. ${person.relationship ?? "Primary subject"}.`,
  }]));
  const faces = Object.fromEntries(characterEntries(brief).map((person) => [person.character_id, []]));
  return {
    metadata: { slug: brief.project_slug, title: `Film for ${brief.subject.display_name}`, description: brief.intended_message },
    visualStyle: "Cinematic, coherent, respectful, natural light, no visible text, and only supplied identity facts.",
    characters,
    inputs: { plan: CREATOR_FILES.plan, brief: CREATOR_FILES.brief, lyrics: CREATOR_FILES.lyrics, faces, audioCandidates: [] },
    outputs: path.join(".private", brief.project_slug, "outputs"),
    providers: { text: "xai", image: "xai", judge: "xai", video: "xai" },
    models: { text: "SET_ME_XAI_TEXT_MODEL", image: "SET_ME_XAI_IMAGE_MODEL", judge: "SET_ME_XAI_JUDGE_MODEL", video: "SET_ME_XAI_VIDEO_MODEL", geminiVideo: "SET_ME_GEMINI_VIDEO_MODEL" },
    generation: { textMaxOutputTokens: 12000, imageResolution: "2k", imageQuality: "medium", videoResolution: "720p", videoAudioPolicy: "disabled" },
  };
}

export function initializeCreatorProject({ projectDirectory, brief, force = false }) {
  validateCanonical("brief", brief, "creator brief");
  const paths = creatorPaths(projectDirectory);
  fs.mkdirSync(path.resolve(projectDirectory), { recursive: true });
  ensurePrivateGitignore(path.resolve(projectDirectory));
  ensureNew(paths.brief, force);
  ensureNew(paths.config, force);
  writeJson(paths.brief, brief);
  writeJson(paths.config, generatedConfig(brief));
  return paths;
}

export function renderLyricsMarkdown(lyrics) {
  return `# ${lyrics.title}\n\n> Preview generated from lyrics.json. Edit lyrics.json, not this file.\n\n${lyrics.sections.map((section) => `## ${section.label}\n\n${section.lines.map((line) => line.text).join("  \n")}`).join("\n\n")}\n`;
}

export function renderMusicBrief(lyrics) {
  return `# Music direction for ${lyrics.title}\n\n${lyrics.music_direction}\n\nSupply the finished, properly licensed song as a local audio file in project.config.json. This project does not call a music-generation API.\n`;
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function previewsCanBeReplaced(paths) {
  if (!fs.existsSync(paths.lyrics)) return !fs.existsSync(paths.lyricsPreview) && !fs.existsSync(paths.musicBrief);
  let previous;
  try { previous = validateLyricsSemantics(readJson(paths.lyrics)); } catch { return false; }
  const expected = [[paths.lyricsPreview, renderLyricsMarkdown(previous)], [paths.musicBrief, renderMusicBrief(previous)]];
  return expected.every(([file, content]) => !fs.existsSync(file) || fs.readFileSync(file, "utf8") === content);
}

export function validateLyricsSemantics(lyrics) {
  validateCanonical("lyrics", lyrics, "lyrics");
  const sections = new Set();
  const lines = new Set();
  for (const section of lyrics.sections) {
    if (sections.has(section.section_id)) throw new Error(`Duplicate lyrics section_id '${section.section_id}'`);
    sections.add(section.section_id);
    for (const line of section.lines) {
      if (lines.has(line.line_id)) throw new Error(`Duplicate lyrics line_id '${line.line_id}'`);
      lines.add(line.line_id);
    }
  }
  return lyrics;
}

function lyricIndex(lyrics) {
  const list = [];
  const repeatable = new Set();
  for (const section of lyrics.sections) for (const line of section.lines) {
    list.push({ ...line, section_id: section.section_id });
    if (section.repeat) repeatable.add(line.line_id);
  }
  return { list, byId: new Map(list.map((line) => [line.line_id, line])), repeatable };
}

export function validateStoryboardSemantics(plan, { lyrics, characterIds, allowedSourceFiles = [], sourceRoot = process.cwd() }) {
  validateCanonical("plan", plan, "scene plan");
  if (plan.video.scenes.length > 120) throw new Error("Storyboard exceeds 120 scenes");
  const knownCharacters = new Set(characterIds);
  const allowedFiles = new Set(allowedSourceFiles.map((file) => path.resolve(file)));
  const sceneIds = new Set();
  const { list, byId, repeatable } = lyricIndex(lyrics);
  const observed = [];
  const counts = new Map();
  for (const scene of plan.video.scenes) {
    if (sceneIds.has(scene.scene_id)) throw new Error(`Duplicate scene_id '${scene.scene_id}'`);
    sceneIds.add(scene.scene_id);
    for (const id of scene.characters) if (!knownCharacters.has(id)) throw new Error(`Scene '${scene.scene_id}' references unknown character '${id}'`);
    if (scene.source_image) {
      if (scene.source_image_mode !== "direct_animation") throw new Error(`Scene '${scene.scene_id}' source_image requires direct_animation`);
      if (!allowedFiles.has(path.resolve(sourceRoot, scene.source_image))) throw new Error(`Scene '${scene.scene_id}' invented or unauthorized source_image`);
    }
    const expectedText = scene.lyric_ids.map((id) => {
      if (!byId.has(id)) throw new Error(`Scene '${scene.scene_id}' references unknown lyric_id '${id}'`);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      observed.push(id);
      return byId.get(id).text;
    }).join(" / ");
    if (scene.lyrics !== expectedText) throw new Error(`Scene '${scene.scene_id}' lyrics do not match its lyric_ids`);
  }
  for (const line of list) {
    const count = counts.get(line.line_id) ?? 0;
    if (count === 0) throw new Error(`Storyboard does not cover lyric_id '${line.line_id}'`);
    if (count > 1 && !repeatable.has(line.line_id)) throw new Error(`lyric_id '${line.line_id}' repeats without explicit repeat=true`);
  }
  let position = -1;
  for (const id of observed) {
    const next = list.findIndex((line, index) => index >= position && line.line_id === id);
    if (next < position && !repeatable.has(id)) throw new Error("Storyboard lyric_ids are out of intended order");
    if (next >= 0) position = next;
  }
  return plan;
}

function invalidOutputPath(projectDirectory, stage) {
  return path.join(projectDirectory, "workflow", "invalid", `${stage}-${Date.now()}.json`);
}

function saveInvalid(projectDirectory, stage, value, error, secrets = []) {
  const target = invalidOutputPath(projectDirectory, stage);
  writeJson(target, sanitizeMetadata({ stage, error: error.message, output: value }, { secrets }));
  return target;
}

function workflowJournal(projectDirectory) {
  return createPaidOperationJournal(path.join(projectDirectory, "workflow", "journal"));
}

function provenancePath(projectDirectory, stage) {
  return path.join(projectDirectory, "workflow", "provenance", `${stage}.json`);
}

function generationEpoch(projectDirectory, stage, force) {
  const previous = readJson(provenancePath(projectDirectory, stage), null);
  return force ? Number(previous?.generation_epoch ?? 0) + 1 : Number(previous?.generation_epoch ?? 1);
}

function stageFingerprint(stage, { config, prompt, brief, lyrics = null }) {
  return objectHash({ version: 1, stage, model: config.models.text, prompt, brief, lyrics, maxOutputTokens: config.generation?.textMaxOutputTokens ?? null });
}

function currentProvenance(projectDirectory, stage, fingerprint, artifact) {
  const provenance = readJson(provenancePath(projectDirectory, stage), null);
  return Boolean(provenance?.fingerprint === fingerprint && provenance?.artifact_hash === objectHash(artifact));
}

function writeProvenance(projectDirectory, stage, { fingerprint, epoch, artifact, model }) {
  writeJson(provenancePath(projectDirectory, stage), {
    version: 1, stage, fingerprint, generation_epoch: epoch, artifact_hash: objectHash(artifact), model,
    recorded_at: new Date().toISOString(),
  });
}

function assertNoUnresolvedCreatorOperations(projectDirectory) {
  const directory = path.join(projectDirectory, "workflow", "journal");
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const entry = readJson(path.join(directory, name), null);
    if (entry && BLOCKING_OPERATION_STATES.has(entry.state)) {
      throw new Error(`Paid operation ${entry.id} is ${entry.state}; resolve or explicitly reconcile it before --force regeneration.`);
    }
  }
}

function textRegistry(config, dependencies, projectDirectory) {
  if (dependencies.textAdapter) return { text: dependencies.textAdapter, models: { text: config.models.text } };
  return createProviderRegistry(config, { ...dependencies, journal: dependencies.journal ?? workflowJournal(projectDirectory) });
}

function disclosureCurrent(projectDirectory, brief) {
  return approvalCurrent(projectDirectory, "disclosure", brief);
}

function lyricsApprovalCurrent(projectDirectory, brief, lyrics) {
  const approval = readApproval(projectDirectory, "lyrics");
  return disclosureCurrent(projectDirectory, brief) && approvalCurrent(projectDirectory, "lyrics", lyrics) && approval?.brief_hash === objectHash(brief);
}

function scenesApprovalCurrent(projectDirectory, brief, lyrics, plan) {
  const approval = readApproval(projectDirectory, "scenes");
  const document = plan.video ? plan : { video: { title: plan.title, ...(plan.description === undefined ? {} : { description: plan.description }), scenes: plan.allScenes } };
  return lyricsApprovalCurrent(projectDirectory, brief, lyrics) && approvalCurrent(projectDirectory, "scenes", document)
    && approval?.brief_hash === objectHash(brief) && approval?.lyrics_hash === objectHash(lyrics);
}

function requireConfiguredTextModel(config) {
  if (/^(?:example-|SET_ME_)/i.test(config.models.text)) throw new Error("Configure a real text model before a paid request; example/SET_ME model names are placeholders and offline validation does not check provider availability.");
}

function requireSpendAndDisclosure(projectDirectory, brief, yes, spendDetails) {
  if (!disclosureCurrent(projectDirectory, brief)) throw new Error("Personal-input/provider-disclosure approval is required. Run approve --stage disclosure.");
  if (!yes) throw new Error("Text generation is a potentially paid request with unknown cost. Re-run with --yes to acknowledge spend (editorial approval is separate).");
  approveContent(projectDirectory, "spend", spendDetails, { statement: "Acknowledged potentially paid text request with unknown cost.", metadata: { stage: spendDetails.stage } });
}

function outputJson(result) {
  if (result?.reused && !result.json) throw new Error("Journal says this request completed but no generated artifact is available; reconcile local artifacts manually, do not resubmit.");
  if (!result || !result.json || typeof result.json !== "object") throw new Error("Text provider returned malformed or refused structured output");
  return result.json;
}

export async function generateLyrics({ projectDirectory, config, brief, yes = false, dryRun = false, force = false, dependencies = {} }) {
  const paths = creatorPaths(projectDirectory);
  const prompt = compileLyricsPrompt(brief);
  const fingerprint = stageFingerprint("lyrics", { config, prompt, brief });
  if (dryRun) return { dryRun: true, networkCalls: 0, estimatedTextRequests: 1, estimatedCost: "unknown", prompt, fingerprint, schema: lyricsContract().value, output: paths.lyrics };
  requireSpendAndDisclosure(projectDirectory, brief, yes, { stage: "lyrics", model: config.models.text, prompt_hash: objectHash(prompt), estimated_requests: 1, estimated_cost: "unknown" });
  if (!dependencies.textAdapter) requireConfiguredTextModel(config);
  if (fs.existsSync(paths.lyrics) && !force) {
    const lyrics = validateLyricsSemantics(readJson(paths.lyrics));
    if (!currentProvenance(projectDirectory, "lyrics", fingerprint, lyrics)) throw new Error("Existing lyrics.json is an editable draft but does not match the current brief, prompt, model, or recorded content. Review it and approve it manually, or regenerate with --force.");
    return { reused: true, lyrics };
  }
  ensureNew(paths.lyrics, force);
  if ((force || fs.existsSync(paths.lyricsPreview) || fs.existsSync(paths.musicBrief)) && !previewsCanBeReplaced(paths)) throw new Error("Refusing to overwrite an edited lyrics.md or music-brief.md preview");
  if (force) assertNoUnresolvedCreatorOperations(projectDirectory);
  const epoch = generationEpoch(projectDirectory, "lyrics", force);
  const registry = textRegistry(config, dependencies, projectDirectory);
  let value;
  try {
    value = outputJson(await registry.text.generateText({ model: registry.models.text, prompt, schema: lyricsContract(), operationKey: `creator/lyrics/${fingerprint}/generation-${epoch}` }));
    validateLyricsSemantics(value);
  } catch (error) {
    error.invalidArtifact = saveInvalid(projectDirectory, "lyrics", value ?? null, error, Object.values(config.credentials ?? {}));
    throw error;
  }
  writeJson(paths.lyrics, value);
  writeTextAtomic(paths.lyricsPreview, renderLyricsMarkdown(value));
  writeTextAtomic(paths.musicBrief, renderMusicBrief(value));
  writeProvenance(projectDirectory, "lyrics", { fingerprint, epoch, artifact: value, model: config.models.text });
  return { reused: false, lyrics: value };
}

export async function generateStoryboard({ projectDirectory, config, brief, lyrics, yes = false, dryRun = false, force = false, dependencies = {} }) {
  const paths = creatorPaths(projectDirectory);
  const suppliedSourceFiles = Object.values(config.inputs.faces ?? {}).flat().map((file) => path.resolve(file));
  const characters = characterEntries(brief).map(({ character_id, display_name, pronouns, relationship }) => ({ character_id, display_name, pronouns, relationship }));
  const prompt = compileStoryboardPrompt({ brief, lyrics, characters, suppliedSourceFiles });
  const fingerprint = stageFingerprint("storyboard", { config, prompt, brief, lyrics });
  if (dryRun) return { dryRun: true, networkCalls: 0, estimatedTextRequests: 1, estimatedCost: "unknown", prompt, fingerprint, schema: storyboardContract().value, output: paths.plan };
  if (!lyricsApprovalCurrent(projectDirectory, brief, lyrics)) throw new Error("Current lyrics require editorial approval tied to the current brief. Run approve --stage lyrics.");
  if (!dependencies.textAdapter) requireConfiguredTextModel(config);
  if (!yes) throw new Error("Storyboard generation is a potentially paid request with unknown cost. Re-run with --yes to acknowledge spend.");
  approveContent(projectDirectory, "spend", { stage: "storyboard", model: config.models.text, prompt_hash: objectHash(prompt), estimated_requests: 1, estimated_cost: "unknown" }, { statement: "Acknowledged potentially paid text request with unknown cost.", metadata: { stage: "storyboard" } });
  if (fs.existsSync(paths.plan) && !force) {
    const plan = validateStoryboardSemantics(readJson(paths.plan), { lyrics, characterIds: characters.map((item) => item.character_id), allowedSourceFiles: suppliedSourceFiles, sourceRoot: projectDirectory });
    if (!currentProvenance(projectDirectory, "storyboard", fingerprint, plan)) throw new Error("Existing scene-plan.json is an editable draft but does not match the current brief, lyrics, prompt, model, or recorded content. Review and approve it manually, or regenerate with --force.");
    return { reused: true, plan };
  }
  ensureNew(paths.plan, force);
  if (force) assertNoUnresolvedCreatorOperations(projectDirectory);
  const epoch = generationEpoch(projectDirectory, "storyboard", force);
  const registry = textRegistry(config, dependencies, projectDirectory);
  let value;
  try {
    value = outputJson(await registry.text.generateText({ model: registry.models.text, prompt, schema: storyboardContract(), operationKey: `creator/storyboard/${fingerprint}/generation-${epoch}` }));
    validateStoryboardSemantics(value, { lyrics, characterIds: characters.map((item) => item.character_id), allowedSourceFiles: suppliedSourceFiles, sourceRoot: projectDirectory });
  } catch (error) {
    error.invalidArtifact = saveInvalid(projectDirectory, "storyboard", value ?? null, error, Object.values(config.credentials ?? {}));
    throw error;
  }
  writeJson(paths.plan, value);
  writeProvenance(projectDirectory, "storyboard", { fingerprint, epoch, artifact: value, model: config.models.text });
  return { reused: false, plan: value };
}

export async function approveCreatorStage({ projectDirectory, stage, acknowledgeRights = false, statement = "Approved after local review.", config = null, plan = null }) {
  const paths = creatorPaths(projectDirectory);
  if (stage === "disclosure") {
    const brief = validateCanonical("brief", readJson(paths.brief), "creator brief");
    if (!brief.consent.personal_details_provider_disclosure) throw new Error("Brief does not contain explicit disclosure consent");
    return approveContent(projectDirectory, "disclosure", brief, { statement });
  }
  if (stage === "lyrics") {
    const brief = validateCanonical("brief", readJson(paths.brief), "creator brief");
    if (!disclosureCurrent(projectDirectory, brief)) throw new Error("Approve disclosure for the current brief before lyrics");
    return approveContent(projectDirectory, "lyrics", validateLyricsSemantics(readJson(paths.lyrics)), { statement, metadata: { brief_hash: objectHash(brief) } });
  }
  if (stage === "scenes") {
    const brief = validateCanonical("brief", readJson(paths.brief), "creator brief");
    const lyrics = validateLyricsSemantics(readJson(paths.lyrics));
    const plan = readJson(paths.plan);
    validateStoryboardSemantics(plan, { lyrics, characterIds: characterEntries(brief).map((item) => item.character_id), allowedSourceFiles: config ? Object.values(config.inputs.faces).flat() : characterEntries(brief).flatMap((item) => item.reference_files).map((file) => path.resolve(projectDirectory, file)), sourceRoot: projectDirectory });
    if (!lyricsApprovalCurrent(projectDirectory, brief, lyrics)) throw new Error("Approve lyrics tied to the current brief before scenes");
    return approveContent(projectDirectory, "scenes", plan, { statement, metadata: { brief_hash: objectHash(brief), lyrics_hash: objectHash(lyrics) } });
  }
  if (stage === "rights") {
    if (!acknowledgeRights) throw new Error("Media rights approval requires --acknowledge-rights");
    if (!config || !plan) throw new Error("Rights approval requires the complete normalized project; supply a valid config, plan, references, direct photos, and selected audio.");
    const files = [
      ...Object.values(config.inputs.faces).flat(),
      ...plan.allScenes.flatMap((scene) => scene.source_image ? [scene.source_image] : []),
      ...(config.audio ? [config.audio] : []),
    ];
    const mediaApproval = await approveMedia({ config, plan, acknowledgeRights: true });
    const creatorApproval = approveMediaRights(projectDirectory, files, { statement });
    return { creatorApproval, mediaApproval };
  }
  throw new Error("--stage must be disclosure, lyrics, scenes, or rights");
}

export function reconcileCreatorOperation({ projectDirectory, operationId, reason, acknowledgeDuplicateRisk }) {
  if (!operationId || !reason || !acknowledgeDuplicateRisk) throw new Error("Reconcile requires --operation, --reason, and --acknowledge-duplicate-risk");
  return workflowJournal(projectDirectory).authorizeRetry(operationId, reason, { acknowledgeDuplicateRisk: true });
}

export function creatorStatus(projectDirectory) {
  const paths = creatorPaths(projectDirectory);
  const brief = readJson(paths.brief, null);
  const lyrics = readJson(paths.lyrics, null);
  const plan = readJson(paths.plan, null);
  const config = readJson(paths.config, null);
  const configuredFiles = config ? [
    ...Object.values(config.inputs?.faces ?? {}).flat().map((file) => path.resolve(projectDirectory, file)),
    ...(plan?.video?.scenes ?? []).flatMap((scene) => scene.source_image ? [path.resolve(projectDirectory, scene.source_image)] : []),
    ...(config.inputs?.audioCandidates ?? []).map((file) => path.resolve(projectDirectory, file)).filter((file) => fs.existsSync(file)),
  ] : [];
  return {
    files: Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, fs.existsSync(file)])),
    approvals: {
      disclosure: brief ? disclosureCurrent(projectDirectory, brief) : false,
      lyrics: brief && lyrics ? lyricsApprovalCurrent(projectDirectory, brief, lyrics) : false,
      scenes: brief && lyrics && plan ? scenesApprovalCurrent(projectDirectory, brief, lyrics, plan) : false,
      media_rights: configuredFiles.length > 0 && configuredFiles.every((file) => fs.existsSync(file)) ? approvalStatus(projectDirectory, { mediaFiles: configuredFiles }).media_rights : false,
    },
    spendAcknowledgement: readApproval(projectDirectory, "spend"),
  };
}

export async function coordinateCreate(options) {
  const paths = creatorPaths(options.projectDirectory);
  if (!fs.existsSync(paths.brief)) return { stop: "Initialize the project with init --brief <brief.json> or answer the six prompts." };
  const brief = validateCanonical("brief", readJson(paths.brief), "creator brief");
  if (!fs.existsSync(paths.lyrics)) {
    if (options.dryRun) return generateLyrics({ ...options, brief, dryRun: true });
    if (!approvalCurrent(options.projectDirectory, "disclosure", brief)) return { stop: "Approve personal-input/provider disclosure: approve --stage disclosure." };
    const generated = await generateLyrics({ ...options, brief });
    return { ...generated, stop: "Review lyrics.json (authoritative), then approve --stage lyrics. lyrics.md is regenerated preview only." };
  }
  const lyrics = validateLyricsSemantics(readJson(paths.lyrics));
  if (!lyricsApprovalCurrent(options.projectDirectory, brief, lyrics)) return { stop: "Review edited lyrics.json and run approve --stage lyrics." };
  if (!fs.existsSync(paths.plan)) {
    if (options.dryRun) return generateStoryboard({ ...options, brief, lyrics, dryRun: true });
    const generated = await generateStoryboard({ ...options, brief, lyrics });
    return { ...generated, stop: "Review scene-plan.json and run approve --stage scenes." };
  }
  const plan = readJson(paths.plan);
  if (!scenesApprovalCurrent(options.projectDirectory, brief, lyrics, plan)) return { stop: "Review the current scene-plan.json and run approve --stage scenes." };
  const mediaFiles = Object.values(options.config.inputs.faces ?? {}).flat();
  const directPhotos = plan.video.scenes.flatMap((scene) => scene.source_image ? [path.resolve(path.dirname(paths.plan), scene.source_image)] : []);
  const audio = options.config.audio;
  if (!audio && !options.allowSilent) return { stop: "Supply a finished licensed song in project.config.json inputs.audioCandidates. Use --allow-silent only for an explicit preview." };
  if (!mediaFiles.length || !mediaFiles.every((file) => fs.existsSync(file)) || !directPhotos.every((file) => fs.existsSync(file))) return { stop: "Supply and validate at least one local character reference and every direct-photo path before media generation." };
  if (!approvalStatus(options.projectDirectory, { mediaFiles: [...mediaFiles, ...directPhotos, ...(audio ? [audio] : [])] }).media_rights) return { stop: "Attest current file hashes with approve --stage rights --acknowledge-rights." };
  return { readyForMedia: true, plan };
}

export function requireCreatorEditorialApprovals(projectDirectory, { brief, lyrics, plan }) {
  if (!brief || !lyrics) return false;
  if (!scenesApprovalCurrent(projectDirectory, brief, lyrics, plan)) {
    throw new Error("Creator-originated media requires current disclosure, lyrics, and scene approvals; --yes cannot bypass editorial approval.");
  }
  return true;
}

export function creatorFingerprint(value) { return objectHash(value); }
