import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|cookie|set-cookie)$/i;
const SENSITIVE_KEY = /(?:^|_)(?:api_?key|authorization|access_?token|refresh_?token|secret|password|credential)(?:$|_)/i;
const SIGNED_QUERY_KEY = /^(?:x-amz-|x-goog-|signature$|sig$|token$|key$|expires$|credential$)/i;
const DATA_URI = /^data:[^;,]+;base64,[a-z0-9+/=\s]+$/i;
const LONG_BASE64 = /^(?:[A-Za-z0-9+/]{4}){20,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

export function existsNonEmpty(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function temporaryPath(filePath, suffix) {
  return `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.${suffix}`;
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporary = temporaryPath(filePath, "tmp");
  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = temporaryPath(filePath, "tmp");
  try {
    const handle = await fsp.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, filePath);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

export function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export const fileHash = sha256;

export function canonicalJson(value) {
  const ancestors = new Set();
  function normalize(item) {
    if (item === null || typeof item !== "object") {
      if (typeof item === "bigint") throw new TypeError("Cannot canonicalize bigint values");
      return item;
    }
    if (ancestors.has(item)) throw new TypeError("Cannot canonicalize cyclic values");
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      result = item.map((entry) => normalize(entry));
    } else {
      result = {};
      for (const key of Object.keys(item).sort()) {
        if (item[key] !== undefined) result[key] = normalize(item[key]);
      }
    }
    ancestors.delete(item);
    return result;
  }
  return JSON.stringify(normalize(value));
}

export function objectHash(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function mimeFor(filePath) {
  const bytes = fs.readFileSync(filePath).subarray(0, 16);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const mime = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp",
  }[path.extname(filePath).toLowerCase()];
  if (!mime) throw new Error(`Unsupported image type: ${path.basename(filePath)}`);
  return mime;
}

export function toDataUri(filePath) {
  return `data:${mimeFor(filePath)};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

export function sanitizeUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return "[REDACTED URL]";
  }
  if ([...parsed.searchParams.keys()].some((key) => SIGNED_QUERY_KEY.test(key))) parsed.search = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

export function redact(value, { secrets = [] } = {}) {
  const knownSecrets = secrets.filter((secret) => typeof secret === "string" && secret.length > 0);
  const seen = new WeakSet();
  function clean(item, key = "") {
    if (typeof item === "string") {
      if (SENSITIVE_KEY.test(key) || SENSITIVE_HEADER.test(key)) return "[REDACTED]";
      if (DATA_URI.test(item) || LONG_BASE64.test(item.replace(/\s/g, ""))) return "[REDACTED BASE64]";
      let output = item;
      for (const secret of knownSecrets) output = output.split(secret).join("[REDACTED]");
      output = output.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]");
      output = output.replace(/https?:\/\/[^\s<>"']+/gi, (url) => sanitizeUrl(url));
      return output;
    }
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) return "[REDACTED CYCLE]";
    seen.add(item);
    if (item instanceof Error) {
      const error = { name: item.name, message: clean(item.message, "message") };
      if (item.code) error.code = clean(item.code, "code");
      if (item.status) error.status = item.status;
      return error;
    }
    if (Array.isArray(item)) return item.map((entry) => clean(entry));
    const result = {};
    for (const [childKey, child] of Object.entries(item)) {
      result[childKey] = clean(child, childKey);
    }
    return result;
  }
  return clean(value);
}

export const sanitizeMetadata = redact;

export function safeSerialize(value, options) {
  return JSON.stringify(redact(value, options));
}

function normalizeOrigins(origins = []) {
  return new Set(origins.map((origin) => new URL(origin).origin));
}

export function validateRemoteUrl(value, { allowedOrigins = [], requireHttps = true } = {}) {
  const url = new URL(value);
  const allowed = normalizeOrigins(allowedOrigins);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(allowed.has(url.origin) && url.protocol === "http:" && loopback)) {
    throw new Error(requireHttps ? "Remote URL must use HTTPS (HTTP is test-only on loopback)" : "Remote URL uses an unsupported protocol");
  }
  if (!allowed.size && requireHttps && url.protocol !== "https:") throw new Error("Remote URL must use HTTPS");
  return url;
}

function hasCredentials(headers) {
  return Object.keys(headers).some((name) => SENSITIVE_HEADER.test(name));
}

async function fetchFollowingSafeRedirects(url, options) {
  const {
    fetchImpl, headers, signal, allowedOrigins, credentialOrigins, maxRedirects,
  } = options;
  let current = validateRemoteUrl(url, { allowedOrigins });
  const allowed = normalizeOrigins(allowedOrigins);
  const credentialsAllowed = normalizeOrigins(credentialOrigins);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (hasCredentials(headers) && !credentialsAllowed.has(current.origin)) {
      const error = new Error("Refusing to send credentials to an untrusted origin");
      error.retryable = false;
      throw error;
    }
    const response = await fetchImpl(current, { method: "GET", headers, signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirect === maxRedirects) throw new Error("Too many download redirects");
    const location = response.headers.get("location");
    if (!location) throw new Error("Download redirect omitted its location");
    const next = validateRemoteUrl(new URL(location, current), { allowedOrigins });
    if (hasCredentials(headers) && (!credentialsAllowed.has(next.origin) || next.origin !== current.origin)) {
      const error = new Error("Refusing to forward credentials across a redirect");
      error.retryable = false;
      throw error;
    }
    if (allowed.size && !allowed.has(next.origin)) {
      const error = new Error("Download redirected to an unexpected origin");
      error.retryable = false;
      throw error;
    }
    current = next;
  }
  throw new Error("Too many download redirects");
}

export async function download(url, target, {
  headers = {}, retries = 3, timeoutMs = 120_000, fetch: fetchImpl = globalThis.fetch,
  allowedOrigins = [], credentialOrigins = allowedOrigins, maxRedirects = 3,
  sleep: sleepImpl = sleep,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  ensureDir(path.dirname(target));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const temporary = temporaryPath(target, "download");
    try {
      const response = await fetchFollowingSafeRedirects(url, {
        fetchImpl, headers, signal: AbortSignal.timeout(timeoutMs), allowedOrigins,
        credentialOrigins, maxRedirects,
      });
      if (!response.ok || !response.body) {
        const error = new Error(`Download failed with HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error("Downloaded an empty file");
      await fsp.writeFile(temporary, bytes, { mode: 0o600 });
      await fsp.rename(temporary, target);
      return target;
    } catch (error) {
      lastError = error;
      await fsp.rm(temporary, { force: true });
      const transient = error?.retryable !== false && (error?.status === undefined || [408, 409, 425, 429, 500, 502, 503, 504].includes(error.status));
      if (attempt >= retries || !transient) break;
      await sleepImpl(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
  throw lastError;
}

export function runProcess(command, args, { cwd, capture = false, secrets = [], maxErrorLength = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const detail = stderr ? String(redact(stderr.trim().slice(-maxErrorLength), { secrets })) : "";
        reject(new Error(`${path.basename(command)} exited with ${code}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}

export function spawnFfmpeg(args, options = {}) {
  return runProcess(options.command ?? "ffmpeg", args, options);
}

export async function executableAvailable(name) {
  try {
    await runProcess(name, ["-version"], { capture: true });
    return true;
  } catch {
    return false;
  }
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function mapLimit(items, concurrency, mapper) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a positive integer");
  const values = Array.from(items);
  const results = new Array(values.length);
  const failures = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  if (failures.length) {
    failures.sort((a, b) => a.index - b.index);
    const summary = failures.map(({ index, error }) => `#${index + 1}: ${redact(error?.message ?? String(error))}`).join("; ");
    const aggregate = new AggregateError(failures.map(({ error }) => error), `${failures.length} item(s) failed: ${summary}`);
    aggregate.failures = failures;
    throw aggregate;
  }
  return results;
}

export function sceneDirectory(outputs, allScenes, scene) {
  const index = allScenes.findIndex((item) => item.scene_id === scene.scene_id);
  if (index < 0) throw new Error(`Scene is not present in the plan: ${scene.scene_id}`);
  return path.join(outputs, "scenes", `${String(index + 1).padStart(2, "0")}_${scene.scene_id}`);
}

export function createLogger({ stream = process.stdout, secrets = [], clock = () => new Date() } = {}) {
  return (message, metadata) => {
    const timestamp = clock().toISOString().slice(11, 19);
    const cleanMessage = redact(String(message), { secrets });
    const suffix = metadata === undefined ? "" : ` ${safeSerialize(metadata, { secrets })}`;
    stream.write(`[${timestamp}] ${cleanMessage}${suffix}\n`);
  };
}

export const log = createLogger();
