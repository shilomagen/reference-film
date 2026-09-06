import path from "node:path";
import { objectHash, readJson, sanitizeMetadata, writeJson } from "../io.mjs";

export class PaidOperationBlockedError extends Error {
  constructor(message, entry) {
    super(message);
    this.name = "PaidOperationBlockedError";
    this.entry = entry;
    this.journalId = entry?.id ?? null;
  }
}

export class PaidOperationResultUnavailableError extends Error {
  constructor(entry) {
    super(`Paid operation ${entry.id} completed, but its result is not persisted; recover the local artifact or explicitly authorize one replacement submission`);
    this.name = "PaidOperationResultUnavailableError";
    this.entry = entry;
    this.journalId = entry.id;
    this.resultUnavailable = true;
  }
}

const TERMINAL_SUCCESS = new Set(["completed"]);
const BLOCKING = new Set(["submission_started", "accepted", "uncertain"]);
const SAFE_METADATA_KEYS = new Set([
  "requestId", "operationId", "providerRequestId", "model", "provider", "operation",
  "costUsd", "currency", "units", "status", "reason", "code",
]);

function nonSecretMetadata(value) {
  const sanitized = sanitizeMetadata(value ?? {});
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return {};
  return Object.fromEntries(Object.entries(sanitized).filter(([key, item]) =>
    SAFE_METADATA_KEYS.has(key) && (item === null || ["string", "number", "boolean"].includes(typeof item))));
}

export class PaidOperationJournal {
  constructor(directory, { clock = () => new Date(), write = writeJson } = {}) {
    this.directory = directory;
    this.clock = clock;
    this.write = write;
  }

  pathFor(id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) throw new Error("Invalid paid-operation journal id");
    return path.join(this.directory, `${id}.json`);
  }

  get(id) {
    return readJson(this.pathFor(id), null);
  }

  #save(entry) {
    this.write(this.pathFor(entry.id), entry);
    return entry;
  }

  #event(entry, state, metadata = {}) {
    const event = { state, at: this.clock().toISOString(), ...nonSecretMetadata(metadata) };
    entry.state = state;
    entry.updatedAt = event.at;
    entry.history ??= [];
    entry.history.push(event);
    for (const key of ["requestId", "operationId", "providerRequestId", "costUsd", "currency", "units"]) {
      if (event[key] !== undefined) entry[key] = event[key];
    }
    return this.#save(entry);
  }

  authorizeRetry(id, reason, { acknowledgeDuplicateRisk = false } = {}) {
    if (acknowledgeDuplicateRisk !== true) throw new Error("authorizeRetry requires acknowledgeDuplicateRisk: true");
    if (typeof reason !== "string" || !reason.trim()) throw new Error("authorizeRetry requires a non-empty reason");
    const entry = this.get(id);
    if (!entry) throw new Error(`Paid operation ${id} does not exist`);
    const resultMode = entry.resultMode ?? "synchronous";
    const completedSynchronous = entry.state === "completed" && resultMode === "synchronous";
    if (entry.state === "accepted" && entry.operationId) {
      throw new PaidOperationBlockedError(`Paid operation ${id} has an accepted operationId and must be resumed by polling, not resubmitted`, entry);
    }
    if (!BLOCKING.has(entry.state) && !completedSynchronous) {
      throw new PaidOperationBlockedError(`Paid operation ${id} is not eligible for an explicitly authorized retry`, entry);
    }
    entry.retryAuthorization = {
      remaining: 1,
      reason: String(sanitizeMetadata(reason)).slice(0, 500),
      acknowledgedAt: this.clock().toISOString(),
      previousState: entry.state,
    };
    return this.#event(entry, "retry_authorized", { reason });
  }

  markCompleted(id, metadata = {}) {
    const entry = this.get(id);
    if (!entry) throw new Error(`Paid operation ${id} does not exist`);
    return this.#event(entry, "completed", metadata);
  }

  markFailed(id, metadata = {}) {
    const entry = this.get(id);
    if (!entry) throw new Error(`Paid operation ${id} does not exist`);
    return this.#event(entry, "failed", metadata);
  }

  async run(details, submit) {
    const {
      id, provider, operation, model = null, fingerprint, operationKey = null,
      resultMode = "synchronous", resumeAccepted = false,
    } = details;
    if (typeof submit !== "function") throw new TypeError("submit callback is required");
    if (!provider || !operation || !fingerprint) throw new Error("provider, operation, and fingerprint are required");
    if (!new Set(["synchronous", "asynchronous"]).has(resultMode)) throw new Error("resultMode must be synchronous or asynchronous");
    if (operationKey !== null && (typeof operationKey !== "string" || !operationKey.trim())) throw new Error("operationKey must be a non-empty string");
    const calculatedId = id ?? objectHash(operationKey === null
      ? { provider, operation, model, fingerprint }
      : { provider, operation, model, operationKey, fingerprint }).slice(0, 32);
    let entry = this.get(calculatedId);

    if (entry) {
      const entryResultMode = entry.resultMode ?? resultMode;
      if (entry.fingerprint !== fingerprint || entry.provider !== provider || entry.operation !== operation || entry.model !== model || entryResultMode !== resultMode) {
        throw new PaidOperationBlockedError(`Paid operation ${calculatedId} does not match its durable fingerprint`, entry);
      }
      if (entry.resultMode === undefined) {
        entry.resultMode = resultMode;
        this.#save(entry);
      }
      if (entry.state === "accepted" && resultMode === "asynchronous" && resumeAccepted && entry.operationId) {
        return { reused: true, entry };
      }
      if (TERMINAL_SUCCESS.has(entry.state)) return { reused: true, entry };
      if (entry.state === "retry_authorized" && entry.retryAuthorization?.remaining === 1) {
        entry.retryAuthorization.remaining = 0;
        this.#event(entry, "submission_started", { reason: "authorized retry consumed" });
      } else if (BLOCKING.has(entry.state) || entry.state === "retry_authorized") {
        throw new PaidOperationBlockedError(
          `Paid operation ${calculatedId} will not be submitted automatically; reconcile it and call authorizeRetry with explicit duplicate-risk acknowledgement`,
          entry,
        );
      } else {
        // Definitive provider rejection/failed pre-acceptance is safe to submit again.
        this.#event(entry, "submission_started", { reason: "retry after definitive rejection" });
      }
    } else {
      entry = {
        version: 2,
        id: calculatedId,
        provider,
        operation,
        model,
        fingerprint,
        resultMode,
        createdAt: this.clock().toISOString(),
        history: [],
      };
      this.#event(entry, "submission_started");
    }

    let checkpointed = false;
    const checkpointAccepted = async (metadata = {}) => {
      checkpointed = true;
      this.#event(entry, "accepted", metadata);
      return entry;
    };

    try {
      const outcome = await submit({ id: calculatedId, checkpointAccepted, entry: structuredClone(entry) });
      const state = outcome?.state ?? (checkpointed ? "accepted" : "completed");
      const metadata = outcome?.metadata ?? {};
      if (!new Set(["accepted", "completed", "rejected", "failed"]).has(state)) {
        throw new Error(`Unsupported paid-operation outcome state: ${state}`);
      }
      this.#event(entry, state === "rejected" ? "failed" : state, metadata);
      return { reused: false, entry, result: outcome?.result };
    } catch (error) {
      if (error && typeof error === "object" && error.journalId === undefined) error.journalId = calculatedId;
      if (error?.definitiveRejection === true) {
        this.#event(entry, "failed", { reason: error.message, code: error.code });
      } else if (checkpointed && entry.operationId) {
        // Once a known asynchronous operation has been durably accepted, a
        // later local failure cannot make its provider identity ambiguous.
        this.#event(entry, "accepted", { reason: error?.message, code: error?.code });
      } else {
        this.#event(entry, "uncertain", { reason: error?.message, code: error?.code });
      }
      throw error;
    }
  }
}

export function createPaidOperationJournal(directory, options) {
  return new PaidOperationJournal(directory, options);
}
