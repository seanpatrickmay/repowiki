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

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs a caller's observer hook. A throwing hook must not stop a batch that is already created
 * (and billed), so its error is swallowed here.
 */
function observe(hook: () => void): void {
  try {
    hook();
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

  const run = async (items: Queued[]): Promise<void> => {
    let batch: MessageBatch;
    try {
      // The client's retries also cover this create and the SDK sends no idempotency key, so a
      // timeout retry can create (and bill) a second batch; rare, since create returns fast.
      batch = await client.messages.batches.create({
        requests: items.map((item, i) => ({ custom_id: `req-${i}`, params: item.params })),
      });
    } catch (error) {
      const llmError = new LlmError(`batch could not be created: ${messageOf(error)}`, {
        cause: error,
      });
      for (const item of items) item.reject(llmError);
      return;
    }
    const id = batch.id;

    let results: Map<string, MessageBatchResult>;
    try {
      observe(() => options.onBatchCreated?.({ id, requests: items.length }));
      await awaitEnd(batch);
      results = await download(id);
    } catch (error) {
      // Nothing may escape: `run` is started without an awaiter, and the batch is billed.
      const llmError =
        error instanceof LlmError
          ? error
          : new LlmError(`batch ${id} failed unexpectedly: ${messageOf(error)}`, { cause: error });
      for (const item of items) item.reject(llmError);
      return;
    }

    items.forEach((item, i) => {
      const result = results.get(`req-${i}`);
      if (result?.type === "succeeded") {
        item.resolve(result.message);
        return;
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
        return;
      }
      const tries = item.attempts === 1 ? "" : ` (attempt ${item.attempts} of ${ITEM_ATTEMPTS})`;
      item.reject(
        new LlmError(`batch ${batch.id} request req-${i} did not succeed${tries}: ${why}`),
      );
    });
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
