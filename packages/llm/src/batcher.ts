import type Anthropic from "@anthropic-ai/sdk";
import type { MessageBatchResult } from "@anthropic-ai/sdk/resources/messages/batches";
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
  /** Custom sleep function for testing. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (progress: BatchProgress) => void;
}

/** Sends one request through the Message Batches API and resolves with its message. */
export type Batcher = (params: MessageCreateParamsNonStreaming) => Promise<Message>;

interface Queued {
  params: MessageCreateParamsNonStreaming;
  resolve: (message: Message) => void;
  reject: (error: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Requests made in the same tick of the event loop go out together as one Message Batch (half
 * price). Each request settles on its own: an errored, expired, or missing item rejects only its
 * own promise; a failure of the batch itself rejects them all.
 */
export function createBatcher(client: Anthropic, options: BatcherOptions): Batcher {
  let queue: Queued[] = [];
  const sleepFn = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const maxPollIntervalMs = options.maxPollIntervalMs ?? 60000;

  const run = async (items: Queued[]): Promise<void> => {
    let batch: Awaited<ReturnType<typeof client.messages.batches.create>>;
    try {
      batch = await client.messages.batches.create({
        requests: items.map((item, i) => ({ custom_id: `req-${i}`, params: item.params })),
      });
    } catch (error) {
      for (const item of items) item.reject(error);
      return;
    }

    let currentPollIntervalMs = Math.min(pollIntervalMs, maxPollIntervalMs);
    let consecutiveRetrieveFailures = 0;

    while (batch.processing_status !== "ended") {
      options.onProgress?.({
        id: batch.id,
        status: batch.processing_status,
        processing: batch.request_counts.processing,
        succeeded: batch.request_counts.succeeded,
        errored: batch.request_counts.errored,
      });
      await sleepFn(currentPollIntervalMs);
      currentPollIntervalMs = Math.min(currentPollIntervalMs * 1.5, maxPollIntervalMs);

      try {
        batch = await client.messages.batches.retrieve(batch.id);
        consecutiveRetrieveFailures = 0;
      } catch (error) {
        consecutiveRetrieveFailures += 1;
        if (consecutiveRetrieveFailures >= 4) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          const llmError = new LlmError(
            `batch ${batch.id} failed after 4 consecutive poll failures: ${errorMsg}`,
          );
          for (const item of items) item.reject(llmError);
          return;
        }
      }
    }

    const results = new Map<string, MessageBatchResult>();
    try {
      for await (const line of await client.messages.batches.results(batch.id)) {
        results.set(line.custom_id, line.result);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const llmError = new LlmError(`batch ${batch.id} failed to retrieve results: ${errorMsg}`);
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
      item.reject(new LlmError(`batch ${batch.id} request req-${i} did not succeed: ${why}`));
    });
  };

  return (params) =>
    new Promise((resolve, reject) => {
      if (queue.length === 0) {
        setImmediate(() => {
          const items = queue;
          queue = [];
          void run(items);
        });
      }
      queue.push({ params, resolve, reject });
    });
}
