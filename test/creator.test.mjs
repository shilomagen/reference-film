import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { approvalCurrent } from "../src/approvals.mjs";
import { main } from "../src/cli.mjs";
import { approveCreatorStage, briefFromAnswers, creatorStatus, generateLyrics, generateStoryboard, initializeCreatorProject, reconcileCreatorOperation, validateStoryboardSemantics } from "../src/creator.mjs";
import { loadProject, parseArgs } from "../src/config.mjs";
import { createPaidOperationJournal, PaidOperationResultUnavailableError } from "../src/providers/journal.mjs";

const answers = [
  "Aiko | they/them | aiko",
  "Birthday | close friend | celebrate a year of brave small steps",
  "We repaired a blue bicycle in rain; We watched sunrise | Always carries tea | patient; playful | cycling; astronomy",
  "Mina~sibling~she/her~mina",
  "日本語 | acoustic guitar; hand percussion | warm and joyful | 75",
  "Avoid medical claims; no invented childhood stories | CONSENT",
];

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "creator-flow-")); }
function sink() { let value = ""; return { io: { stdout: { write: (part) => { value += part; } }, stderr: { write() {} } }, json: () => JSON.parse(value) }; }
function adapter(outputs) {
  let calls = 0;
  return { get calls() { return calls; }, async generateText() { calls += 1; return { json: structuredClone(outputs.shift()), text: "", costUsd: null }; } };
}

const lyrics = {
  title: "小さな星", language: "日本語", music_direction: "温かなギターと軽い手拍子。",
  sections: [
    { section_id: "verse_01", label: "一番", repeat: false, lines: [{ line_id: "verse_01_line_01", text: "雨の自転車を直したね" }] },
    { section_id: "chorus_01", label: "サビ", repeat: true, lines: [{ line_id: "chorus_01_line_01", text: "小さな星へ進もう" }] },
  ],
};

function scene(id, lyricId, text, characters = ["aiko"]) {
  return {
    scene_id: id, section: "custom", lyrics: text, lyric_ids: [lyricId], duration_seconds: 5, characters,
    image_generation: { prompt: "A respectful cinematic metaphor in natural light.", negative_prompt: "No text, logos, or invented people.", aspect_ratio: "16:9" },
    video_generation: { scene_description: "A restrained visual beat.", prompt: "Keep identity and composition stable.", camera: "Slow push.", motion: "Subtle natural motion.", ending_frame: "Hold on the subject." },
  };
}
const plan = { video: { title: "小さな星", description: "A lyric-linked film.", scenes: [scene("rain_bicycle", "verse_01_line_01", "雨の自転車を直したね"), scene("small_star", "chorus_01_line_01", "小さな星へ進もう")] } };

function config() { return { models: { text: "independent-text-model" }, generation: { textMaxOutputTokens: 12000 }, inputs: { faces: { aiko: [], mina: [] } } }; }

test("six repeatable answers produce a meaningful consented Unicode brief and noninteractive init needs no plan", async () => {
  const brief = briefFromAnswers(answers, { projectSlug: "aiko-film" });
  assert.equal(brief.subject.display_name, "Aiko");
  assert.equal(brief.language, "日本語");
  assert.deepEqual(brief.facts.personality, ["patient", "playful"]);
  assert.equal(brief.consent.personal_details_provider_disclosure, true);
  const directory = temp();
  const source = path.join(directory, "source.json");
  fs.writeFileSync(source, JSON.stringify(brief));
  const capture = sink();
  await main(["init", "--project", path.join(directory, "workspace"), "--brief", source], capture.io);
  assert.equal(capture.json().status, "initialized");
  assert.equal(fs.existsSync(path.join(directory, "workspace", "scene-plan.json")), false);
});

test("actual schema-valid text to lyrics to plan chain uses independent adapter, approvals, Unicode, and cache", async () => {
  const directory = temp();
  const brief = briefFromAnswers(answers, { projectSlug: "aiko-film" });
  initializeCreatorProject({ projectDirectory: directory, brief });
  await approveCreatorStage({ projectDirectory: directory, stage: "disclosure", statement: "Explicit test disclosure" });
  const textAdapter = adapter([lyrics, plan]);
  const generatedLyrics = await generateLyrics({ projectDirectory: directory, config: config(), brief, yes: true, dependencies: { textAdapter } });
  assert.equal(generatedLyrics.lyrics.sections[0].lines[0].text, "雨の自転車を直したね");
  assert.equal(textAdapter.calls, 1);
  const reused = await generateLyrics({ projectDirectory: directory, config: config(), brief, yes: true, dependencies: { textAdapter } });
  assert.equal(reused.reused, true);
  assert.equal(textAdapter.calls, 1);
  await approveCreatorStage({ projectDirectory: directory, stage: "lyrics", statement: "Lyrics reviewed" });
  const generatedPlan = await generateStoryboard({ projectDirectory: directory, config: config(), brief, lyrics, yes: true, dependencies: { textAdapter } });
  assert.equal(generatedPlan.plan.video.scenes[0].lyric_ids[0], "verse_01_line_01");
  assert.equal(textAdapter.calls, 2);
  const loadedConfig = JSON.parse(fs.readFileSync(path.join(directory, "project.config.json")));
  assert.equal(loadedConfig.providers.text, "xai");
  assert.equal(loadedConfig.providers.video, "xai");
  assert.match(fs.readFileSync(path.join(directory, "lyrics.md"), "utf8"), /Edit lyrics.json/);
  const loaded = loadProject(parseArgs(["validate", "--project", directory]), { environment: {}, checkFiles: false });
  assert.deepEqual(loaded.plan.allScenes.map((item) => item.scene_id), ["rain_bicycle", "small_star"]);
});

test("lyrics CLI does not load a missing scene plan", async () => {
  const directory = temp();
  const brief = briefFromAnswers(answers, { projectSlug: "aiko-film" });
  initializeCreatorProject({ projectDirectory: directory, brief });
  approveCreatorStage({ projectDirectory: directory, stage: "disclosure", statement: "Consent" });
  assert.equal(fs.existsSync(path.join(directory, "scene-plan.json")), false);
  const textAdapter = adapter([lyrics]);
  const capture = sink();
  await main(["lyrics", "--project", directory, "--yes"], capture.io, { textAdapter, environment: {} });
  assert.equal(capture.json().lyrics.title, "小さな星");
  assert.equal(textAdapter.calls, 1);
});

test("root CLI completes creator to normalized media with config-only references and all gates", async () => {
  const directory = temp();
  const brief = briefFromAnswers(answers, { projectSlug: "aiko-film" });
  initializeCreatorProject({ projectDirectory: directory, brief });
  const reference = path.join(directory, "aiko.jpg");
  const audio = path.join(directory, "song.wav");
  fs.writeFileSync(reference, "synthetic-reference");
  fs.writeFileSync(audio, "synthetic-audio");
  const configPath = path.join(directory, "project.config.json");
  const configured = JSON.parse(fs.readFileSync(configPath));
  configured.inputs.faces.aiko = ["aiko.jpg"];
  configured.inputs.audioCandidates = ["song.wav"];
  configured.models.text = "test-text-model";
  fs.writeFileSync(configPath, JSON.stringify(configured));
  const textAdapter = adapter([lyrics, plan]);
  let mediaCalls = 0;
  const media = {
    async approveMedia() {},
    async runMedia(project) {
      mediaCalls += 1;
      assert.equal(project.plan.allScenes[0].scene_id, "rain_bicycle");
      assert.equal(project.config.inputs.faces.aiko[0], reference);
      assert.equal(project.config.audio, audio);
      return { status: "injected-media-complete" };
    },
  };
  const deps = { textAdapter, environment: {}, media };
  let capture = sink();
  await main(["create", "--project", directory, "--yes"], capture.io, deps);
  assert.equal(mediaCalls, 0, "missing disclosure cannot spend");
  await main(["approve", "--project", directory, "--stage", "disclosure", "--statement", "Consent"], sink().io, deps);
  await main(["lyrics", "--project", directory, "--yes"], sink().io, deps);
  await main(["approve", "--project", directory, "--stage", "lyrics", "--statement", "Lyrics"], sink().io, deps);
  await main(["storyboard", "--project", directory, "--yes"], sink().io, deps);
  await main(["approve", "--project", directory, "--stage", "scenes", "--statement", "Scenes"], sink().io, deps);
  capture = sink();
  await main(["create", "--project", directory, "--yes"], capture.io, deps);
  assert.equal(mediaCalls, 0, "missing rights cannot spend");
  await main(["approve-media", "--project", directory, "--acknowledge-rights", "--statement", "I own these inputs"], sink().io, deps);
  capture = sink();
  await main(["create", "--project", directory, "--yes"], capture.io, deps);
  assert.equal(capture.json().status, "injected-media-complete");
  assert.equal(mediaCalls, 1);
  assert.equal(fs.existsSync(path.join(directory, ".private", "aiko-film", "outputs", "rights-approval.json")), true);
});

test("dry-run, no consent, no --yes, and no lyric approval make zero calls", async () => {
  const directory = temp();
  const brief = briefFromAnswers(answers, { projectSlug: "aiko-film" });
  initializeCreatorProject({ projectDirectory: directory, brief });
  const textAdapter = adapter([lyrics]);
  const dry = await generateLyrics({ projectDirectory: directory, config: config(), brief, dryRun: true, dependencies: { textAdapter } });
  assert.equal(dry.networkCalls, 0);
  assert.equal(dry.estimatedTextRequests, 1);
  assert.match(dry.prompt, /untrusted data/i);
  await assert.rejects(() => generateLyrics({ projectDirectory: directory, config: config(), brief, yes: true, dependencies: { textAdapter } }), /disclosure approval/);
  approveCreatorStage({ projectDirectory: directory, stage: "disclosure", statement: "Consent" });
  await assert.rejects(() => generateLyrics({ projectDirectory: directory, config: config(), brief, dependencies: { textAdapter } }), /--yes/);
  fs.writeFileSync(path.join(directory, "lyrics.json"), JSON.stringify(lyrics));
  await assert.rejects(() => generateStoryboard({ projectDirectory: directory, config: config(), brief, lyrics, yes: true, dependencies: { textAdapter } }), /lyrics require editorial approval/);
  assert.equal(textAdapter.calls, 0);
});

test("edits invalidate only hash-bound gates downstream", () => {
  const directory = temp();
  const brief = briefFromAnswers(answers, { projectSlug: "aiko-film" });
  initializeCreatorProject({ projectDirectory: directory, brief });
  fs.writeFileSync(path.join(directory, "lyrics.json"), JSON.stringify(lyrics));
  fs.writeFileSync(path.join(directory, "scene-plan.json"), JSON.stringify(plan));
  approveCreatorStage({ projectDirectory: directory, stage: "disclosure", statement: "Consent" });
  approveCreatorStage({ projectDirectory: directory, stage: "lyrics", statement: "Lyrics" });
  approveCreatorStage({ projectDirectory: directory, stage: "scenes", statement: "Scenes" });
  assert.deepEqual(creatorStatus(directory).approvals, { disclosure: true, lyrics: true, scenes: true, media_rights: false });
  const editedLyrics = structuredClone(lyrics); editedLyrics.sections[0].lines[0].text += "!";
  fs.writeFileSync(path.join(directory, "lyrics.json"), JSON.stringify(editedLyrics));
  assert.equal(creatorStatus(directory).approvals.lyrics, false);
  assert.equal(creatorStatus(directory).approvals.scenes, false);
  fs.writeFileSync(path.join(directory, "lyrics.json"), JSON.stringify(lyrics));
  const editedPlan = structuredClone(plan); editedPlan.video.description += " edited";
  fs.writeFileSync(path.join(directory, "scene-plan.json"), JSON.stringify(editedPlan));
  assert.equal(creatorStatus(directory).approvals.scenes, false);
  fs.writeFileSync(path.join(directory, "scene-plan.json"), JSON.stringify(plan));
  const editedBrief = structuredClone(brief); editedBrief.intended_message += " edited";
  fs.writeFileSync(path.join(directory, "brief.json"), JSON.stringify(editedBrief));
  const status = creatorStatus(directory).approvals;
  assert.equal(status.disclosure, false);
  assert.equal(status.lyrics, false);
  assert.equal(status.scenes, false);
});

test("malformed, refused, unknown-character, unknown lyric, invented path, and incomplete coverage fail closed", async () => {
  assert.throws(() => validateStoryboardSemantics({ ...plan, video: { ...plan.video, scenes: [scene("bad", "verse_01_line_01", "雨の自転車を直したね", ["ghost"]), plan.video.scenes[1]] } }, { lyrics, characterIds: ["aiko", "mina"] }), /unknown character/);
  assert.throws(() => validateStoryboardSemantics({ ...plan, video: { ...plan.video, scenes: [scene("bad", "missing_line", "wrong"), plan.video.scenes[1]] } }, { lyrics, characterIds: ["aiko"] }), /unknown lyric_id/);
  const sourced = structuredClone(plan); sourced.video.scenes[0].source_image = "/invented.jpg"; sourced.video.scenes[0].source_image_mode = "direct_animation";
  assert.throws(() => validateStoryboardSemantics(sourced, { lyrics, characterIds: ["aiko"] }), /invented or unauthorized/);
  assert.throws(() => validateStoryboardSemantics({ video: { ...plan.video, scenes: [plan.video.scenes[0]] } }, { lyrics, characterIds: ["aiko"] }), /does not cover/);

  const directory = temp(); const brief = briefFromAnswers(answers, { projectSlug: "aiko-film" });
  initializeCreatorProject({ projectDirectory: directory, brief }); approveCreatorStage({ projectDirectory: directory, stage: "disclosure", statement: "Consent" });
  await assert.rejects(() => generateLyrics({ projectDirectory: directory, config: config(), brief, yes: true, dependencies: { textAdapter: { async generateText() { return { json: null, text: "refused" }; } } } }), /malformed or refused/);
});

test("uncertain journal requires explicit reason and duplicate-risk acknowledgement for one retry", async () => {
  const directory = temp();
  const journal = createPaidOperationJournal(path.join(directory, "workflow", "journal"));
  await assert.rejects(() => journal.run({ id: "uncertain-op", provider: "xai", operation: "text", model: "m", fingerprint: "f" }, async () => { throw new Error("connection lost"); }));
  assert.throws(() => reconcileCreatorOperation({ projectDirectory: directory, operationId: "uncertain-op", reason: "checked", acknowledgeDuplicateRisk: false }), /requires/);
  reconcileCreatorOperation({ projectDirectory: directory, operationId: "uncertain-op", reason: "Provider confirmed no accepted request", acknowledgeDuplicateRisk: true });
  let calls = 0;
  await journal.run({ id: "uncertain-op", provider: "xai", operation: "text", model: "m", fingerprint: "f" }, async () => { calls += 1; return { state: "completed" }; });
  const reused = await journal.run({ id: "uncertain-op", provider: "xai", operation: "text", model: "m", fingerprint: "f" }, async () => { calls += 1; });
  assert.equal(reused.reused, true);
  assert.equal(calls, 1);
});

test("init appends private workspace ignores and git confirms generated personal files are ignored", () => {
  const root = temp();
  fs.writeFileSync(path.join(root, ".gitignore"), "keep-me/\n");
  const directory = path.join(root, "projects", "private-film");
  initializeCreatorProject({ projectDirectory: directory, brief: briefFromAnswers(answers, { projectSlug: "aiko-film" }) });
  assert.match(fs.readFileSync(path.join(directory, ".gitignore"), "utf8"), /brief\.json/);
  assert.match(fs.readFileSync(path.join(directory, ".gitignore"), "utf8"), /\.private\//);
  const initialized = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  for (const name of ["brief.json", "project.config.json"]) {
    const checked = spawnSync("git", ["check-ignore", path.relative(root, path.join(directory, name))], { cwd: root, encoding: "utf8" });
    assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
  }
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), "keep-me/\n");
});

test("real text adapter journal uses generation epochs and blocks lost-result resubmission", async () => {
  const directory = temp();
  const brief = briefFromAnswers(answers, { projectSlug: "aiko-film" });
  initializeCreatorProject({ projectDirectory: directory, brief });
  await approveCreatorStage({ projectDirectory: directory, stage: "disclosure", statement: "Consent" });
  let posts = 0;
  const configured = {
    ...config(), providers: { text: "xai", image: "xai", judge: "xai", video: "xai" },
    credentials: { xaiApiKey: "fake", xaiBaseUrl: "http://127.0.0.1:45678/v1" },
    generation: { textMaxOutputTokens: 12000, retry: { attempts: 0 } },
  };
  const dependencies = {
    testOrigins: ["http://127.0.0.1:45678"], sleep: async () => {},
    fetch: async (_url, init) => {
      posts += 1;
      assert.equal(JSON.parse(init.body).max_tokens, 12000);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(lyrics) } }], request_id: `text-${posts}` }), { status: 200 });
    },
  };
  await generateLyrics({ projectDirectory: directory, config: configured, brief, yes: true, dependencies });
  await generateLyrics({ projectDirectory: directory, config: configured, brief, yes: true, force: true, dependencies });
  assert.equal(posts, 2, "force uses a new durable generation epoch even with an identical prompt");
  for (const name of ["lyrics.json", "lyrics.md", "music-brief.md"]) fs.rmSync(path.join(directory, name));
  const error = await generateLyrics({ projectDirectory: directory, config: configured, brief, yes: true, dependencies }).catch((caught) => caught);
  assert.ok(error instanceof PaidOperationResultUnavailableError);
  assert.equal(posts, 2, "a completed response with a lost artifact is never automatically resubmitted");
});

test("invalid artifacts and logs do not retain API keys or base64 URLs", async () => {
  const directory = temp(); const brief = briefFromAnswers(answers, { projectSlug: "aiko-film" });
  initializeCreatorProject({ projectDirectory: directory, brief }); approveCreatorStage({ projectDirectory: directory, stage: "disclosure", statement: "Consent" });
  const configured = config();
  Object.defineProperty(configured, "credentials", { enumerable: false, value: { xaiApiKey: "test-secret-api-key" } });
  const tainted = { ...lyrics, api_key: "test-secret-api-key", artwork: "data:image/png;base64,QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB" };
  await assert.rejects(() => generateLyrics({ projectDirectory: directory, config: configured, brief, yes: true, dependencies: { textAdapter: adapter([tainted]) } }), /schema validation/);
  const content = fs.readdirSync(directory, { recursive: true }).filter((item) => fs.statSync(path.join(directory, item)).isFile()).map((item) => fs.readFileSync(path.join(directory, item), "utf8")).join("\n");
  assert.equal(content.includes("test-secret-api-key"), false);
  assert.equal(content.includes("data:image/"), false);
  assert.match(content, /REDACTED/);
});
