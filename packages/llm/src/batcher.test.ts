import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it } from "vitest";
import {
  type BatcherOptions,
  type BatchProgress,
  createBatcher,
  ITEM_ATTEMPTS,
  RESULTS_ATTEMPTS,
} from "./batcher.ts";
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

/** A Batches API whose status polls answer `statuses` in turn (then "ended"); paths are logged. */
function scriptedApi(options: {
  statuses?: ("in_progress" | "ended")[];
  results?: unknown[];
  failResults?: number;
  failCancel?: boolean;
  /** Every status poll answers 500. */
  failPolls?: boolean;
  /** The first N results downloads send a stale line, then break mid-stream. */
  breakResults?: number;
}) {
  const calls: string[] = [];
  const statuses = [...(options.statuses ?? [])];
  let resultFailures = options.failResults ?? 0;
  let resultBreaks = options.breakResults ?? 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (path.endsWith("/cancel")) {
      if (options.failCancel) return json({ type: "error", error: { type: "api_error" } }, 500);
      return json(batchResponse("in_progress"));
    }
    if (method === "POST") return json(batchResponse("in_progress"));
    if (path.endsWith("/results")) {
      if (resultFailures > 0) {
        resultFailures -= 1;
        return new Response("unavailable", { status: 503 });
      }
      if (resultBreaks > 0) {
        resultBreaks -= 1;
        const stale = `${JSON.stringify(succeededLine("req-0", "stale"))}\n`;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(stale));
            controller.error(new Error("connection reset"));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-jsonl" },
        });
      }
      const lines = (options.results ?? [succeededLine("req-0", "a")]).map((l) =>
        JSON.stringify(l),
      );
      return new Response(lines.join("\n"), {
        status: 200,
        headers: { "content-type": "application/x-jsonl" },
      });
    }
    if (options.failPolls) return json({ type: "error", error: { type: "api_error" } }, 500);
    return json(batchResponse(statuses.shift() ?? "ended"));
  };
  return { calls, fetch };
}

describe("createBatcher deadline, cancel and downloads (issue #113)", () => {
  it("cancels a batch that passes its deadline and rejects every request with its id", async () => {
    const api = scriptedApi({ statuses: ["in_progress", "in_progress", "in_progress"] });
    let clock = 0;
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      pollIntervalMs: 1000,
      deadlineMs: 2500,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const settled = await Promise.allSettled([batcher(params("a")), batcher(params("b"))]);
    expect(settled.map((s) => (s.status === "rejected" ? String(s.reason) : "ok"))).toEqual([
      "LlmError: batch msgbatch_canned passed its 3 s deadline and was canceled",
      "LlmError: batch msgbatch_canned passed its 3 s deadline and was canceled",
    ]);
    expect(api.calls.at(-1)).toBe("POST /v1/messages/batches/msgbatch_canned/cancel");
    expect(api.calls.filter((c) => c.endsWith("/results"))).toEqual([]);
  });

  it("never sleeps past the deadline", async () => {
    const api = scriptedApi({ statuses: ["in_progress", "in_progress"] });
    let clock = 0;
    const sleeps: number[] = [];
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      pollIntervalMs: 1000,
      deadlineMs: 1600,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await expect(batcher(params("a"))).rejects.toThrow("deadline");
    expect(sleeps).toEqual([1000, 600]);
  });

  it("says so when a batch past its deadline cannot be canceled", async () => {
    const api = scriptedApi({ statuses: ["in_progress"], failCancel: true });
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, { deadlineMs: 0, sleep: async () => {} });
    await expect(batcher(params("a"))).rejects.toThrow(
      /msgbatch_canned passed its 0 s deadline and could not be canceled .*; cancel it by hand/,
    );
  });

  it("harvests a batch that ends before its deadline", async () => {
    const api = scriptedApi({ statuses: ["in_progress"] });
    let clock = 0;
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      pollIntervalMs: 1000,
      deadlineMs: 10_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect((await batcher(params("a"))).content).toEqual([{ type: "text", text: "a" }]);
    expect(api.calls.some((c) => c.endsWith("/cancel"))).toBe(false);
  });

  it("retries a failed results download, then succeeds", async () => {
    const api = scriptedApi({ failResults: 2 });
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, { sleep: async () => {} });
    expect((await batcher(params("a"))).content).toEqual([{ type: "text", text: "a" }]);
    expect(api.calls.filter((c) => c.endsWith("/results"))).toHaveLength(RESULTS_ATTEMPTS);
  });

  it("gives up on the download after RESULTS_ATTEMPTS and names the batch", async () => {
    const api = scriptedApi({ failResults: RESULTS_ATTEMPTS });
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, { sleep: async () => {} });
    await expect(batcher(params("a"))).rejects.toThrow(
      `batch msgbatch_canned failed to retrieve results after ${RESULTS_ATTEMPTS} attempts`,
    );
  });

  it("reports each created batch's id before polling it", async () => {
    const api = scriptedApi({
      statuses: ["in_progress"],
      results: [succeededLine("req-0", "a"), succeededLine("req-1", "b")],
    });
    const seen: string[] = [];
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      sleep: async () => {},
      onBatchCreated: (batch) => seen.push(`${batch.id} ${batch.requests} ${api.calls.length}`),
    });
    await Promise.all([batcher(params("a")), batcher(params("b"))]);
    expect(seen).toEqual(["msgbatch_canned 2 1"]);
  });

  it("keeps polling and harvesting when onBatchCreated throws", async () => {
    const api = scriptedApi({ statuses: ["in_progress"] });
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      sleep: async () => {},
      onBatchCreated: () => {
        throw new Error("hook broke");
      },
    });
    expect((await batcher(params("a"))).content).toEqual([{ type: "text", text: "a" }]);
    expect(api.calls.filter((c) => c.endsWith("/results"))).toHaveLength(1);
    // Two status polls, plus the retrieve the SDK makes to find the results URL.
    expect(api.calls.filter((c) => c.startsWith("GET") && !c.endsWith("/results"))).toHaveLength(3);
  });

  it("keeps polling and harvesting when onProgress throws", async () => {
    const api = scriptedApi({ statuses: ["in_progress"] });
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      sleep: async () => {},
      onProgress: () => {
        throw new Error("hook broke");
      },
    });
    expect((await batcher(params("a"))).content).toEqual([{ type: "text", text: "a" }]);
    expect(api.calls.filter((c) => c.endsWith("/results"))).toHaveLength(1);
  });

  it("rejects every request, naming the batch, when polling itself breaks unexpectedly", async () => {
    const api = scriptedApi({ statuses: ["in_progress"] });
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      deadlineMs: 1000,
      now: () => {
        throw new Error("clock broke");
      },
      sleep: async () => {},
    });
    const settled = await Promise.allSettled([batcher(params("a")), batcher(params("b"))]);
    expect(settled.map((s) => (s.status === "rejected" ? String(s.reason) : "ok"))).toEqual([
      "LlmError: batch msgbatch_canned failed unexpectedly: clock broke",
      "LlmError: batch msgbatch_canned failed unexpectedly: clock broke",
    ]);
  });

  it("names the batch and says to cancel it by hand after four failed polls", async () => {
    const api = scriptedApi({ failPolls: true });
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, { sleep: async () => {} });
    await expect(batcher(params("a"))).rejects.toThrow(
      /batch msgbatch_canned failed after 4 consecutive poll failures: .*; it may still be running; cancel it by hand/,
    );
  });

  it("tries the download exactly 3 times, spaced pollIntervalMs x attempt apart", async () => {
    expect(RESULTS_ATTEMPTS).toBe(3);
    const api = scriptedApi({ failResults: 3 });
    const sleeps: number[] = [];
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      pollIntervalMs: 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(batcher(params("a"))).rejects.toThrow(
      /after 3 attempts: .*; the results stay downloadable for 29 days/,
    );
    expect(api.calls.filter((c) => c.endsWith("/results"))).toHaveLength(3);
    // One poll wait for the in-progress batch, then 1 x 1000 and 2 x 1000 between downloads.
    expect(sleeps).toEqual([1000, 1000, 2000]);
  });

  it("discards a download that fails mid-stream and resolves each item once from the retry", async () => {
    const api = scriptedApi({
      breakResults: 1,
      results: [succeededLine("req-0", "a"), succeededLine("req-1", "b")],
    });
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, { sleep: async () => {} });
    const settled = await Promise.all([batcher(params("a")), batcher(params("b"))]);
    expect(settled.map((m) => m.content)).toEqual([
      [{ type: "text", text: "a" }],
      [{ type: "text", text: "b" }],
    ]);
    expect(api.calls.filter((c) => c.endsWith("/results"))).toHaveLength(2);
  });

  it("harvests, rather than cancels, a batch that ends on the poll landing at the deadline", async () => {
    const api = scriptedApi({ statuses: ["ended"] });
    let clock = 0;
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      pollIntervalMs: 1000,
      deadlineMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect((await batcher(params("a"))).content).toEqual([{ type: "text", text: "a" }]);
    expect(api.calls.some((c) => c.endsWith("/cancel"))).toBe(false);
  });
});

const errored = (customId: string, type: string) => ({
  custom_id: customId,
  result: { type: "errored", error: { type: "error", error: { type, message: type } } },
});

/** Each created batch answers with the next entry of `rounds`; the bodies are kept. */
function roundsApi(rounds: unknown[][], options: BatcherOptions = {}) {
  const posts: { requests: { custom_id: string; params: { messages: unknown[] } }[] }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path.endsWith("/results")) {
      const lines = rounds[posts.length - 1] ?? [];
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n"), {
        status: 200,
        headers: { "content-type": "application/x-jsonl" },
      });
    }
    if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(batchResponse("ended")), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new Anthropic({ apiKey: "canned", fetch, maxRetries: 0 });
  return { batcher: createBatcher(client, { sleep: async () => {}, ...options }), posts };
}

describe("createBatcher per-item retries", () => {
  it("rejects only the items that still errored, expired, or had no result on the last attempt", async () => {
    const stillFailing = [
      errored("req-0", "overloaded_error"),
      { custom_id: "req-1", result: { type: "expired" } },
    ];
    const { batcher, posts } = roundsApi([
      [
        succeededLine("req-0", "a"),
        errored("req-1", "overloaded_error"),
        { custom_id: "req-2", result: { type: "expired" } },
      ],
      stillFailing,
      stillFailing,
    ]);
    const settled = await Promise.allSettled(["a", "b", "c", "d"].map((q) => batcher(params(q))));
    expect(settled.map((s) => (s.status === "fulfilled" ? "ok" : String(s.reason)))).toEqual([
      "ok",
      "LlmError: batch msgbatch_canned request req-0 did not succeed (attempt 3 of 3): overloaded_error: overloaded_error",
      "LlmError: batch msgbatch_canned request req-1 did not succeed (attempt 3 of 3): expired",
      "LlmError: batch msgbatch_canned request req-2 did not succeed (attempt 3 of 3): missing",
    ]);
    expect(posts.map((p) => p.requests.length)).toEqual([4, 3, 3]);
  });

  it("sends an overloaded or expired item again in the next batch and resolves it", async () => {
    const { batcher, posts } = roundsApi([
      [
        succeededLine("req-0", "a"),
        errored("req-1", "overloaded_error"),
        { custom_id: "req-2", result: { type: "expired" } },
      ],
      [succeededLine("req-0", "b"), succeededLine("req-1", "c")],
    ]);
    const answers = await Promise.all(["a", "b", "c"].map((q) => batcher(params(q))));
    expect(answers.map((m) => m.content)).toEqual([
      [{ type: "text", text: "a" }],
      [{ type: "text", text: "b" }],
      [{ type: "text", text: "c" }],
    ]);
    expect(posts.map((p) => p.requests.map((r) => r.params.messages))).toEqual([
      [params("a").messages, params("b").messages, params("c").messages],
      [params("b").messages, params("c").messages],
    ]);
  });

  it.each([
    ["an invalid request", errored("req-0", "invalid_request_error"), /invalid_request_error/],
    ["a canceled item", { custom_id: "req-0", result: { type: "canceled" } }, /canceled/],
  ])("never sends %s again", async (_name, line, why) => {
    const { batcher, posts } = roundsApi([[line]]);
    await expect(batcher(params("a"))).rejects.toThrow(why);
    expect(posts).toHaveLength(1);
  });

  it(`gives up after ${ITEM_ATTEMPTS} batches`, async () => {
    const failing = [errored("req-0", "api_error")];
    const { batcher, posts } = roundsApi([
      failing,
      failing,
      failing,
      [succeededLine("req-0", "x")],
    ]);
    await expect(batcher(params("a"))).rejects.toThrow(
      `did not succeed (attempt ${ITEM_ATTEMPTS} of ${ITEM_ATTEMPTS}): api_error`,
    );
    expect(posts).toHaveLength(ITEM_ATTEMPTS);
  });

  it("reports each retry batch to onBatchCreated", async () => {
    const seen: string[] = [];
    const { batcher } = roundsApi(
      [[succeededLine("req-0", "a"), errored("req-1", "api_error")], [succeededLine("req-0", "b")]],
      { onBatchCreated: (batch) => seen.push(`${batch.id} ${batch.requests}`) },
    );
    await Promise.all([batcher(params("a")), batcher(params("b"))]);
    expect(seen).toEqual(["msgbatch_canned 2", "msgbatch_canned 1"]);
  });

  it("does not send a request again when its batch is canceled at the deadline", async () => {
    const api = scriptedApi({ statuses: ["in_progress", "in_progress"] });
    let clock = 0;
    const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
    const batcher = createBatcher(client, {
      pollIntervalMs: 1000,
      deadlineMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await expect(batcher(params("a"))).rejects.toThrow("passed its 1 s deadline and was canceled");
    expect(api.calls.filter((c) => c === "POST /v1/messages/batches")).toHaveLength(1);
  });
});
