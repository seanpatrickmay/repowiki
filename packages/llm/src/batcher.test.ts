import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it } from "vitest";
import { type BatchProgress, createBatcher } from "./batcher.ts";
import { cannedBatchApi, succeededLine } from "./canned.ts";
import type { FetchLike } from "./cassette.ts";
import { LlmError } from "./provider.ts";

const params = (content: string): MessageCreateParamsNonStreaming => ({
  model: "claude-haiku-4-5",
  max_tokens: 50,
  messages: [{ role: "user", content }],
});

const batchResponse = (status: "in_progress" | "ended") => ({
  id: "msgbatch_canned",
  type: "message_batch" as const,
  processing_status: status,
  request_counts: {
    processing: status === "ended" ? 0 : 1,
    succeeded: 0,
    errored: 0,
    canceled: 0,
    expired: 0,
  },
  results_url:
    status === "ended"
      ? "https://api.anthropic.com/v1/messages/batches/msgbatch_canned/results"
      : null,
  created_at: "2026-10-01T12:00:00Z",
  ended_at: null,
  expires_at: "2026-10-02T12:00:00Z",
  archived_at: null,
  cancel_initiated_at: null,
});

function setup(results: unknown[], pollIntervalMs = 0) {
  const api = cannedBatchApi(results);
  const progress: BatchProgress[] = [];
  const recordedSleeps: number[] = [];
  const sleep = (ms: number) => {
    recordedSleeps.push(ms);
    return Promise.resolve();
  };
  const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
  const batcher = createBatcher(client, {
    pollIntervalMs,
    sleep,
    onProgress: (p) => progress.push(p),
  });
  return { batcher, posts: api.posts, progress, recordedSleeps };
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
      "LlmError: batch msgbatch_canned request req-1 did not succeed: overloaded_error: Overloaded",
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
    const batcher = createBatcher(client, { sleep: async () => {} });
    const settled = await Promise.allSettled([batcher(params("a")), batcher(params("b"))]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    for (const s of settled) {
      const reason = s.status === "rejected" ? s.reason : null;
      expect(reason).toBeInstanceOf(LlmError);
      expect(String(reason)).toMatch(/batch could not be created: .*bad request/);
      expect((reason as Error).cause).toBeInstanceOf(Anthropic.APIError);
    }
  });

  it("backs off exponentially during polling with configurable max", async () => {
    let retrieveCount = 0;
    const fetch: FetchLike = async (input, init) => {
      const urlStr = input instanceof Request ? input.url : (input as string);
      const path = new URL(urlStr).pathname;

      if ((init as Record<string, unknown>)?.method === "POST") {
        return new Response(JSON.stringify(batchResponse("in_progress")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (!path.endsWith("/results")) {
        retrieveCount += 1;
        const status = retrieveCount < 3 ? "in_progress" : "ended";
        return new Response(JSON.stringify(batchResponse(status)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(`${JSON.stringify(succeededLine("req-0", "a"))}\n`, {
        status: 200,
        headers: { "content-type": "application/x-jsonl" },
      });
    };

    const client = new Anthropic({ apiKey: "canned", fetch, maxRetries: 0 });
    const recordedSleeps: number[] = [];
    const batcher = createBatcher(client, {
      pollIntervalMs: 100,
      maxPollIntervalMs: 1000,
      sleep: (ms) => {
        recordedSleeps.push(ms);
        return Promise.resolve();
      },
    });
    await batcher(params("test"));
    expect(recordedSleeps).toEqual([100, 150, 225]);
  });

  it("clamps backoff to max poll interval", async () => {
    let retrieveCount = 0;
    const fetch: FetchLike = async (input, init) => {
      const urlStr = input instanceof Request ? input.url : (input as string);
      const path = new URL(urlStr).pathname;

      if ((init as Record<string, unknown>)?.method === "POST") {
        return new Response(JSON.stringify(batchResponse("in_progress")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (!path.endsWith("/results")) {
        retrieveCount += 1;
        const status = retrieveCount < 4 ? "in_progress" : "ended";
        return new Response(JSON.stringify(batchResponse(status)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(`${JSON.stringify(succeededLine("req-0", "a"))}\n`, {
        status: 200,
        headers: { "content-type": "application/x-jsonl" },
      });
    };

    const client = new Anthropic({ apiKey: "canned", fetch, maxRetries: 0 });
    const recordedSleeps: number[] = [];
    const batcher = createBatcher(client, {
      pollIntervalMs: 100,
      maxPollIntervalMs: 200,
      sleep: (ms) => {
        recordedSleeps.push(ms);
        return Promise.resolve();
      },
    });
    await batcher(params("test"));
    expect(recordedSleeps).toEqual([100, 150, 200, 200]);
  });

  it("survives transient retrieve failures and resolves normally", async () => {
    let getCount = 0;
    const fetch: FetchLike = async (input, init) => {
      const urlStr = input instanceof Request ? input.url : (input as string);
      const path = new URL(urlStr).pathname;
      const method = (init as Record<string, unknown>)?.method ?? "GET";

      if (method === "POST") {
        return new Response(JSON.stringify(batchResponse("in_progress")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "GET" && path.endsWith("msgbatch_canned")) {
        getCount += 1;
        if (getCount <= 2) {
          return new Response("error", { status: 500 });
        }
        return new Response(JSON.stringify(batchResponse("ended")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (path.endsWith("/results")) {
        return new Response(`${JSON.stringify(succeededLine("req-0", "a"))}\n`, {
          status: 200,
          headers: { "content-type": "application/x-jsonl" },
        });
      }

      return new Response("error", { status: 500 });
    };

    const client = new Anthropic({ apiKey: "canned", fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      sleep: async () => {},
    });
    const result = await batcher(params("test"));
    expect(result.content).toEqual([{ type: "text", text: "a" }]);
    expect(getCount).toBeGreaterThanOrEqual(3);
  });

  it("resets failure counter on successful retrieve", async () => {
    let getCount = 0;
    const api = cannedBatchApi([succeededLine("req-0", "a")]);
    const fetch: FetchLike = async (input, init) => {
      const urlStr = input instanceof Request ? input.url : (input as string);
      const path = new URL(urlStr).pathname;
      const method = (init as Record<string, unknown>)?.method ?? "GET";

      // Pattern: fail, fail, success(in_progress), fail, fail, fail, success(ended), then results GET
      if (method === "GET" && path.endsWith("msgbatch_canned")) {
        getCount += 1;
        // Sequence: [F, F, S, F, F, F, S, S]
        // (7th is success with ended, 8th is the SDK's extra GET before results)
        const shouldFail = [true, true, false, true, true, true, false, false][getCount - 1];

        if (shouldFail) {
          return new Response("error", { status: 500 });
        }
        const status = getCount >= 7 ? "ended" : "in_progress";
        return new Response(JSON.stringify(batchResponse(status)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return api.fetch(input, init);
    };

    const client = new Anthropic({ apiKey: "canned", fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      sleep: async () => {},
    });
    const result = await batcher(params("test"));
    expect(result.content).toEqual([{ type: "text", text: "a" }]);
    expect(getCount).toBeGreaterThanOrEqual(7);
  });

  it("rejects all items after 4 consecutive retrieve failures with batch id in error", async () => {
    const fetch: FetchLike = async (input, init) => {
      const urlStr = input instanceof Request ? input.url : (input as string);
      const path = new URL(urlStr).pathname;
      const method = (init as Record<string, unknown>)?.method ?? "GET";

      if (method === "POST") {
        return new Response(JSON.stringify(batchResponse("in_progress")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "GET" && path.endsWith("msgbatch_canned")) {
        return new Response("server error", { status: 500 });
      }

      return new Response("error", { status: 500 });
    };

    const client = new Anthropic({ apiKey: "canned", fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      sleep: async () => {},
    });
    const settled = await Promise.allSettled([batcher(params("a")), batcher(params("b"))]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(settled[0].status === "rejected" && settled[0].reason.toString()).toContain(
      "msgbatch_canned",
    );
    expect(settled[0].status === "rejected" && settled[0].reason.toString()).toContain(
      "4 consecutive poll failures",
    );
  });

  it("rejects all items when results request fails", async () => {
    const fetch: FetchLike = async (input, init) => {
      const urlStr = input instanceof Request ? input.url : (input as string);
      const path = new URL(urlStr).pathname;
      const method = (init as Record<string, unknown>)?.method ?? "GET";

      if (method === "POST") {
        return new Response(JSON.stringify(batchResponse("in_progress")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "GET" && path.endsWith("msgbatch_canned")) {
        return new Response(JSON.stringify(batchResponse("ended")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (path.endsWith("/results")) {
        return new Response("server error", { status: 500 });
      }

      throw new Error(`Unexpected fetch: ${path}`);
    };

    const client = new Anthropic({ apiKey: "canned", fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      sleep: async () => {},
    });
    const settled = await Promise.allSettled([batcher(params("a")), batcher(params("b"))]);
    expect(settled).toHaveLength(2);
    expect(settled[0].status).toEqual("rejected");
    expect(settled[1].status).toEqual("rejected");
    const reason0 = settled[0].status === "rejected" ? settled[0].reason : null;
    const reason1 = settled[1].status === "rejected" ? settled[1].reason : null;
    expect(reason0).toBeInstanceOf(Error);
    expect(reason1).toBeInstanceOf(Error);
    expect(reason0?.toString()).toContain("msgbatch_canned");
    expect(reason0?.toString()).toContain("failed to retrieve results");
    expect(reason1?.toString()).toContain("msgbatch_canned");
    expect(reason1?.toString()).toContain("failed to retrieve results");
  });
});
