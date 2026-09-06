import { download, objectHash, validateRemoteUrl } from "../io.mjs";
import { createHttpClient } from "./http.mjs";

export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_TRUSTED_ORIGINS = Object.freeze([
  "https://generativelanguage.googleapis.com",
]);

export function parseDataUri(value) {
  const match = String(value).match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error("Gemini image input must be a base64 data URI");
  return { mimeType: match[1], bytesBase64Encoded: match[2].replace(/\s/g, "") };
}

export function validateOperationName(value) {
  const name = String(value ?? "");
  if (!name || name.startsWith("/") || name.includes("//") || name.includes("?") || name.includes("#") || name.includes("\\")) {
    throw new Error("Gemini operation name must be a safe relative resource");
  }
  const segments = name.split("/");
  if (segments.some((segment) => !/^[A-Za-z0-9._~-]+$/.test(segment)) || !segments.includes("operations")) {
    throw new Error("Gemini operation name is invalid");
  }
  return name;
}

function normalizeConfig(config) {
  const retry = config.retry ?? config.generation?.retry ?? config.generation ?? {};
  return {
    apiKey: config.apiKey ?? config.geminiApiKey,
    baseUrl: config.baseUrl ?? config.geminiApiBaseUrl ?? DEFAULT_GEMINI_BASE_URL,
    fetch: config.fetch,
    sleep: config.sleep,
    random: config.random,
    clock: config.clock,
    logger: config.logger,
    testOrigins: config.testOrigins ?? [],
    trustedOrigins: config.trustedOrigins ?? DEFAULT_GEMINI_TRUSTED_ORIGINS,
    journal: config.journal,
    retry: {
      retries: retry.retries ?? retry.retryCount ?? retry.attempts ?? 7,
      baseDelayMs: retry.baseDelayMs ?? retry.retryBaseDelayMs ?? 2000,
      maxDelayMs: retry.maxDelayMs ?? retry.retryMaxDelayMs ?? 120_000,
      jitterRatio: retry.jitterRatio ?? retry.retryJitterRatio ?? retry.jitter ?? 0.2,
    },
  };
}

export class GeminiProvider {
  constructor(config = {}) {
    const normalized = normalizeConfig(config);
    if (!normalized.apiKey) throw new Error("Gemini apiKey is required");
    const allowedOrigins = [...normalized.trustedOrigins, ...normalized.testOrigins];
    const base = validateRemoteUrl(normalized.baseUrl, { allowedOrigins });
    if (!allowedOrigins.includes(base.origin)) throw new Error("Gemini base URL origin is not trusted");
    if (base.protocol !== "https:" && !normalized.testOrigins.includes(base.origin)) {
      throw new Error("Only explicitly injected test origins may use HTTP");
    }
    this.apiKey = normalized.apiKey;
    this.baseUrl = base.toString().replace(/\/$/, "");
    this.fetch = normalized.fetch ?? globalThis.fetch;
    this.allowedOrigins = allowedOrigins;
    this.journal = normalized.journal;
    this.requestJson = createHttpClient({
      fetch: this.fetch, sleep: normalized.sleep, random: normalized.random,
      clock: normalized.clock, logger: normalized.logger, provider: "Gemini", ...normalized.retry,
    });
  }

  request(resource, options = {}) {
    const safe = String(resource ?? "");
    if (!safe || safe.startsWith("/") || safe.includes("//") || safe.includes("?") || safe.includes("#") || safe.includes("\\") ||
        safe.split("/").some((segment) => !/^[A-Za-z0-9._~:-]+$/.test(segment))) {
      throw new Error("Gemini resource name is invalid");
    }
    return this.requestJson(`${this.baseUrl}/${safe}`, {
      ...options,
      redirect: "error",
      headers: {
        "x-goog-api-key": this.apiKey,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
    });
  }

  async startVideo({ model, prompt, sourceImage, duration, aspectRatio, resolution, options = {}, image, negativePrompt }) {
    if (!/^[A-Za-z0-9._~-]+$/.test(model)) throw new Error("Invalid Gemini model id");
    const imageInput = parseDataUri(sourceImage ?? image);
    const body = {
      instances: [{ prompt, image: imageInput }],
      parameters: {
        aspectRatio,
        durationSeconds: duration,
        resolution,
        personGeneration: options.personGeneration ?? "allow_adult",
        sampleCount: 1,
        ...((options.negativePrompt ?? negativePrompt) ? { negativePrompt: options.negativePrompt ?? negativePrompt } : {}),
      },
    };
    const submit = () => this.request(`models/${model}:predictLongRunning`, {
      method: "POST", paid: true, body, timeoutMs: 120_000,
      validate: (payload) => typeof payload?.name === "string",
    });
    let payload;
    if (this.journal) {
      const fingerprint = objectHash({ provider: "gemini", operation: "video", model, body });
      const journaled = await this.journal.run({ provider: "gemini", operation: "video", model, fingerprint }, async ({ checkpointAccepted }) => {
        const response = await submit();
        const operationId = validateOperationName(response.name);
        await checkpointAccepted({ operationId });
        return { state: "accepted", metadata: { operationId }, result: response };
      });
      if (journaled.reused) {
        return { status: "pending", operationId: journaled.entry.operationId, requestId: journaled.entry.operationId, costUsd: journaled.entry.costUsd ?? null, reused: true };
      }
      payload = journaled.result;
    } else {
      payload = await submit();
    }
    const operationId = validateOperationName(payload.name);
    return { status: "pending", operationId, requestId: operationId, costUsd: null };
  }

  async getVideo(operationId) {
    const operationName = validateOperationName(operationId);
    const response = await this.request(operationName, { method: "GET", paid: false, retries: 5, timeoutMs: 60_000 });
    if (!response.done) return { status: "pending", progress: response.metadata?.progressPercent ?? null, operationId: operationName };
    if (response.error) {
      const text = `${response.error.status ?? ""} ${response.error.message ?? ""}`;
      const status = /expire|not.?found/i.test(text) ? "expired" : /safety|filter|rai/i.test(text) ? "filtered" : "failed";
      return { status, operationId: operationName, error: { code: response.error.code ?? null, message: response.error.message ?? "Gemini video generation failed" } };
    }
    const generatedResponse = response.response?.generateVideoResponse;
    const reasons = generatedResponse?.raiMediaFilteredReasons ?? [];
    if (Number(generatedResponse?.raiMediaFilteredCount ?? 0) > 0 || reasons.length > 0) {
      return {
        status: "filtered", operationId: operationName, filtered: true,
        filteredReasons: reasons,
        error: { message: reasons.join("; ") || "Gemini safety filtering rejected the video" },
      };
    }
    const generated = generatedResponse?.generatedSamples?.[0] ?? response.response?.generatedVideos?.[0];
    const video = generated?.video ?? generated;
    const url = video?.uri ?? video?.url;
    if (!url) return { status: "failed", operationId: operationName, error: { message: "Completed Gemini operation omitted its video URI" } };
    this.#validateDownloadUrl(url);
    return {
      status: "done", progress: 100, operationId: operationName,
      model: response.response?.model ?? null, video: { url }, costUsd: null,
    };
  }

  #validateDownloadUrl(value) {
    const url = validateRemoteUrl(value, { allowedOrigins: this.allowedOrigins });
    if (!this.allowedOrigins.includes(url.origin)) throw new Error("Gemini download URI origin is not trusted");
    return url;
  }

  downloadVideo(url, target) {
    const safe = this.#validateDownloadUrl(url);
    return download(safe, target, {
      fetch: this.fetch,
      headers: { "x-goog-api-key": this.apiKey },
      allowedOrigins: this.allowedOrigins,
      credentialOrigins: this.allowedOrigins,
    });
  }

  supportedDurations(resolution) {
    return String(resolution).toLowerCase() === "720p" ? [4, 6, 8] : [8];
  }

  supportsAudioControl() {
    return false;
  }
}

export const GeminiClient = GeminiProvider;

export function createGeminiProvider(config) {
  return new GeminiProvider(config);
}
