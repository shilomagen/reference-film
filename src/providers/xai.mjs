import { download, objectHash, validateRemoteUrl } from "../io.mjs";
import { createHttpClient, isExplicitCapacityRejection, ProviderHttpError } from "./http.mjs";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";

function responseCost(payload) {
  const direct = payload?.usage?.cost_usd ?? payload?.cost_usd;
  if (Number.isFinite(direct)) return direct;
  const ticks = payload?.usage?.cost_in_usd_ticks;
  return Number.isFinite(ticks) ? ticks / 10_000_000_000 : null;
}

export const usageCostUsd = responseCost;

function requestId(payload) {
  return payload?.request_id ?? payload?.id ?? payload?.response_id ?? null;
}

export function extractAssistantJson(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Structured response did not contain text content");
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(stripped);
  } catch (cause) {
    throw new Error("Structured response contained invalid JSON", { cause });
  }
}

function assistantText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Text response did not contain text content");
  return content;
}

function schemaFormat(schema) {
  if (!schema) return undefined;
  return {
    type: "json_schema",
    json_schema: { name: schema.name ?? "response", strict: true, schema: schema.value ?? schema },
  };
}

function isUnsupportedResponseFormat(error) {
  return error instanceof ProviderHttpError && error.status === 400 && error.details?.unsupportedResponseFormat === true;
}

function normalizeConfig(config) {
  const retry = config.retry ?? config.generation ?? {};
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? config.apiBaseUrl ?? DEFAULT_BASE_URL,
    fetch: config.fetch,
    sleep: config.sleep,
    random: config.random,
    clock: config.clock,
    logger: config.logger,
    testOrigins: config.testOrigins ?? [],
    journal: config.journal,
    retry: {
      retries: retry.retries ?? retry.retryCount ?? config.retryCount ?? 7,
      baseDelayMs: retry.baseDelayMs ?? retry.retryBaseDelayMs ?? 2000,
      maxDelayMs: retry.maxDelayMs ?? retry.retryMaxDelayMs ?? 120_000,
      jitterRatio: retry.jitterRatio ?? retry.retryJitterRatio ?? 0.2,
    },
  };
}

export class XaiProvider {
  constructor(config = {}) {
    const normalized = normalizeConfig(config);
    if (!normalized.apiKey) throw new Error("xAI apiKey is required");
    const base = validateRemoteUrl(normalized.baseUrl, { allowedOrigins: normalized.testOrigins });
    this.baseUrl = base.toString().replace(/\/$/, "");
    this.apiKey = normalized.apiKey;
    this.fetch = normalized.fetch ?? globalThis.fetch;
    this.testOrigins = normalized.testOrigins;
    this.journal = normalized.journal;
    this.requestJson = createHttpClient({
      fetch: this.fetch, sleep: normalized.sleep, random: normalized.random,
      clock: normalized.clock, logger: normalized.logger, provider: "xAI", ...normalized.retry,
    });
  }

  async request(endpoint, options = {}) {
    return this.requestJson(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      capacityRejection: isExplicitCapacityRejection,
    });
  }

  async #paid(operation, model, body, endpoint, { timeoutMs, validate } = {}) {
    const submit = async () => this.request(endpoint, {
      method: "POST", paid: true, body, timeoutMs, validate,
    });
    if (!this.journal) return submit();
    const fingerprint = objectHash({ provider: "xai", operation, model, body });
    const journaled = await this.journal.run({ provider: "xai", operation, model, fingerprint }, async ({ checkpointAccepted }) => {
      const payload = await submit();
      const metadata = { requestId: requestId(payload), costUsd: responseCost(payload) };
      if (operation === "video") {
        await checkpointAccepted({ ...metadata, operationId: payload.request_id ?? payload.id });
        return { state: "accepted", metadata, result: payload };
      }
      return { state: "completed", metadata, result: payload };
    });
    if (journaled.reused) return { _journal: journaled.entry };
    return journaled.result;
  }

  async #chat({ model, prompt, images = [], schema, operation }) {
    const imageContent = images.map((image) => ({ type: "image_url", image_url: { url: image, detail: "high" } }));
    const baseBody = {
      model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imageContent] }],
      temperature: 0,
      max_tokens: 3500,
    };
    let payload;
    try {
      payload = await this.#paid(operation, model, {
        ...baseBody,
        ...(schema ? { response_format: schemaFormat(schema) } : {}),
      }, "/chat/completions", { timeoutMs: 300_000 });
    } catch (error) {
      if (!schema || !isUnsupportedResponseFormat(error)) throw error;
      // The provider definitively rejected the unsupported request. The fallback is
      // a distinct paid operation and therefore receives its own durable journal id.
      payload = await this.#paid(`${operation}-schema-fallback`, model, {
        ...baseBody,
        messages: [{ role: "user", content: [
          { type: "text", text: `${prompt}\n\nReturn only JSON matching this schema:\n${JSON.stringify(schema.value ?? schema)}` },
          ...imageContent,
        ] }],
      }, "/chat/completions", { timeoutMs: 300_000 });
    }
    if (payload?._journal) return { reused: true, journal: payload._journal, text: null, json: null, requestId: payload._journal.requestId ?? null, costUsd: payload._journal.costUsd ?? null };
    const text = assistantText(payload);
    return {
      text,
      json: schema ? extractAssistantJson(payload) : null,
      requestId: requestId(payload),
      costUsd: responseCost(payload),
    };
  }

  generateText({ model, prompt, schema }) {
    return this.#chat({ model, prompt, schema, operation: "text" });
  }

  async generateCandidates({ model, prompt, referenceImages = [], count = 1, aspectRatio, resolution, quality }) {
    if (!Array.isArray(referenceImages) || referenceImages.length === 0) throw new Error("At least one reference image is required");
    const imageFields = referenceImages.length === 1
      ? { image: { url: referenceImages[0] } }
      : { images: referenceImages.map((url) => ({ url })) };
    const payload = await this.#paid("image", model, {
      model, prompt, ...imageFields, n: count, aspect_ratio: aspectRatio,
      resolution, quality, response_format: "b64_json",
    }, "/images/edits", { timeoutMs: 600_000 });
    if (payload?._journal) return { images: [], reused: true, journal: payload._journal, requestId: payload._journal.requestId ?? null, costUsd: payload._journal.costUsd ?? null };
    return {
      images: (payload?.data ?? []).map((image) => ({
        data: image.b64_json ?? null,
        url: image.url ?? null,
        revisedPrompt: image.revised_prompt ?? null,
      })),
      requestId: requestId(payload),
      costUsd: responseCost(payload),
    };
  }

  // Compatibility with the original prototype's method name.
  generateImageCandidates(options) {
    return this.generateCandidates({ ...options, referenceImages: options.referenceImages ?? options.references });
  }

  judgeImages({ model, prompt, images, schema }) {
    return this.#chat({ model, prompt, images, schema, operation: "judge" });
  }

  async startVideo({ model, prompt, sourceImage, duration, aspectRatio, resolution, options = {}, image, generateAudio }) {
    const audio = options.generateAudio ?? generateAudio ?? false;
    const payload = await this.#paid("video", model, {
      model, prompt, image: { url: sourceImage ?? image }, duration,
      aspect_ratio: aspectRatio, resolution, generate_audio: audio,
      ...options.providerParameters,
    }, "/videos/generations", { timeoutMs: 120_000 });
    if (payload?._journal) {
      return { status: "pending", operationId: payload._journal.operationId, requestId: payload._journal.requestId ?? null, costUsd: payload._journal.costUsd ?? null, reused: true };
    }
    const operationId = payload?.request_id ?? payload?.id;
    if (!operationId) throw new Error("xAI video response omitted its operation id");
    return { status: "pending", operationId, requestId: requestId(payload), costUsd: responseCost(payload) };
  }

  async getVideo(operationId) {
    if (!operationId || typeof operationId !== "string") throw new Error("operationId is required");
    const payload = await this.request(`/videos/${encodeURIComponent(operationId)}`, { method: "GET", paid: false, timeoutMs: 60_000, retries: 5 });
    const rawStatus = String(payload?.status ?? "").toLowerCase();
    const status = ["done", "completed", "succeeded"].includes(rawStatus) ? "done"
      : ["failed", "error", "rejected"].includes(rawStatus) ? "failed"
      : ["expired"].includes(rawStatus) ? "expired" : "pending";
    return {
      status,
      operationId,
      progress: payload?.progress ?? (status === "done" ? 100 : null),
      video: status === "done" ? { url: payload?.video?.url ?? payload?.url ?? null } : null,
      error: status === "failed" ? { message: payload?.error?.message ?? "Video generation failed" } : null,
      requestId: requestId(payload),
      costUsd: responseCost(payload),
    };
  }

  downloadVideo(url, target) {
    return download(url, target, { fetch: this.fetch, allowedOrigins: this.testOrigins });
  }

  supportedDurations(_resolution) {
    return [6, 10];
  }

  supportsAudioControl() {
    return true;
  }
}

export const XaiClient = XaiProvider;

export function createXaiProvider(config) {
  return new XaiProvider(config);
}
