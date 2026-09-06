# Provider contracts

The provider layer is standalone Node.js ESM and has no runtime dependencies. It does not import application configuration. Callers supply normalized settings and injected test dependencies directly.

## Configuration

`createProviderRegistry(config, dependencies)` accepts:

```js
{
  providers: { text: "xai", image: "xai", judge: "xai", video: "gemini" },
  models: {
    text: "text-model", image: "image-model", judge: "judge-model",
    video: "xai-video-model", geminiVideo: "veo-model"
  },
  // Explicit top-level credentials remain supported...
  apiKey: "...", apiBaseUrl: "https://api.x.ai/v1",
  geminiApiKey: "...", geminiApiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  // ...as does a nested map:
  credentials: {
    xai: { apiKey: "...", baseUrl: "https://api.x.ai/v1" },
    gemini: { apiKey: "...", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }
  },
  retry: { retries: 7, baseDelayMs: 2000, maxDelayMs: 120000, jitterRatio: 0.2 }
}
```

The registry also consumes `loadConfig`'s non-enumerable flat credential object (`xaiApiKey`, `xaiBaseUrl`, `geminiApiKey`, `geminiBaseUrl`) and maps `generation.retry.{attempts,baseDelayMs,maxDelayMs,jitter}` to the adapter retry policy. Gemini never inherits the legacy top-level xAI `apiKey`.

The registry selects every capability independently. xAI supports `text`, `image`, `judge`, and `video`; Gemini supports `video` only. Unsupported combinations fail during registry creation. Capability properties (`text`, `image`, `judge`, and `video`) instantiate their selected adapter lazily, so credentials are required only when that capability is accessed. Capabilities selecting the same provider share one cached adapter instance. `selected` and `models` remain immediately available without constructing an adapter.

Individual adapters may be created with `createXaiProvider({apiKey, baseUrl, retry, ...})` and `createGeminiProvider({apiKey, baseUrl, retry, ...})`. Tests can inject `fetch`, `sleep`, `random`, `clock`, and explicit `testOrigins`. Plain HTTP is rejected unless its exact loopback origin is injected. Production Gemini credentials are restricted to `https://generativelanguage.googleapis.com`; extra trusted origins must be an explicit application decision.

## Capability API

### xAI

- `generateText({model, prompt, schema?, operationKey?}) -> {text, json, requestId, costUsd}`
- `generateCandidates({model, prompt, referenceImages, count, aspectRatio, resolution, quality, operationKey?}) -> {images, requestId, costUsd}`
- `judgeImages({model, prompt, images, schema, operationKey?}) -> {text, json, requestId, costUsd}`
- `startVideo({model, prompt, sourceImage, duration, aspectRatio, resolution, options?, operationKey?}) -> {status, operationId, requestId, costUsd, reused?}`
- `getVideo(operationId) -> {status, operationId, progress, video?, error?, costUsd}`
- `downloadVideo(url, target)`
- `supportedDurations(resolution) -> number[]` (`[1, 2, ..., 15]`)
- `supportsAudioControl() -> true`

For text and judging, `schema` is `{name, value}` (or a JSON Schema directly). JSON is parsed and validated by the caller against its application schema; malformed JSON is reported and never repaired by another paid request. The adapter falls back from native response formatting only when a 400 response explicitly says response format or JSON Schema is unsupported. Unknown cost is `null`, never zero.

Every paid method above accepts `operationKey`; `workKey` is an exact alias for migration. If both are supplied they must match. The key is a non-empty caller-owned durable identity such as `scene-7/image/round-2`, `scene-7/image-judge/round-2`, `script/draft-1`, or `scene-7/video/attempt-3`. It is included with the request fingerprint in journal identity but never in the provider HTTP body. Reusing a key with the same body means resume that exact attempt and never automatically POST it again. A deliberately different key permits a new paid call even when the request body is identical. Callers should persist or deterministically reconstruct keys from durable project/scene/round/attempt identities. Omitting it preserves legacy body-fingerprint deduplication for standalone consumers.

### Gemini Veo

- `startVideo(...)`, `getVideo(...)`, and `downloadVideo(...)` use the same normalized video shapes.
- Poll status is one of `pending`, `done`, `failed`, `filtered`, or `expired`.
- `supportedDurations("720p")` is `[4, 6, 8]`; 1080p/4k supports `[8]`.
- `supportsAudioControl()` is `false`. Model-generated audio must be removed in assembly.

These duration maps describe the currently implemented interfaces, not permanent provider availability; upstream products can evolve. No live paid-provider tests were run for this contract update.

Operation names must be safe relative resources containing an `operations` segment. Download URLs are checked before the API key is sent. Redirects are handled manually by the IO layer and credentials are never forwarded to a changed or untrusted origin.

## HTTP safety

`createHttpClient(policy)` returns `requestJson(url, options)`. Safe GET/HEAD requests retry transient network errors and HTTP 408/409/425/429/5xx. Paid POST retries are limited to 429 or a provider response that explicitly says capacity rejection/not accepted. An ambiguous network failure, timeout, successful-response read/JSON/validation failure, or non-explicit 5xx throws `AmbiguousPaidRequestError` after exactly one submission. Errors contain bounded status/message data, not response bodies, request payloads, full URLs, or tokens.

`Retry-After` accepts seconds or HTTP dates. It is treated as a server-requested minimum and negative jitter cannot shorten it; an explicitly configured `maxDelayMs` remains the upper cap. Delay exponent, header delay, and final jittered value are capped. Defaults are seven retries, 2 seconds, 120 seconds, and 20% jitter.

## Durable paid-operation journal

Create a journal with:

```js
const journal = createPaidOperationJournal("outputs/paid-operations");
```

The low-level wrapper API is:

```js
await journal.run(
  { id?, provider, operation, model, fingerprint, operationKey?, resultMode?, resumeAccepted? },
  async ({ id, checkpointAccepted, entry }) => {
    const response = await paidPost();
    // Mandatory immediately after an async operation is accepted and before polling:
    await checkpointAccepted({ operationId: response.name, requestId: response.requestId });
    return {
      state: "accepted", // or completed/rejected/failed
      metadata: { operationId: response.name, costUsd: response.costUsd },
      result: response // returned to this process; never persisted
    };
  }
);
```

A `submission_started` record is atomically written **before** callback invocation. States are `submission_started`, `accepted`, `completed`, `uncertain`, `retry_authorized`, and `failed`. A restart in started/uncertain state throws `PaidOperationBlockedError`; a generic force flag cannot bypass this API. For low-level async use, pass `resultMode: "asynchronous", resumeAccepted: true`. An adapter restart for an accepted asynchronous record with a known operation ID returns `{status: "pending", operationId, reused: true}` without POSTing, so the caller continues with `getVideo(operationId)`. Accepted async jobs with known IDs cannot be authorized for resubmission.

A completed synchronous record cannot reproduce its unpersisted response. The adapter throws `PaidOperationResultUnavailableError`, whose `journalId` identifies the record. Recover the local result if possible. If it is genuinely lost, replacement is deliberately separate:

```js
journal.authorizeRetry(error.journalId, "local response was lost", {
  acknowledgeDuplicateRisk: true
});
```

This requires both a non-empty reason and literal `acknowledgeDuplicateRisk: true`; there is no force/yes shortcut. It records the prior state and permits exactly one callback invocation. A further replacement requires a new explicit authorization, preserving every attempt in `history`. Historical events, request/operation IDs, and costs remain in `history`. Only a small metadata allow-list is persisted; operation keys, prompts, payloads, response results, URLs, and base64 media are not. Completed creative output remains the caller's responsibility. Invalid successful paid response bodies are recorded as `uncertain`, never falsely `completed`; there is no automated paid repair.

Definitive rejection is represented as `failed` and can be submitted again under caller policy. All other thrown callback errors become `uncertain` unless the error has `definitiveRejection === true`.

## Helpers

- `requestedVideoDuration(provider, resolution, seconds)` chooses the nearest advertised duration.
- `videoArtifactDirectory(provider)` and `finalArtifactDirectory(provider)` isolate providers.
- `finalArtifactPath(outputs, provider, slug)` creates a generic sanitized final filename.
- `extractAssistantJson`, `usageCostUsd`, `parseDataUri`, and the HTTP error classes are exported for orchestration and tests.
