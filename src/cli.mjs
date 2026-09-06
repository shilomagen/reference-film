#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { approveCreatorStage, askSixQuestions, briefFromAnswers, coordinateCreate, creatorStatus, generateLyrics, generateStoryboard, initializeCreatorProject, reconcileCreatorOperation, requireCreatorEditorialApprovals, validateLyricsSemantics } from "./creator.mjs";
import { HELP, loadConfig, loadProject, parseArgs } from "./config.mjs";
import { readJson } from "./io.mjs";
import { validateCanonical } from "./schema.mjs";

function workspace(options) {
  return path.resolve(options.project ?? path.dirname(options.config));
}

async function dynamicMedia(command, project, options, dependencies = {}) {
  const media = dependencies.media ?? await import("./media.mjs");
  if (typeof media.runMedia !== "function") throw new Error("Integrated media module does not export runMedia({command, config, plan, yes, ...}).");
  return media.runMedia({ command, ...project, yes: options.yes, dryRun: options.dryRun, force: options.force, allowSilent: options.allowSilent, ...(dependencies.mediaDependencies ?? {}) });
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

  if (["approve", "approve-media", "approve-artifact", "reconcile", "reconcile-media"].includes(options.command)) {
    let result;
    if (options.command === "reconcile") {
      result = reconcileCreatorOperation({ projectDirectory: directory, operationId: options.operation, reason: options.reason, acknowledgeDuplicateRisk: options.acknowledgeDuplicateRisk });
    } else if (options.command === "approve" && options.stage !== "rights") {
      const config = options.stage === "scenes" ? loadConfig(options, { environment: dependencies.environment ?? process.env }) : null;
      result = await approveCreatorStage({ projectDirectory: directory, stage: options.stage, acknowledgeRights: options.acknowledgeRights, statement: options.statement ?? "Approved after local review.", config });
    } else {
      const project = loadProject(options);
      const media = dependencies.media ?? await import("./media.mjs");
      if (options.command === "approve" || options.command === "approve-media") {
        result = await approveCreatorStage({ projectDirectory: directory, stage: "rights", acknowledgeRights: options.acknowledgeRights, statement: options.statement ?? "Approved after local review.", config: project.config, plan: project.plan });
      } else if (options.command === "approve-artifact") {
        result = await media.approveArtifact({ ...project, sceneId: options.scene, stage: options.stage, checksum: options.checksum });
      } else {
        result = media.reconcilePaidOperation({ config: project.config, operationId: options.operation, reason: options.reason, acknowledgeDuplicateRisk: options.acknowledgeDuplicateRisk });
      }
    }
    print(io, result);
    return 0;
  }

  if (options.command === "status" && options.project && !fs.existsSync(options.config)) {
    print(io, creatorStatus(directory));
    return 0;
  }

  if (["lyrics", "storyboard", "create"].includes(options.command)) {
    const config = loadConfig(options, { environment: dependencies.environment ?? process.env });
    const brief = validateCanonical("brief", readJson(config.inputs.brief ?? path.join(directory, "brief.json"), null), "creator brief");
    let result;
    if (options.command === "lyrics") result = await generateLyrics({ projectDirectory: directory, config, brief, yes: options.yes, dryRun: options.dryRun, force: options.force, dependencies });
    else if (options.command === "storyboard") {
      const lyrics = validateLyricsSemantics(readJson(config.inputs.lyrics ?? path.join(directory, "lyrics.json"), null));
      result = await generateStoryboard({ projectDirectory: directory, config, brief, lyrics, yes: options.yes, dryRun: options.dryRun, force: options.force, dependencies });
    } else {
      result = await coordinateCreate({ projectDirectory: directory, config, yes: options.yes, dryRun: options.dryRun, force: options.force, allowSilent: options.allowSilent, dependencies });
      if (result.readyForMedia) {
        const complete = loadProject(options, { environment: dependencies.environment ?? process.env });
        requireCreatorEditorialApprovals(directory, complete);
        result = await dynamicMedia("run", complete, options, dependencies);
      }
    }
    print(io, result);
    return 0;
  }

  const project = loadProject(options);
  const creatorOrigin = Boolean(project.brief && project.lyrics && fs.existsSync(path.join(path.dirname(project.config.configPath), "workflow")));
  if (creatorOrigin && ["run", "images", "videos"].includes(options.command) && !options.dryRun) requireCreatorEditorialApprovals(directory, project);
  const mediaCommand = options.command === "run" && options.dryRun ? "dry-run" : options.command;
  const result = await dynamicMedia(mediaCommand, project, options, dependencies);
  if (result !== undefined) print(io, result);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main().catch((error) => { process.stderr.write(`Error: ${error.message}${error.invalidArtifact ? `\nInvalid output saved: ${error.invalidArtifact}` : ""}\n`); process.exitCode = 1; });
