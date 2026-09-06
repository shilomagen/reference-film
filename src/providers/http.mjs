import { redact, sleep as defaultSleep } from "../io.mjs";

export class ProviderHttpError extends Error {
  constructor(message, { status = null, code = null, retryAfter = null, details = null } = {}) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}

export class AmbiguousPaidRequestError extends Error {
  constructor(message, { cause, status = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AmbiguousPaidRequestError";
    this.status = status;
    this.ambiguous = true;
  }
}

export function parseRetryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

export function retryDelayMs({
  retryAfter = null, attempt, baseDelayMs = 2000, maxDelayMs = 120_000,
  jitterRatio = 0.2, random = Math.random, now = Date.now(),
}) {
  const retryAfterMs = parseRetryAfterMs(retryAfter, now);
  const base = Math.min(maxDelayMs, retryAfterMs ?? baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const factor = 1 + jitterRatio * (random() * 2 - 1);
  const jittered = Math.max(0, Math.min(maxDelayMs, Math.round(base * factor)));
  // Retry-After is a server-requested minimum. Negative jitter must not make a
  // client retry sooner; maxDelayMs is the explicit local cap and sole exception.
  return retryAfterMs === null ? jittered : Math.max(Math.min(maxDelayMs, retryAfterMs), jittered);
}

function errorInfo(payload) {
  const error = payload?.error;
  return {
    message: typeof error === "string" ? error : error?.message ?? payload?.message ?? null,
    code: error?.code ?? payload?.code ?? null,
    type: error?.type ?? payload?.type ?? null,
    status: error?.status ?? payload?.status ?? null,
  };
}

export function isExplicitCapacityRejection(status, payload) {
  const info = errorInfo(payload);
  const text = [info.message, info.code, info.type, info.status].filter(Boolean).join(" ");
  if (status === 429) return true;
  if (![400, 409, 503].includes(status)) return false;
  const overload = /(?:capacity|overload|overloaded|no\s+capacity|resource[_ ]?exhausted)/i.test(text);
  // Capacity language alone (especially on a 5xx) does not prove that a paid
  // submission was rejected before acceptance. Require that assurance in the
  // provider response before allowing another submission.
  const explicitlyUnaccepted = /(?:request|submission|job|operation)?\s*(?:was\s+|is\s+)?(?:rejected|not\s+accepted|not\s+submitted)|rejected\s+(?:before|without)\s+(?:acceptance|submission)/i.test(text);
  return overload && explicitlyUnaccepted;
}

function safeError(status, payload, provider, secrets = []) {
  const info = errorInfo(payload);
  const rawCode = info.code ?? info.type ?? info.status;
  const classification = `${info.message ?? ""} ${rawCode ?? ""}`;
  const code = rawCode === null || rawCode === undefined
    ? null
    : String(redact(String(rawCode), { secrets })).slice(0, 100);
  const error = new ProviderHttpError(`${provider} request failed with HTTP ${status}${code ? ` (${code})` : ""}`, {
    status,
    code,
    details: {
      unsupportedResponseFormat: /(?:response[_ ]format|json[_ ]schema).*(?:unsupported|not supported|invalid|unknown)|(?:unsupported|not supported).*(?:response[_ ]format|json[_ ]schema)/i.test(classification),
    },
  });
  error.definitiveRejection = true;
  return error;
}

export function createHttpClient({
  fetch: fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  random = Math.random,
  clock = Date.now,
  retries = 7,
  baseDelayMs = 2000,
  maxDelayMs = 120_000,
  jitterRatio = 0.2,
  logger = () => {},
  provider = "Provider",
  secrets = [],
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");

  return async function requestJson(url, {
    method = "GET", headers = {}, body, timeoutMs = 300_000,
    retries: requestRetries = retries, paid = method.toUpperCase() !== "GET",
    validate, capacityRejection = isExplicitCapacityRejection,
    redirect = "error",
  } = {}) {
    method = method.toUpperCase();
    const safeGet = method === "GET" || method === "HEAD";
    const attempts = requestRetries + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method, headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs), redirect,
        });
      } catch (cause) {
        if (!safeGet && paid) {
          throw new AmbiguousPaidRequestError(`${provider} paid request outcome is uncertain after a network failure`, { cause });
        }
        if (attempt >= attempts) throw new ProviderHttpError(`${provider} request failed before a response`, { details: { category: "network" } });
        const delay = retryDelayMs({ attempt, baseDelayMs, maxDelayMs, jitterRatio, random, now: clock() });
        logger("Retrying safe provider request after a network failure", { provider, attempt, delayMs: delay });
        await sleep(delay);
        continue;
      }

      let text;
      try {
        text = await response.text();
      } catch (cause) {
        if (!safeGet && paid) {
          throw new AmbiguousPaidRequestError(`${provider} paid request outcome is uncertain because its response could not be read`, { cause, status: response.status });
        }
        if (attempt < attempts) {
          const delay = retryDelayMs({ attempt, baseDelayMs, maxDelayMs, jitterRatio, random, now: clock() });
          await sleep(delay);
          continue;
        }
        throw new ProviderHttpError(`${provider} response could not be read`, { status: response.status });
      }

      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch (cause) {
        if (response.ok && !safeGet && paid) {
          throw new AmbiguousPaidRequestError(`${provider} paid request succeeded but returned malformed JSON`, { cause, status: response.status });
        }
        if (response.ok) throw new ProviderHttpError(`${provider} returned malformed JSON`, { status: response.status });
        payload = {};
      }

      if (response.ok) {
        if (validate) {
          try {
            const validated = validate(payload);
            if (validated === false) throw new Error("response validation failed");
          } catch (cause) {
            if (!safeGet && paid) {
              throw new AmbiguousPaidRequestError(`${provider} paid request succeeded but its response was invalid`, { cause, status: response.status });
            }
            throw new ProviderHttpError(`${provider} returned an invalid response`, { status: response.status });
          }
        }
        return payload;
      }

      const explicitlyRejected = !safeGet && paid && capacityRejection(response.status, payload);
      const safeRetryable = safeGet && [408, 409, 425, 429, 500, 502, 503, 504].includes(response.status);
      const paidRetryable = !safeGet && paid && (response.status === 429 || explicitlyRejected);
      // A non-explicit 5xx may have accepted a paid submission.
      if (!safeGet && paid && response.status >= 500 && !explicitlyRejected) {
        throw new AmbiguousPaidRequestError(`${provider} paid request outcome is uncertain after HTTP ${response.status}`, { status: response.status });
      }
      const requestSecrets = [...secrets];
      for (const [name, value] of Object.entries(headers)) {
        if (/^(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key)$/i.test(name) && typeof value === "string") {
          requestSecrets.push(value, value.replace(/^\s*(?:Bearer|Basic)\s+/i, ""));
        }
      }
      const error = safeError(response.status, payload, provider, requestSecrets);
      error.retryAfter = response.headers.get("retry-after");
      if (!(safeRetryable || paidRetryable) || attempt >= attempts) throw error;
      const delay = retryDelayMs({
        retryAfter: error.retryAfter, attempt, baseDelayMs, maxDelayMs,
        jitterRatio, random, now: clock(),
      });
      logger("Retrying explicitly rejected provider request", {
        provider, method, status: response.status, attempt, delayMs: delay,
      });
      await sleep(delay);
    }
    throw new ProviderHttpError(`${provider} request exhausted retries`);
  };
}
