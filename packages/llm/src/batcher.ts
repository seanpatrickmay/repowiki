import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  MessageBatch,
  MessageBatchResult,
} from "@anthropic-ai/sdk/resources/messages/batches";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { LlmError } from "./provider.ts";

export interface BatchProgress {
  id: string;
  status: string;
  processing: number;
  succeeded: number;
  errored: number;
}

export interface BatcherOptions {
  /** Wait between status polls while the batch is in progress. Defaults to 5000. */
  pollIntervalMs?: number;
  /** Maximum wait between polls. Defaults to 60000. */
  maxPollIntervalMs?: number;
  /**
   * Give up on a batch this long after creating it: cancel it and reject its requests. No limit
   * by default; the API ends every batch within 24 hours.
   */
  deadlineMs?: number;
  /** Custom sleep function for testing. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Millisecond clock for the deadline. Defaults to Date.now. */
  now?: () => number;
  onProgress?: (progress: BatchProgress) => void;
  /** Called once per created batch, before the first poll, so a caller can record its id. */
  onBatchCreated?: (batch: { id: string; requests: number }) => void;
  /** Remembers which batch holds each request, so a later run can collect instead of resend. */
  journal?: BatchJournal;
}

/** Where a request was sent: its batch, its custom id there, and when the batch was created. */
export interface JournalEntry {
  batchId: string;
  customId: string;
  createdAt: string;
}

/**
 * Persists submitted batch requests by request key (e.g. in the store) until their answers are
 * collected, so only a batch whose results a run never read is resumed.
 */
export interface BatchJournal {
  lookup(requestKey: string): JournalEntry | null;
  record(
    batchId: string,
    createdAt: string,
    items: readonly { requestKey: string; customId: string }[],
  ): void;
  /**
   * Drops requests whose answers batchId gave. A row that now points at another batch (the same
   * request sent again) must be kept.
   */
  forget(batchId: string, requestKeys: readonly string[]): void;
}

/** Sends one request through the Message Batches API and resolves with its message. */
export type Batcher = (params: MessageCreateParamsNonStreaming) => Promise<Message>;

interface Queued {
  params: MessageCreateParamsNonStreaming;
  resolve: (message: Message) => void;
  reject: (error: unknown) => void;
  /** Batches this request has been sent in so far. */
  attempts: number;
  /** Set once the request's promise is settled, so a queued-again request is not sent after that. */
  settled: boolean;
}

/** Downloads of a finished batch's results are tried this many times before giving up. */
export const RESULTS_ATTEMPTS = 3;

/**
 * A request whose batch item errored, expired or went missing is sent again in a later batch, up
 * to this many batches in all: the batch counterpart of the SDK's 3 attempts (spec §6.3).
 */
export const ITEM_ATTEMPTS = 3;

/** Item errors that sending the same request again cannot fix. */
const PERMANENT_ERRORS = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "billing_error",
]);

/** The API keeps a batch's results for 29 days; journal entries older than 28 are ignored. */
export const JOURNAL_RESULTS_TTL_MS = 28 * 24 * 60 * 60 * 1000;

/** JSON with object keys sorted, so equal values serialize equal whatever their key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** SHA-256 of a request's canonical JSON: the journal's key for it. */
export function requestKey(params: MessageCreateParamsNonStreaming): string {
  return createHash("sha256").update(canonicalJson(params)).digest("hex");
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs a caller's observer hook. A throwing hook must not stop a batch that is already created
 * (and billed), so its error is swallowed here, and so is the rejection of an async hook.
 */
function observe(hook: () => void): void {
  try {
    const returned: unknown = hook();
    if (returned instanceof Promise) returned.catch(() => {});
  } catch {
    // The batch carries on; a broken hook is the caller's bug, not the batch's failure.
  }
}

/**
 * Requests made in the same tick of the event loop go out together as one Message Batch (half
 * price). Each request settles on its own: an item that errored, expired or went missing is sent
 * again in a later batch (see `ITEM_ATTEMPTS`) and rejects only its own promise once it runs out
 * of attempts; a failure of the batch itself rejects them all and is not retried.
 */
export function createBatcher(client: Anthropic, options: BatcherOptions): Batcher {
  let queue: Queued[] = [];
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const maxPollIntervalMs = options.maxPollIntervalMs ?? 60000;

  /** Polls until the batch ends; past the deadline, cancels it and throws. */
  const awaitEnd = async (created: MessageBatch): Promise<void> => {
    let batch = created;
    const started = now();
    let interval = Math.min(pollIntervalMs, maxPollIntervalMs);
    let consecutiveFailures = 0;
    while (batch.processing_status !== "ended") {
      const progress = {
        id: batch.id,
        status: batch.processing_status,
        processing: batch.request_counts.processing,
        succeeded: batch.request_counts.succeeded,
        errored: batch.request_counts.errored,
      };
      observe(() => options.onProgress?.(progress));
      const left =
        options.deadlineMs === undefined ? Infinity : options.deadlineMs - (now() - started);
      if (left <= 0) throw await cancelAfterDeadline(batch.id);
      await sleep(Math.min(interval, left));
      interval = Math.min(interval * 1.5, maxPollIntervalMs);
      try {
        batch = await client.messages.batches.retrieve(batch.id);
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 4) {
          throw new LlmError(
            `batch ${batch.id} failed after 4 consecutive poll failures: ${messageOf(error)}; it may still be running; cancel it by hand`,
            { cause: error },
          );
        }
      }
    }
  };

  const cancelAfterDeadline = async (id: string): Promise<LlmError> => {
    const seconds = Math.round((options.deadlineMs ?? 0) / 1000);
    try {
      await client.messages.batches.cancel(id);
      return new LlmError(`batch ${id} passed its ${seconds} s deadline and was canceled`);
    } catch (error) {
      return new LlmError(
        `batch ${id} passed its ${seconds} s deadline and could not be canceled (${messageOf(error)}); cancel it by hand`,
        { cause: error },
      );
    }
  };

  /**
   * Every result line of an ended batch, keyed by custom id; the download is retried. It is not
   * bound by the deadline on purpose: the batch has ended and its results are already paid for.
   * Each attempt starts from an empty map, so a stream that breaks mid-way leaves nothing behind.
   */
  const download = async (id: string): Promise<Map<string, MessageBatchResult>> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const results = new Map<string, MessageBatchResult>();
        for await (const line of await client.messages.batches.results(id)) {
          results.set(line.custom_id, line.result);
        }
        return results;
      } catch (error) {
        if (attempt >= RESULTS_ATTEMPTS) {
          throw new LlmError(
            `batch ${id} failed to retrieve results after ${RESULTS_ATTEMPTS} attempts: ${messageOf(error)}; the results stay downloadable for 29 days`,
            { cause: error },
          );
        }
        await sleep(pollIntervalMs * attempt);
      }
    }
  };

  /** An error from a created batch's polling or download, as the LlmError its requests get. */
  const batchFailure = (id: string, error: unknown): LlmError =>
    error instanceof LlmError
      ? error
      : new LlmError(`batch ${id} failed unexpectedly: ${messageOf(error)}`, { cause: error });

  /**
   * Drops requests settled from their result lines from the journal, so a rerun sends them again
   * instead of replaying an answer it already has. A failed delete only costs that replay.
   */
  const forget = (batchId: string, items: readonly Queued[]): void => {
    if (options.journal === undefined || items.length === 0) return;
    observe(() =>
      options.journal?.forget(
        batchId,
        items.map((item) => requestKey(item.params)),
      ),
    );
  };

  /** Resolves, re-queues or rejects each request from its line in an ended batch's results. */
  const settle = (
    batchId: string,
    sent: readonly { item: Queued; customId: string }[],
    results: Map<string, MessageBatchResult>,
  ): void => {
    for (const { item, customId } of sent) {
      const result = results.get(customId);
      if (result?.type === "succeeded") {
        item.resolve(result.message);
        continue;
      }
      const why =
        result?.type === "errored"
          ? `${result.error.error.type}: ${result.error.error.message}`
          : (result?.type ?? "missing");
      const permanent =
        result?.type === "canceled" ||
        (result?.type === "errored" && PERMANENT_ERRORS.has(result.error.error.type));
      if (!permanent && item.attempts < ITEM_ATTEMPTS) {
        enqueue(item);
        continue;
      }
      const tries = item.attempts === 1 ? "" : ` (attempt ${item.attempts} of ${ITEM_ATTEMPTS})`;
      item.reject(
        new LlmError(`batch ${batchId} request ${customId} did not succeed${tries}: ${why}`),
      );
    }
    // A request queued again stays journaled: its next batch's record replaces the row.
    forget(
      batchId,
      sent.flatMap(({ item }) => (item.settled ? [item] : [])),
    );
  };

  /** Creates one batch for `items`, records it, then polls, downloads and settles it. */
  const submit = async (items: Queued[]): Promise<void> => {
    const sent = items.map((item, i) => ({ item, customId: `req-${i}` }));
    let batch: MessageBatch;
    try {
      // The client's retries also cover this create and the SDK sends no idempotency key, so a
      // timeout retry can create (and bill) a second batch; rare, since create returns fast.
      batch = await client.messages.batches.create({
        requests: sent.map(({ item, customId }) => ({ custom_id: customId, params: item.params })),
      });
    } catch (error) {
      const llmError = new LlmError(`batch could not be created: ${messageOf(error)}`, {
        cause: error,
      });
      for (const item of items) item.reject(llmError);
      return;
    }
    const { id, created_at: createdAt } = batch;

    let results: Map<string, MessageBatchResult>;
    try {
      observe(() => options.onBatchCreated?.({ id, requests: items.length }));
      // A journal that cannot write (e.g. a locked database) costs only the resume, not the batch.
      observe(() =>
        options.journal?.record(
          id,
          createdAt,
          sent.map(({ item, customId }) => ({ requestKey: requestKey(item.params), customId })),
        ),
      );
      await awaitEnd(batch);
      results = await download(id);
    } catch (error) {
      // Nothing may escape: `run` is started without an awaiter, and the batch is billed.
      const llmError = batchFailure(id, error);
      for (const item of items) item.reject(llmError);
      return;
    }
    settle(id, sent, results);
  };

  /**
   * Collects requests a journaled batch already holds, so a run that died while waiting pays
   * nothing twice. The batch is polled under the same deadline and downloaded under the same
   * RESULTS_ATTEMPTS as a new one. A request it did not answer, or every request when the batch
   * no longer exists (404), goes out again in a new batch. Any other failure to retrieve it
   * rejects them and sends nothing: the batch may still be running, and is already billed.
   */
  const resume = async (
    batchId: string,
    held: readonly { item: Queued; customId: string }[],
  ): Promise<void> => {
    let batch: MessageBatch;
    try {
      batch = await client.messages.batches.retrieve(batchId);
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status === 404) {
        for (const { item } of held) enqueue(item);
        return;
      }
      const llmError = new LlmError(
        `batch ${batchId} could not be retrieved: ${messageOf(error)}; it may still be running; rerun to collect it`,
        { cause: error },
      );
      for (const { item } of held) item.reject(llmError);
      return;
    }
    let results: Map<string, MessageBatchResult>;
    try {
      await awaitEnd(batch);
      results = await download(batchId);
    } catch (error) {
      const llmError = batchFailure(batchId, error);
      for (const { item } of held) item.reject(llmError);
      return;
    }
    const collected: Queued[] = [];
    for (const { item, customId } of held) {
      const result = results.get(customId);
      if (result?.type === "succeeded") {
        item.resolve(result.message);
        collected.push(item);
      } else enqueue(item);
    }
    forget(batchId, collected);
  };

  /**
   * The journal entry to collect a first-attempt request from, or null. A broken journal is a
   * miss: the request is sent again rather than failed.
   */
  const journaled = (item: Queued): JournalEntry | null => {
    if (options.journal === undefined || item.attempts !== 1) return null;
    try {
      const entry = options.journal.lookup(requestKey(item.params));
      if (entry == null) return null;
      return now() - Date.parse(entry.createdAt) < JOURNAL_RESULTS_TTL_MS ? entry : null;
    } catch {
      return null;
    }
  };

  const run = async (items: Queued[]): Promise<void> => {
    const fresh: Queued[] = [];
    const held = new Map<string, { item: Queued; customId: string }[]>();
    for (const item of items) {
      const entry = journaled(item);
      if (entry === null) {
        fresh.push(item);
        continue;
      }
      const group = held.get(entry.batchId) ?? [];
      group.push({ item, customId: entry.customId });
      held.set(entry.batchId, group);
    }
    await Promise.all([
      ...[...held].map(([batchId, group]) => resume(batchId, group)),
      ...(fresh.length > 0 ? [submit(fresh)] : []),
    ]);
  };

  /** Queues a request for the batch that goes out at the end of this tick. */
  const enqueue = (item: Queued): void => {
    if (queue.length === 0) {
      setImmediate(() => {
        // An item can be settled while queued: a failure of `run` rejects every item of its batch,
        // including those already queued again.
        const items = queue.filter((item) => !item.settled);
        queue = [];
        if (items.length === 0) return;
        // `run` settles every item itself; this catch only keeps a bug in it from leaking as an
        // unhandled rejection that would leave the callers pending forever.
        run(items).catch((error: unknown) => {
          const llmError = new LlmError(`batch run failed unexpectedly: ${messageOf(error)}`, {
            cause: error,
          });
          for (const item of items) item.reject(llmError);
        });
      });
    }
    item.attempts += 1;
    queue.push(item);
  };

  return (params) =>
    new Promise((resolve, reject) => {
      const item: Queued = {
        params,
        attempts: 0,
        settled: false,
        resolve: (message) => {
          item.settled = true;
          resolve(message);
        },
        reject: (error) => {
          item.settled = true;
          reject(error);
        },
      };
      enqueue(item);
    });
}
