#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { approveCreatorStage, askSixQuestions, briefFromAnswers, coordinateCreate, creatorStatus, generateLyrics, generateStoryboard, initializeCreatorProject, reconcileCreatorOperation, validateLyricsSemantics } from "./creator.mjs";
import { HELP, loadConfig, loadProject, parseArgs } from "./config.mjs";
import { readJson } from "./io.mjs";
import { validateCanonical } from "./schema.mjs";

function sceneDirectory(config, plan, scene) {
  const index = plan.allScenes.findIndex((item) => item.scene_id === scene.scene_id) + 1;
  return path.join(config.outputs, "scenes", `${String(index).padStart(2, "0")}_${scene.scene_id}`);
}

export function compileDryRun({ config, plan, timings }) {
  const overrides = new Map((timings?.timings ?? []).map((item) => [item.scene_id, item.duration_seconds]));
  const timeline = plan.allScenes.map((scene, index) => ({ index: index + 1, scene_id: scene.scene_id, selected: plan.scenes.some((item) => item.scene_id === scene.scene_id), duration_seconds: overrides.get(scene.scene_id) ?? scene.duration_seconds, locked: Boolean(scene.lock_duration) }));
  return {
    dryRun: true, networkCalls: 0, project: config.metadata, providers: config.providers,
    selectedVideoModel: config.providers.video === "gemini" ? config.models.geminiVideo : config.models.video,
    audio: config.audio, outputs: config.outputs,
    fullTimelineDurationSeconds: timeline.reduce((sum, item) => sum + item.duration_seconds, 0), timeline,
    scenes: plan.scenes.map((scene) => ({
      scene_id: scene.scene_id,
      characters: scene.characters.map((id) => ({ id, description: config.characters[id].description, references: config.inputs.faces[id] })),
      source: scene.source_image_mode === "direct_animation" ? scene.source_image : "generated still candidate",
      imagePrompt: `${config.visualStyle}\n\n${scene.image_generation.prompt}\n\nAvoid: ${scene.image_generation.negative_prompt}`,
      videoPrompt: [scene.video_generation.prompt, scene.video_generation.camera, scene.video_generation.motion, scene.video_generation.ending_frame].join(" "),
      outputDirectory: sceneDirectory(config, plan, scene),
    })),
  };
}

function collectStatus({ config, plan }) {
  const provider = config.providers.video;
  return plan.allScenes.map((scene) => {
    const directory = sceneDirectory(config, plan, scene);
    return { scene_id: scene.scene_id, image: fs.existsSync(path.join(directory, "image", "selected.png")) ? "ready" : "no media yet", video: fs.existsSync(path.join(directory, `video-${provider}`, "selected.mp4")) ? "ready" : "no media yet" };
  });
}

function workspace(options) {
  return path.resolve(options.project ?? path.dirname(options.config));
}

async function dynamicMedia(command, project, options) {
  let media;
  try { media = await import("./media.mjs"); }
  catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") throw new Error("Paid generation is not implemented because the media workflow slice is not integrated yet; no provider or media operation was attempted.");
    throw error;
  }
  if (typeof media.runMedia !== "function") throw new Error("Integrated media module does not export runMedia({command, config, plan, yes, ...}).");
  return media.runMedia({ command, ...project, yes: options.yes, dryRun: options.dryRun, force: options.force, allowSilent: options.allowSilent });
}

function print(io, value) { io.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

export async function main(argv = process.argv.slice(2), io = process, dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) { io.stdout.write(HELP); return 0; }
  const directory = workspace(options);

  if (options.command === "init") {
    const brief = options.brief ? validateCanonical("brief", readJson(options.brief, null), "creator brief") : briefFromAnswers(await askSixQuestions({ ask: dependencies.ask }), { projectSlug: path.basename(directory) });
    const paths = initializeCreatorProject({ projectDirectory: directory, brief, force: options.force });
    print(io, { status: "initialized", project: directory, files: { brief: paths.brief, config: paths.config }, next: "approve --stage disclosure, then lyrics --yes" });
    return 0;
  }

  if (["approve", "reconcile"].includes(options.command)) {
    const result = options.command === "approve"
      ? approveCreatorStage({ projectDirectory: directory, stage: options.stage, acknowledgeRights: options.acknowledgeRights, statement: options.statement ?? "Approved after local review." })
      : reconcileCreatorOperation({ projectDirectory: directory, operationId: options.operation, reason: options.reason, acknowledgeDuplicateRisk: options.acknowledgeDuplicateRisk });
    print(io, result);
    return 0;
  }

  if (options.command === "status" && options.project && !fs.existsSync(options.config)) {
    print(io, creatorStatus(directory));
    return 0;
  }

  if (["lyrics", "storyboard", "create"].includes(options.command)) {
    const config = loadConfig(options, { environment: dependencies.environment ?? process.env });
    const brief = validateCanonical("brief", readJson(path.join(directory, "brief.json"), null), "creator brief");
    let result;
    if (options.command === "lyrics") result = await generateLyrics({ projectDirectory: directory, config, brief, yes: options.yes, dryRun: options.dryRun, force: options.force, dependencies });
    else if (options.command === "storyboard") {
      const lyrics = validateLyricsSemantics(readJson(path.join(directory, "lyrics.json"), null));
      result = await generateStoryboard({ projectDirectory: directory, config, brief, lyrics, yes: options.yes, dryRun: options.dryRun, force: options.force, dependencies });
    } else {
      result = await coordinateCreate({ projectDirectory: directory, config, yes: options.yes, dryRun: options.dryRun, force: options.force, allowSilent: options.allowSilent, dependencies });
      if (result.readyForMedia) result = await dynamicMedia("run", { config, plan: { ...result.plan.video, scenes: result.plan.video.scenes, allScenes: result.plan.video.scenes }, brief, lyrics: validateLyricsSemantics(readJson(path.join(directory, "lyrics.json"), null)), timings: null }, options);
    }
    print(io, result);
    return 0;
  }

  const project = loadProject(options);
  const { config, plan } = project;
  if (options.command === "validate") {
    print(io, { status: "ok", offline: true, project: config.metadata.slug, scenes: plan.allScenes.length, selectedScenes: plan.scenes.length, videoProvider: config.providers.video, audio: config.audio, schemas: ["project config", "creator brief", "lyrics", "scene plan", "timings"] });
    return 0;
  }
  if (options.command === "status") {
    print(io, { project: config.metadata.slug, provider: config.providers.video, scenes: collectStatus(project), final: "no media yet" });
    return 0;
  }
  if (options.command === "run" && options.dryRun) { print(io, compileDryRun(project)); return 0; }
  const result = await dynamicMedia(options.command, project, options);
  if (result !== undefined) print(io, result);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main().catch((error) => { process.stderr.write(`Error: ${error.message}${error.invalidArtifact ? `\nInvalid output saved: ${error.invalidArtifact}` : ""}\n`); process.exitCode = 1; });
