import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_PATH, HELP, loadConfig, loadPlan, loadProject, parseArgs } from "../src/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function defaultOptions(overrides = {}) {
  return { ...parseArgs(["validate"]), ...overrides };
}

function copyProject(transform = (value) => value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reference-film-config-"));
  fs.cpSync(path.join(root, "examples"), directory, { recursive: true });
  const configPath = path.join(directory, "project.config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.outputs = path.join(directory, ".generated", config.metadata.slug);
  fs.writeFileSync(configPath, JSON.stringify(transform(config), null, 2));
  return { directory, configPath };
}

test("parseArgs preserves command options and resolves explicit paths from cwd", () => {
  const cwd = path.join(os.tmpdir(), "outside-project");
  const options = parseArgs(["run", "--config", "cfg.json", "--env", "project.env", "--audio", "song.wav", "--timings", "times.json", "--scenes", "a,b", "--provider", "gemini", "--concurrency", "3", "--dry-run", "--force", "--no-judge", "--allow-silent"], { cwd });
  assert.deepEqual(options.scenes, ["a", "b"]);
  assert.equal(options.config, path.join(cwd, "cfg.json"));
  assert.equal(options.env, path.join(cwd, "project.env"));
  assert.equal(options.provider, "gemini");
  assert.equal(options.concurrency, 3);
  assert.equal(options.dryRun, true);
  assert.equal(options.force, true);
  assert.equal(options.judge, false);
  assert.equal(options.allowSilent, true);
});

test("help and argument failures are explicit", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.match(HELP, /--provider.*video provider/);
  assert.throws(() => parseArgs(["wat"]), /Unknown command/);
  assert.throws(() => parseArgs(["run", "--concurrency", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["run", "--provider", "other"]), /xai.*gemini/);
  assert.throws(() => parseArgs(["run", "--scenes", "one,one"]), /unique scene IDs/);
});

test("default loader is safe and normalizes legacy face strings to ordered arrays", () => {
  const config = loadConfig(defaultOptions());
  assert.equal(config.configPath, DEFAULT_CONFIG_PATH);
  assert.equal(config.inputs.faces.traveler.length, 2);
  assert.match(config.inputs.faces.traveler[0], /traveler-primary\.png$/);
  assert.match(config.inputs.faces.traveler[1], /traveler-profile\.png$/);
  assert.deepEqual(config.inputs.faces.maker.map((item) => path.basename(item)), ["maker-primary.png"]);
  assert.equal(path.basename(config.outputs), "example-film");
});

test("config-owned paths resolve from config directory under external cwd", () => {
  const config = loadConfig(defaultOptions({ config: path.join(root, "examples", "project.config.json") }));
  assert.equal(config.inputs.plan, path.join(root, "examples", "scene-plan.json"));
  assert.equal(config.inputs.brief, path.join(root, "examples", "creator-brief.json"));
  assert.equal(config.inputs.faces.maker[0], path.join(root, "examples", "assets", "maker-primary.png"));
});

test("video provider override does not alter other capabilities", () => {
  const config = loadConfig(defaultOptions({ provider: "gemini" }));
  assert.deepEqual(config.providers, { text: "xai", image: "xai", judge: "xai", video: "gemini" });
  assert.equal(config.models.geminiVideo, "example-gemini-video-model");
});

test("environment is explicit, aliases work, model overrides are project scoped, and secrets do not serialize", () => {
  const { directory, configPath } = copyProject();
  const envPath = path.join(directory, "selected.env");
  fs.writeFileSync(envPath, "GROK_API_KEY=test-secret\nXAI_IMAGE_MODEL=override-image\nGEMINI_API_KEY=gemini-secret\n");
  const noEnvironment = loadConfig(defaultOptions({ config: configPath }), { environment: {} });
  assert.equal(noEnvironment.credentials.xaiApiKey, "");
  const config = loadConfig(defaultOptions({ config: configPath, env: envPath }), { environment: {} });
  assert.equal(config.credentials.xaiApiKey, "test-secret");
  assert.equal(config.credentials.geminiApiKey, "gemini-secret");
  assert.equal(config.models.image, "override-image");
  assert.equal(JSON.stringify(config).includes("test-secret"), false);
  assert.equal(JSON.stringify(config).includes("gemini-secret"), false);
  fs.rmSync(directory, { recursive: true });
});

test("loadPlan returns selected scenes and immutable full-plan ordering semantics", () => {
  const config = loadConfig(defaultOptions({ scenes: ["lantern_run"] }));
  const plan = loadPlan(config);
  assert.deepEqual(plan.scenes.map((scene) => scene.scene_id), ["lantern_run"]);
  assert.deepEqual(plan.allScenes.map((scene) => scene.scene_id), ["solo_portrait", "shared_workbench", "lantern_run", "memory_group"]);
  assert.match(plan.allScenes[3].source_image, /group-reference\.png$/);
});

test("project validates references, brief, lyrics and timing links", () => {
  const project = loadProject(defaultOptions());
  assert.equal(project.brief.project_slug, "example-film");
  assert.equal(project.lyrics.sections.length, 2);
  assert.equal(project.timings.timings.length, 4);
});

test("semantic validation rejects unknown characters and missing direct-animation source", () => {
  const fixture = copyProject();
  const planPath = path.join(fixture.directory, "scene-plan.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.video.scenes[0].characters = ["ghost"];
  fs.writeFileSync(planPath, JSON.stringify(plan));
  assert.throws(() => loadProject(defaultOptions({ config: fixture.configPath })), /unknown character 'ghost'/);
  plan.video.scenes[0].characters = ["traveler"];
  plan.video.scenes[3].source_image = undefined;
  fs.writeFileSync(planPath, JSON.stringify(plan));
  assert.throws(() => loadProject(defaultOptions({ config: fixture.configPath })), /direct_animation requires source_image/);
  fs.rmSync(fixture.directory, { recursive: true });
});

test("schema and semantic validation reject unsafe IDs, durations, prompts and output roots", () => {
  const unsafeId = copyProject();
  const planPath = path.join(unsafeId.directory, "scene-plan.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.video.scenes[0].scene_id = "../bad";
  fs.writeFileSync(planPath, JSON.stringify(plan));
  assert.throws(() => loadProject(defaultOptions({ config: unsafeId.configPath })), /scene_id.*does not match/s);
  fs.rmSync(unsafeId.directory, { recursive: true });

  const badDuration = copyProject();
  const durationPlan = JSON.parse(fs.readFileSync(path.join(badDuration.directory, "scene-plan.json"), "utf8"));
  durationPlan.video.scenes[0].duration_seconds = 0;
  durationPlan.video.scenes[0].image_generation.prompt = "";
  fs.writeFileSync(path.join(badDuration.directory, "scene-plan.json"), JSON.stringify(durationPlan));
  assert.throws(() => loadProject(defaultOptions({ config: badDuration.configPath })), /duration_seconds.*must be >|prompt.*too short/s);
  fs.rmSync(badDuration.directory, { recursive: true });

  const output = copyProject((config) => ({ ...config, outputs: "." }));
  assert.throws(() => loadConfig(defaultOptions({ config: output.configPath })), /outputs is unsafe/);
  fs.rmSync(output.directory, { recursive: true });
});

test("unsupported provider capability fails before filesystem input checks", () => {
  const fixture = copyProject((config) => ({ ...config, providers: { ...config.providers, image: "gemini" } }));
  assert.throws(() => loadConfig(defaultOptions({ config: fixture.configPath })), /image.*must equal "xai"|does not support image/s);
  fs.rmSync(fixture.directory, { recursive: true });
});
