import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it } from "vitest";
import { type BatchProgress, createBatcher } from "./batcher.ts";
import { cannedBatchApi, succeededLine } from "./canned.ts";

const params = (content: string): MessageCreateParamsNonStreaming => ({
  model: "claude-haiku-4-5",
  max_tokens: 50,
  messages: [{ role: "user", content }],
});

function setup(results: unknown[]) {
  const api = cannedBatchApi(results);
  const progress: BatchProgress[] = [];
  const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
  const batcher = createBatcher(client, { pollIntervalMs: 0, onProgress: (p) => progress.push(p) });
  return { batcher, posts: api.posts, progress };
}

describe("createBatcher", () => {
  it("sends requests made in the same tick as one batch, with stable custom ids", async () => {
    const { batcher, posts, progress } = setup([
      succeededLine("req-1", "b"),
      succeededLine("req-0", "a"),
    ]);
    const [a, b] = await Promise.all([batcher(params("first")), batcher(params("second"))]);
    expect(posts).toEqual([
      {
        requests: [
          { custom_id: "req-0", params: params("first") },
          { custom_id: "req-1", params: params("second") },
        ],
      },
    ]);
    expect([a.content, b.content]).toEqual([
      [{ type: "text", text: "a" }],
      [{ type: "text", text: "b" }],
    ]);
    expect(progress).toEqual([
      { id: "msgbatch_canned", status: "in_progress", processing: 2, succeeded: 0, errored: 0 },
    ]);
  });

  it("starts a new batch for a request made in a later tick", async () => {
    const { batcher, posts } = setup([succeededLine("req-0", "a")]);
    await batcher(params("first"));
    await batcher(params("second"));
    expect(posts).toHaveLength(2);
  });

  it("rejects only the items that errored, expired, or have no result", async () => {
    const { batcher } = setup([
      succeededLine("req-0", "a"),
      {
        custom_id: "req-1",
        result: {
          type: "errored",
          error: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        },
      },
      { custom_id: "req-2", result: { type: "expired" } },
    ]);
    const settled = await Promise.allSettled(["a", "b", "c", "d"].map((q) => batcher(params(q))));
    expect(settled.map((s) => (s.status === "fulfilled" ? "ok" : String(s.reason)))).toEqual([
      "ok",
      "LlmError: batch msgbatch_canned request req-1 did not succeed: overloaded_error",
      "LlmError: batch msgbatch_canned request req-2 did not succeed: expired",
      "LlmError: batch msgbatch_canned request req-3 did not succeed: missing",
    ]);
  });

  it("rejects every item when the batch itself cannot be created", async () => {
    const refusal = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "bad request" },
    });
    const client = new Anthropic({
      apiKey: "canned",
      maxRetries: 0,
      fetch: async () =>
        new Response(refusal, { status: 400, headers: { "content-type": "application/json" } }),
    });
    const batcher = createBatcher(client, { pollIntervalMs: 0 });
    const settled = await Promise.allSettled([batcher(params("a")), batcher(params("b"))]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
  });
});
