#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HELP, loadProject, parseArgs } from "./config.mjs";

function sceneDirectory(config, plan, scene) {
  const index = plan.allScenes.findIndex((item) => item.scene_id === scene.scene_id) + 1;
  return path.join(config.outputs, "scenes", `${String(index).padStart(2, "0")}_${scene.scene_id}`);
}

export function compileDryRun({ config, plan, timings }) {
  const overrides = new Map((timings?.timings ?? []).map((item) => [item.scene_id, item.duration_seconds]));
  const timeline = plan.allScenes.map((scene, index) => ({
    index: index + 1,
    scene_id: scene.scene_id,
    selected: plan.scenes.some((item) => item.scene_id === scene.scene_id),
    duration_seconds: overrides.get(scene.scene_id) ?? scene.duration_seconds,
    locked: Boolean(scene.lock_duration),
  }));
  return {
    dryRun: true,
    networkCalls: 0,
    project: config.metadata,
    providers: config.providers,
    selectedVideoModel: config.providers.video === "gemini" ? config.models.geminiVideo : config.models.video,
    audio: config.audio,
    outputs: config.outputs,
    fullTimelineDurationSeconds: timeline.reduce((sum, item) => sum + item.duration_seconds, 0),
    timeline,
    scenes: plan.scenes.map((scene) => ({
      scene_id: scene.scene_id,
      characters: scene.characters.map((id) => ({
        id,
        description: config.characters[id].description,
        references: config.inputs.faces[id],
      })),
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
    return {
      scene_id: scene.scene_id,
      image: fs.existsSync(path.join(directory, "image", "selected.png")) ? "ready" : "no media yet",
      video: fs.existsSync(path.join(directory, `video-${provider}`, "selected.mp4")) ? "ready" : "no media yet",
    };
  });
}

export async function main(argv = process.argv.slice(2), io = process) {
  const options = parseArgs(argv);
  if (options.help) {
    io.stdout.write(HELP);
    return 0;
  }
  const project = loadProject(options);
  const { config, plan } = project;
  if (options.command === "validate") {
    io.stdout.write(`${JSON.stringify({
      status: "ok",
      offline: true,
      project: config.metadata.slug,
      scenes: plan.allScenes.length,
      selectedScenes: plan.scenes.length,
      videoProvider: config.providers.video,
      audio: config.audio,
      schemas: ["project config", "creator brief", "lyrics", "scene plan", "timings"],
    }, null, 2)}\n`);
    return 0;
  }
  if (options.command === "status") {
    io.stdout.write(`${JSON.stringify({ project: config.metadata.slug, provider: config.providers.video, scenes: collectStatus(project), final: "no media yet" }, null, 2)}\n`);
    return 0;
  }
  if (options.command === "run" && options.dryRun) {
    io.stdout.write(`${JSON.stringify(compileDryRun(project), null, 2)}\n`);
    return 0;
  }
  if (options.command === "run") throw new Error("Paid generation is not implemented in this slice. Use 'run --dry-run' to compile the plan without calls.");
  throw new Error(`The '${options.command}' stage is not implemented in this slice; no provider or media operation was attempted.`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
