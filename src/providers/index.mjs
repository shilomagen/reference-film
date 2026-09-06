import path from "node:path";
import { createGeminiProvider } from "./gemini.mjs";
import { createXaiProvider } from "./xai.mjs";

export const PROVIDER_CAPABILITIES = Object.freeze({
  xai: Object.freeze(["text", "image", "judge", "video"]),
  gemini: Object.freeze(["video"]),
});

function credential(config, provider, key) {
  const map = config.credentials?.[provider] ?? {};
  return map[key] ?? config[key] ?? null;
}

function requestedProviders(config) {
  const selected = config.providers ?? {};
  return {
    text: selected.text ?? "xai",
    image: selected.image ?? "xai",
    judge: selected.judge ?? "xai",
    video: selected.video ?? config.videoProvider ?? "xai",
  };
}

export function validateProviderSelection(config) {
  const selected = requestedProviders(config);
  for (const [capability, provider] of Object.entries(selected)) {
    const capabilities = PROVIDER_CAPABILITIES[provider];
    if (!capabilities) throw new Error(`Unknown ${capability} provider: ${provider}`);
    if (!capabilities.includes(capability)) throw new Error(`${provider} does not support the ${capability} capability`);
  }
  return selected;
}

export function createProviderRegistry(config = {}, dependencies = {}) {
  const selected = validateProviderSelection(config);
  const cache = new Map();
  const make = (name) => {
    if (cache.has(name)) return cache.get(name);
    let provider;
    if (name === "xai") {
      provider = createXaiProvider({
        apiKey: credential(config, "xai", "apiKey"),
        baseUrl: credential(config, "xai", "baseUrl") ?? config.apiBaseUrl,
        retry: config.retry ?? config.generation,
        journal: dependencies.journal,
        fetch: dependencies.fetch,
        sleep: dependencies.sleep,
        random: dependencies.random,
        clock: dependencies.clock,
        logger: dependencies.logger,
        testOrigins: dependencies.testOrigins,
      });
    } else if (name === "gemini") {
      provider = createGeminiProvider({
        apiKey: credential(config, "gemini", "apiKey") ?? config.geminiApiKey,
        baseUrl: credential(config, "gemini", "baseUrl") ?? config.geminiApiBaseUrl,
        retry: config.retry ?? config.generation,
        journal: dependencies.journal,
        fetch: dependencies.fetch,
        sleep: dependencies.sleep,
        random: dependencies.random,
        clock: dependencies.clock,
        logger: dependencies.logger,
        testOrigins: dependencies.testOrigins,
        trustedOrigins: dependencies.trustedOrigins,
      });
    }
    cache.set(name, provider);
    return provider;
  };

  const registry = {
    text: make(selected.text),
    image: make(selected.image),
    judge: make(selected.judge),
    video: make(selected.video),
    selected,
    models: {
      text: config.models?.text ?? null,
      image: config.models?.image ?? null,
      judge: config.models?.judge ?? null,
      video: selected.video === "gemini" ? config.models?.geminiVideo ?? null : config.models?.video ?? null,
    },
  };
  return registry;
}

export const createProviders = createProviderRegistry;

export function supportedDurations(provider, resolution) {
  return provider.supportedDurations(resolution);
}

export function requestedVideoDuration(provider, resolution, requested) {
  const choices = provider.supportedDurations(resolution);
  if (!choices.length) throw new Error("Video provider exposes no supported durations");
  return choices.reduce((best, value) => Math.abs(value - requested) < Math.abs(best - requested) ? value : best);
}

function safeProvider(provider) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) throw new Error("Invalid provider slug");
  return provider;
}

export function videoArtifactDirectory(provider) {
  return `video-${safeProvider(provider)}`;
}

export function finalArtifactDirectory(provider) {
  return `final-${safeProvider(provider)}`;
}

export function finalArtifactPath(outputs, provider, slug = "film") {
  const safeSlug = String(slug).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "film";
  return path.join(outputs, finalArtifactDirectory(provider), `${safeSlug}.mp4`);
}
