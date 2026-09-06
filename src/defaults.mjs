export const DEFAULT_CONFIG = Object.freeze({
  metadata: {
    slug: "example-film",
    title: "Example Reference Film",
    description: "A synthetic offline example.",
  },
  visualStyle: "Natural cinematic light, expressive composition, coherent color, and no visible text.",
  characters: {},
  providers: { text: "xai", image: "xai", judge: "xai", video: "xai" },
  models: {
    text: "grok-text",
    image: "grok-imagine-image",
    judge: "grok-vision",
    video: "grok-imagine-video",
    geminiVideo: "veo-fast",
  },
  generation: {
    imageCandidates: 3,
    imageRounds: 3,
    videoAttempts: 3,
    concurrency: 2,
    textMaxOutputTokens: 12_000,
    imageResolution: "2k",
    imageQuality: "medium",
    videoResolution: "720p",
    videoAudioPolicy: "disabled",
    pollIntervalMs: 10_000,
    pollTimeoutMs: 900_000,
    retry: { attempts: 7, baseDelayMs: 2_000, maxDelayMs: 120_000, jitter: 0.2 },
  },
  quality: {
    judgeEnabled: true,
    imageIdentityMinimum: 72,
    imageAnatomyMinimum: 65,
    imageCharactersMinimum: 70,
    videoIdentityMinimum: 68,
    videoStabilityMinimum: 65,
    rubric: {
      identity: 0.45,
      correct_characters: 0.15,
      scene_readability: 0.12,
      anatomy: 0.12,
      cinematic_style: 0.10,
      creative_intent: 0.06,
    },
  },
  assembly: {
    width: 1920,
    height: 1080,
    fps: 24,
    codec: "libx264",
    crf: 18,
    audioBitrate: "192k",
    freezeFrameSeconds: 2,
  },
});

export function mergeDefaults(config) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    metadata: { ...DEFAULT_CONFIG.metadata, ...config.metadata },
    providers: { ...DEFAULT_CONFIG.providers, ...config.providers },
    models: { ...DEFAULT_CONFIG.models, ...config.models },
    generation: {
      ...DEFAULT_CONFIG.generation,
      ...config.generation,
      retry: { ...DEFAULT_CONFIG.generation.retry, ...config.generation?.retry },
    },
    quality: {
      ...DEFAULT_CONFIG.quality,
      ...config.quality,
      rubric: { ...DEFAULT_CONFIG.quality.rubric, ...config.quality?.rubric },
    },
    assembly: { ...DEFAULT_CONFIG.assembly, ...config.assembly },
  };
}
