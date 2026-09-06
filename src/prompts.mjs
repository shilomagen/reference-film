const GENERIC_AVOID = [
  "identity blending or swapping", "duplicate named people", "unrequested people",
  "changed apparent age, hair, facial features, or clothing", "obscured named faces",
  "distorted anatomy, hands, or limbs", "text, captions, logos, or watermarks",
].join(", ");

function args(sceneOrOptions, maybeConfig) {
  if (sceneOrOptions?.scene) return sceneOrOptions;
  return { scene: sceneOrOptions, config: maybeConfig ?? {} };
}

function referenceLines(scene, config) {
  let image = 1;
  const lines = [];
  for (const character of scene.characters) {
    const references = config.inputs?.faces?.[character] ?? [];
    const count = Array.isArray(references) ? references.length : 1;
    const labels = Array.from({ length: count }, () => `<IMAGE_${image++}>`);
    const description = config.characters?.[character]?.description;
    lines.push(`${labels.join(", ")} ${count === 1 ? "is" : "are"} ordered identity reference${count === 1 ? "" : "s"} for ${character}.${description ? ` Description: ${description}` : ""} Preserve only visible identity evidence; do not infer age, pronouns, background, or occasion.`);
  }
  return { lines, count: image - 1 };
}

export function buildImagePrompt(sceneOrOptions, maybeConfig) {
  const { scene, config = {}, plan = {} } = args(sceneOrOptions, maybeConfig);
  const aspect = scene.image_generation.aspect_ratio ?? plan.aspect_ratio ?? "16:9";
  if (scene.source_image_mode === "direct_animation") {
    return `DIRECT SOURCE MODE: fit the supplied source photograph to ${aspect} without redesigning, replacing, or inventing any person. ${scene.image_generation.prompt}`;
  }
  const refs = referenceLines(scene, config);
  const identities = scene.characters.map((name) => `${name} must match only the reference image(s) assigned to ${name}`).join("; ");
  return [
    `Create one coherent ${aspect} cinematic still, not a collage or contact sheet.`,
    ...refs.lines,
    `IDENTITY MAP: ${identities}. Never blend, swap, or duplicate identities.`,
    `VISUAL STYLE: ${config.visualStyle ?? "Natural cinematic composition"}.`,
    `SCENE: ${scene.image_generation.prompt}`,
    `AVOID: ${GENERIC_AVOID}${scene.image_generation.negative_prompt ? `, ${scene.image_generation.negative_prompt}` : ""}.`,
  ].join("\n\n");
}

export function buildVideoPrompt(sceneOrOptions, maybeConfig) {
  const { scene, config = {} } = args(sceneOrOptions, maybeConfig);
  const direction = [
    `ACTION: ${scene.video_generation.scene_description}`,
    `DIRECTOR PROMPT: ${scene.video_generation.prompt}`,
    `CAMERA: ${scene.video_generation.camera}`,
    `MOTION: ${scene.video_generation.motion}`,
    `ENDING: ${scene.video_generation.ending_frame}`,
  ];
  if (scene.source_image_mode === "direct_animation") {
    return [
      "Animate the supplied photograph as the exact first frame; do not redesign its people, clothing, setting, composition, or person count.",
      ...direction,
      "Use extremely restrained motion: small blinks, breathing, and subtle environmental movement only. Never add, remove, swap, blend, age, obscure, or duplicate a person.",
      `Maintain ${config.visualStyle ?? "the source image's visual character"}. No text, captions, logos, or watermarks.`,
    ].join("\n\n");
  }
  return [
    "Animate the approved still as the exact first frame.",
    ...direction,
    `IDENTITY LOCK: preserve the visible identity, face, hair, clothing, and body proportions of ${scene.characters.join(", ")} through every frame. Never swap, blend, duplicate, morph, or obscure them.`,
    "Use restrained motion, stable anatomy, realistic physics, and gentle camera movement. Preserve the setting and first-frame composition. No dialogue-like mouth motion or unrequested transformations.",
    `VISUAL STYLE: ${config.visualStyle ?? "Natural cinematic composition"}. No text, captions, logos, or watermarks.`,
  ].join("\n\n");
}

export function buildGeminiVideoPrompt(sceneOrOptions, maybeConfig) {
  return [
    "Animate the supplied first frame without identifying any person. Treat all depicted people as consenting private subjects.",
    buildVideoPrompt(sceneOrOptions, maybeConfig),
  ].join("\n\n");
}

export function imageJudgePrompt(scene, candidateCount, config = {}) {
  const refs = referenceLines(scene, config);
  return [
    "Act as a strict visual identity and continuity reviewer.",
    `The first ${refs.count} images are ordered identity references: ${refs.lines.join(" ")}`,
    `The following ${candidateCount} images are candidates numbered exactly 1 through ${candidateCount}.`,
    `Scene requirement: ${scene.image_generation.prompt}`,
    "Score exact visible likeness rather than broad similarity. Reject swaps, blends, duplicates, wrong roles/count, obscured faces, anatomy failures, unreadable intent, or visible text.",
    "All scores must be finite integers from 0 through 100. identity_scores must contain exactly one key for every named character. Use creative_intent, not humor. Return only the requested JSON.",
  ].join("\n\n");
}

export function videoJudgePrompt(scene, frameCount, config = {}) {
  const refs = referenceLines(scene, config);
  return [
    "Act as a strict video identity and continuity reviewer.",
    `The first ${refs.count} images are ordered identity references. The next image is the approved still. The final ${frameCount} images are chronological clip samples.`,
    `Reference map: ${refs.lines.join(" ")}`,
    `Expected action: ${scene.video_generation.scene_description}`,
    "Score exact visible identity, face stability, anatomy, continuity, action readability, and cinematic quality. Reject swaps, blending, duplication, severe drift, major mutation, or persistent unrecognizability. All scores must be finite integers from 0 through 100. Return only the requested JSON.",
  ].join("\n\n");
}

export function directPhotoJudgePrompt(scene, frameCount) {
  return [
    "Act as a strict continuity reviewer for an animated source photograph.",
    `The first image is the untouched source and the following ${frameCount} images are chronological samples.`,
    `Expected restrained action: ${scene.video_generation.scene_description}`,
    "Require exact group membership, person count, visible identities, clothing, composition, and setting. Reject additions, removals, swaps, duplication, age/clothing changes, severe distortion, or substantial recomposition. Scores must be finite integers from 0 through 100. Return only the requested JSON.",
  ].join("\n\n");
}
