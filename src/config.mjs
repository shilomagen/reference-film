import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeDefaults } from "./defaults.mjs";
import { readJson, validateCanonical } from "./schema.mjs";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "examples", "project.config.json");
export const COMMANDS = Object.freeze(["init", "lyrics", "storyboard", "approve", "create", "reconcile", "run", "images", "videos", "assemble", "status", "validate"]);

export const HELP = `Reference Film offline CLI

Usage:
  node src/cli.mjs <command> [options]

Commands:
  init        Create a workspace from --brief JSON or six concise prompts
  lyrics      Generate schema-valid editable lyrics (one text request)
  storyboard Generate scenes from approved lyrics (one text request)
  approve     Record disclosure, lyrics, scenes, or media-rights approval
  create      Resume the gated creator workflow, stopping for human review
  reconcile   Authorize one retry for an uncertain paid operation
  validate    Validate contracts and local paths (offline by default)
  status      Report local artifact status
  run         Run media stages (or compile the existing plan with --dry-run)
  images      Generate/select stills through the media module
  videos      Animate selected stills through the media module
  assemble    Assemble accepted clips through the media module

Options:
  --project <dir>       Creator workspace (brief.json, lyrics.json, scene-plan.json)
  --brief <path>        Creator brief JSON for noninteractive init/CI
  --config <path>       Config path, relative to the current directory
  --env <path>          Explicit environment file, relative to the current directory
  --audio <path>        Audio override, relative to the current directory
  --timings <path>      Timings override, relative to the current directory
  --scenes <id,id>      Select media work while retaining the full timeline
  --provider <name>     Override only the video provider: xai or gemini
  --concurrency <n>     Positive worker count
  --dry-run             Compile and print paths/prompts without network calls
  --force               Request regeneration in a future paid stage
  --judge / --no-judge  Override automated judging
  --allow-silent        Permit a missing audio track for an explicit preview
  --yes                 Acknowledge possible spend; never editorial/rights approval
  --stage <name>        Approval stage: disclosure, lyrics, scenes, rights
  --statement <text>    Explicit local approval statement
  --acknowledge-rights  Attest rights for current media file hashes
  --operation <id>      Paid journal operation to reconcile
  --reason <text>       Reconciliation reason
  --acknowledge-duplicate-risk  Permit exactly one uncertain-operation retry
  --help                Show this help
`;

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

function fromCwd(value, cwd) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

export function parseArgs(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) return { command: "help", help: true };
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "run";
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command '${command}'. Expected: ${COMMANDS.join(", ")}`);
  const options = {
    command,
    config: DEFAULT_CONFIG_PATH,
    configExplicit: false,
    project: null,
    brief: null,
    env: null,
    audio: null,
    timings: null,
    scenes: null,
    provider: undefined,
    concurrency: undefined,
    dryRun: false,
    force: false,
    judge: undefined,
    allowSilent: false,
    yes: false,
    stage: null,
    statement: null,
    acknowledgeRights: false,
    operation: null,
    reason: null,
    acknowledgeDuplicateRisk: false,
  };
  const start = argv[0] === command ? 1 : 0;
  for (let index = start; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--judge") options.judge = true;
    else if (arg === "--no-judge") options.judge = false;
    else if (arg === "--allow-silent") options.allowSilent = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--acknowledge-rights") options.acknowledgeRights = true;
    else if (arg === "--acknowledge-duplicate-risk") options.acknowledgeDuplicateRisk = true;
    else if (["--config", "--env", "--audio", "--timings", "--project", "--brief"].includes(arg)) {
      const key = arg.slice(2);
      options[key] = fromCwd(valueAfter(argv, index, arg), cwd);
      if (arg === "--config") options.configExplicit = true;
      index += 1;
    } else if (["--stage", "--statement", "--operation", "--reason"].includes(arg)) {
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--provider") {
      options.provider = valueAfter(argv, index, arg).toLowerCase();
      index += 1;
      if (!["xai", "gemini"].includes(options.provider)) throw new Error("--provider must be 'xai' or 'gemini'");
    } else if (arg === "--scenes") {
      options.scenes = valueAfter(argv, index, arg).split(",").map((item) => item.trim()).filter(Boolean);
      index += 1;
      if (!options.scenes.length || new Set(options.scenes).size !== options.scenes.length) throw new Error("--scenes must contain unique scene IDs");
    } else if (arg === "--concurrency") {
      options.concurrency = Number(valueAfter(argv, index, arg));
      index += 1;
      if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency must be a positive integer");
    } else throw new Error(`Unknown option '${arg}'`);
  }
  if (options.project && !options.configExplicit) options.config = path.join(options.project, "project.config.json");
  return options;
}

export function parseEnvFile(filePath) {
  const result = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const [index, raw] of content.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Invalid environment line in ${filePath}:${index + 1}`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    result[match[1]] = value;
  }
  return result;
}

function resolveOwned(root, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
}

function safeOutput(output, configPath, slug) {
  const resolved = path.resolve(output);
  const dangerous = new Set([path.parse(resolved).root, path.resolve(os.homedir()), process.cwd(), path.dirname(configPath)]);
  if (dangerous.has(resolved)) throw new Error(`outputs is unsafe: ${resolved}`);
  if (!resolved.split(path.sep).includes(slug)) throw new Error(`outputs must include the project slug '${slug}' as a path segment`);
  return resolved;
}

function assertProviderCapabilities(config) {
  const supported = { text: ["xai"], image: ["xai"], judge: ["xai"], video: ["xai", "gemini"] };
  for (const capability of Object.keys(supported)) {
    if (!supported[capability].includes(config.providers[capability])) {
      throw new Error(`Provider '${config.providers[capability]}' does not support ${capability}; supported: ${supported[capability].join(", ")}`);
    }
  }
  const modelKey = config.providers.video === "gemini" ? "geminiVideo" : "video";
  if (!config.models[modelKey]) throw new Error(`Video provider '${config.providers.video}' requires models.${modelKey}`);
}

function validateRubric(config) {
  const total = Object.values(config.quality.rubric).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error(`quality.rubric weights must total 1 (received ${total})`);
}

/**
 * Stable loader API for subsequent slices:
 * - parseArgs(argv, {cwd}) -> CLI option object. Explicit CLI paths use cwd.
 * - loadConfig(options, {environment}) -> normalized config with config-owned paths absolute,
 *   ordered faces arrays, runtime flags, selected provider/model and non-enumerable
 *   credentials. It does no network access and creates no files.
 * - loadPlan(config) -> {...video, scenes: selectedScenes, allScenes: fullScenes}.
 * - loadProject(options) -> {config, plan, brief, lyrics, timings}.
 * Secrets are available only at config.credentials (non-enumerable), so config
 * can be safely serialized for plans/manifests without leaking environment data.
 */
export function loadConfig(options = parseArgs([]), { environment = process.env } = {}) {
  const configPath = path.resolve(options.config ?? DEFAULT_CONFIG_PATH);
  const raw = readJson(configPath, "project config");
  validateCanonical("config", raw, "project config");
  const root = path.dirname(configPath);
  const config = mergeDefaults(structuredClone(raw));
  config.configPath = configPath;
  config.inputs.plan = resolveOwned(root, config.inputs.plan);
  for (const optional of ["brief", "lyrics", "timings"]) {
    if (config.inputs[optional]) config.inputs[optional] = resolveOwned(root, config.inputs[optional]);
  }
  const safeId = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
  for (const character of Object.keys(config.characters)) {
    if (!safeId.test(character)) throw new Error(`Character ID '${character}' is unsafe; use lowercase letters, numbers, and underscores`);
    if (!Object.hasOwn(config.inputs.faces, character)) throw new Error(`Character '${character}' has no face references`);
  }
  for (const character of Object.keys(config.inputs.faces)) {
    if (!Object.hasOwn(config.characters, character)) throw new Error(`Face references contain unknown character '${character}'`);
  }
  config.inputs.faces = Object.fromEntries(Object.entries(config.inputs.faces).map(([character, references]) => [
    character,
    (Array.isArray(references) ? references : [references]).map((item) => resolveOwned(root, item)),
  ]));
  config.inputs.audioCandidates = (config.inputs.audioCandidates ?? []).map((item) => resolveOwned(root, item));
  config.outputs = safeOutput(resolveOwned(root, config.outputs), configPath, config.metadata.slug);
  if (options.provider) config.providers.video = options.provider;
  if (options.concurrency) config.generation.concurrency = options.concurrency;
  if (options.judge !== undefined) config.quality.judgeEnabled = options.judge;
  config.audio = options.audio ?? config.inputs.audioCandidates.find((item) => fs.existsSync(item)) ?? null;
  config.timings = options.timings ?? config.inputs.timings ?? null;
  config.sceneFilter = options.scenes ?? null;
  config.dryRun = Boolean(options.dryRun);
  config.force = Boolean(options.force);
  config.allowSilent = Boolean(options.allowSilent);
  assertProviderCapabilities(config);
  validateRubric(config);

  const selectedEnvPath = options.env ?? (raw.envFile ? resolveOwned(root, raw.envFile) : null);
  const fileEnv = selectedEnvPath ? parseEnvFile(selectedEnvPath) : {};
  const env = { ...fileEnv, ...environment };
  config.models.text = env.XAI_TEXT_MODEL || env.GROK_TEXT_MODEL || config.models.text;
  config.models.image = env.XAI_IMAGE_MODEL || env.GROK_IMAGE_MODEL || config.models.image;
  config.models.judge = env.XAI_JUDGE_MODEL || env.GROK_JUDGE_MODEL || config.models.judge;
  config.models.video = env.XAI_VIDEO_MODEL || env.GROK_VIDEO_MODEL || config.models.video;
  config.models.geminiVideo = env.GEMINI_VIDEO_MODEL || config.models.geminiVideo;
  const credentials = Object.freeze({
    xaiApiKey: env.XAI_API_KEY || env.GROK_API_KEY || "",
    xaiBaseUrl: env.XAI_API_BASE_URL || env.GROK_API_BASE_URL || "https://api.x.ai/v1",
    geminiApiKey: env.GEMINI_API_KEY || "",
    geminiBaseUrl: env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
  });
  Object.defineProperty(config, "credentials", { value: credentials, enumerable: false });
  return config;
}

function assertExistingFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile() || fs.statSync(filePath).size === 0) throw new Error(`${label} not found or empty: ${filePath}`);
}

export function loadPlan(config) {
  const document = readJson(config.inputs.plan, "scene plan");
  validateCanonical("plan", document, "scene plan");
  const video = document.video;
  const fullScenes = video.scenes;
  const ids = new Set();
  const planRoot = path.dirname(config.inputs.plan);
  for (const [index, scene] of fullScenes.entries()) {
    const label = `video.scenes[${index}]`;
    if (ids.has(scene.scene_id)) throw new Error(`${label}.scene_id '${scene.scene_id}' is duplicated`);
    ids.add(scene.scene_id);
    for (const character of scene.characters) if (!config.characters[character] || !config.inputs.faces[character]) throw new Error(`${label} references unknown character '${character}'`);
    if (scene.source_image_mode === "direct_animation" && !scene.source_image) throw new Error(`${label} direct_animation requires source_image`);
    if (scene.source_image && scene.source_image_mode !== "direct_animation") throw new Error(`${label}.source_image requires source_image_mode 'direct_animation'`);
    const promptFields = [
      ["image_generation.prompt", scene.image_generation.prompt],
      ["image_generation.negative_prompt", scene.image_generation.negative_prompt],
      ["video_generation.scene_description", scene.video_generation.scene_description],
      ["video_generation.prompt", scene.video_generation.prompt],
      ["video_generation.camera", scene.video_generation.camera],
      ["video_generation.motion", scene.video_generation.motion],
      ["video_generation.ending_frame", scene.video_generation.ending_frame],
    ];
    for (const [field, value] of promptFields) if (!value.trim()) throw new Error(`${label}.${field} must not be blank`);
    if (scene.source_image) scene.source_image = resolveOwned(planRoot, scene.source_image);
  }
  const selectedScenes = config.sceneFilter ? fullScenes.filter((scene) => config.sceneFilter.includes(scene.scene_id)) : fullScenes;
  const selectedIds = new Set(selectedScenes.map((scene) => scene.scene_id));
  const missing = config.sceneFilter?.filter((id) => !selectedIds.has(id)) ?? [];
  if (missing.length) throw new Error(`Unknown scene id(s): ${missing.join(", ")}`);
  return { ...video, scenes: selectedScenes, allScenes: fullScenes };
}

function loadOptional(config, inputKey, schemaName) {
  const filePath = config.inputs[inputKey];
  if (!filePath) return null;
  return validateCanonical(schemaName, readJson(filePath, inputKey), inputKey);
}

function validateUniqueDocumentIds(lyrics, timings, plan) {
  if (lyrics) {
    const sections = new Set();
    const lines = new Set();
    const repeatable = new Set();
    const ordered = [];
    for (const section of lyrics.sections) {
      if (sections.has(section.section_id)) throw new Error(`Duplicate lyrics section_id '${section.section_id}'`);
      sections.add(section.section_id);
      for (const line of section.lines) {
        if (lines.has(line.line_id)) throw new Error(`Duplicate lyrics line_id '${line.line_id}'`);
        lines.add(line.line_id);
        ordered.push(line.line_id);
        if (section.repeat) repeatable.add(line.line_id);
      }
    }
    const counts = new Map();
    let position = -1;
    for (const scene of plan.allScenes) for (const id of scene.lyric_ids) {
      if (!lines.has(id)) throw new Error(`Scene '${scene.scene_id}' references unknown lyric_id '${id}'`);
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (count > 1 && !repeatable.has(id)) throw new Error(`Scene plan repeats lyric_id '${id}' without repeat=true`);
      const next = ordered.indexOf(id);
      if (next < position && !repeatable.has(id)) throw new Error(`Scene '${scene.scene_id}' places lyric_id '${id}' out of intended order`);
      position = Math.max(position, next);
    }
    for (const id of lines) if (!counts.has(id)) throw new Error(`Scene plan does not cover lyric_id '${id}'`);
  }
  if (timings) {
    const scenes = new Set(plan.allScenes.map((scene) => scene.scene_id));
    const seen = new Set();
    for (const timing of timings.timings) {
      if (seen.has(timing.scene_id)) throw new Error(`Duplicate timing for scene '${timing.scene_id}'`);
      if (!scenes.has(timing.scene_id)) throw new Error(`Timing references unknown scene '${timing.scene_id}'`);
      seen.add(timing.scene_id);
    }
  }
}

export function validateLocalInputs(config, plan) {
  for (const [character, references] of Object.entries(config.inputs.faces)) {
    for (const [index, filePath] of references.entries()) assertExistingFile(filePath, `face reference ${character}[${index}]`);
  }
  for (const scene of plan.allScenes) if (scene.source_image) assertExistingFile(scene.source_image, `source image for ${scene.scene_id}`);
  if (config.audio) assertExistingFile(config.audio, "audio");
}

export function loadProject(options = parseArgs([]), { checkFiles = true, environment = process.env } = {}) {
  const config = loadConfig(options, { environment });
  const plan = loadPlan(config);
  const brief = loadOptional(config, "brief", "brief");
  const lyrics = loadOptional(config, "lyrics", "lyrics");
  let timings = null;
  if (config.timings) timings = validateCanonical("timings", readJson(config.timings, "timings"), "timings");
  validateUniqueDocumentIds(lyrics, timings, plan);
  if (brief && brief.project_slug !== config.metadata.slug) throw new Error(`Creator brief project_slug '${brief.project_slug}' does not match '${config.metadata.slug}'`);
  if (checkFiles) validateLocalInputs(config, plan);
  return { config, plan, brief, lyrics, timings };
}
