import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BatchJournal, JournalEntry } from "./batcher.ts";
import { cannedBatchApi, cannedMessagesApi, succeededLine } from "./canned.ts";
import type { FetchLike } from "./cassette.ts";
import { createClaudeProvider, MAX_REPORTED_ISSUES } from "./claude.ts";
import { createLedger, type TokenLedger } from "./ledger.ts";
import { DEFAULT_MODELS, LlmError, LlmOutputError } from "./provider.ts";

const Capital = z.object({ city: z.string(), country: z.string() });
const PARIS = '{"city":"Paris","country":"France"}';

function setup(fetch: FetchLike, models = DEFAULT_MODELS) {
  const ledger = createLedger();
  const provider = createClaudeProvider({
    models,
    ledger,
    runId: "test-run",
    apiKey: "canned",
    fetch,
    pollIntervalMs: 0,
    now: () => new Date("2026-10-01T12:00:00Z"),
  });
  return { ledger, provider };
}

const request = {
  purpose: "manifest" as const,
  system: "Answer with JSON only.",
  messages: [{ role: "user" as const, content: "What is the capital of France?" }],
  schema: Capital,
  maxTokens: 50,
};

describe("createClaudeProvider", () => {
  it("asks for JSON matching the schema with the role's model, and ledgers the call", async () => {
    const { bodies, fetch } = cannedMessagesApi(PARIS);
    const { ledger, provider } = setup(fetch, { ...DEFAULT_MODELS, write: "claude-sonnet-5-5" });
    const result = await provider.generate({ ...request, purpose: "write", featureId: "capitals" });
    expect(result).toEqual({
      output: { city: "Paris", country: "France" },
      usage: { in: 12, out: 5, cacheRead: 0, cacheWrite: 0 },
      model: "claude-haiku-4-5-20251001",
    });
    expect(bodies[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 50,
      system: [{ type: "text", text: "Answer with JSON only." }],
      messages: [{ role: "user", content: "What is the capital of France?" }],
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(ledger.entries()).toEqual([
      {
        runId: "test-run",
        at: "2026-10-01T12:00:00.000Z",
        purpose: "write",
        model: "claude-haiku-4-5-20251001",
        featureId: "capitals",
        batch: false,
        cacheKey: null,
        tokens: { in: 12, out: 5, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it("marks the system prompt for caching only when a cacheKey is given", async () => {
    const { bodies, fetch } = cannedMessagesApi(PARIS);
    const { ledger, provider } = setup(fetch);
    await provider.generate(request);
    await provider.generate({ ...request, cacheKey: "capitals" });
    const marks = bodies.map((b) => (b.system as { cache_control?: unknown }[])[0]?.cache_control);
    expect(marks).toEqual([undefined, { type: "ephemeral" }]);
    expect(ledger.entries().map((e) => e.cacheKey)).toEqual([null, "capitals"]);
  });

  it("refuses a cacheKey reused with a different prefix, before calling the API", async () => {
    const { bodies, fetch } = cannedMessagesApi(PARIS);
    const { provider } = setup(fetch);
    await provider.generate({ ...request, cacheKey: "k" });
    const changed = provider.generate({ ...request, system: "changed", cacheKey: "k" });
    await expect(changed).rejects.toThrow(LlmError);
    await expect(changed).rejects.toThrow("cacheKey k was reused with a different prefix");
    expect(bodies).toHaveLength(1);
  });

  it("refuses a cacheKey reused with the same system but a different model", async () => {
    const { bodies, fetch } = cannedMessagesApi(PARIS);
    const { provider } = setup(fetch, { ...DEFAULT_MODELS, write: "claude-sonnet-5-5" });
    await provider.generate({ ...request, cacheKey: "k" });
    const changed = provider.generate({ ...request, purpose: "write", cacheKey: "k" });
    await expect(changed).rejects.toThrow("cacheKey k was reused with a different prefix");
    expect(bodies).toHaveLength(1);
  });

  it("refuses a cacheKey reused with the same system but a different output schema", async () => {
    const { bodies, fetch } = cannedMessagesApi(PARIS);
    const { provider } = setup(fetch);
    await provider.generate({ ...request, cacheKey: "k" });
    const City = z.object({ city: z.string() });
    const changed = provider.generate({ ...request, schema: City, cacheKey: "k" });
    await expect(changed).rejects.toThrow("cacheKey k was reused with a different prefix");
    expect(bodies).toHaveLength(1);
  });

  it("accepts a cacheKey reused with an identical model, system and schema", async () => {
    const { bodies, fetch } = cannedMessagesApi(PARIS);
    const { provider } = setup(fetch);
    await provider.generate({ ...request, cacheKey: "k" });
    await provider.generate({
      ...request,
      schema: z.object({ city: z.string(), country: z.string() }),
      cacheKey: "k",
    });
    expect(bodies).toHaveLength(2);
  });

  it.each([
    ["text that is not JSON", "Paris", "end_turn", /not JSON/],
    ["JSON that misses the schema", '{"city":"Paris"}', "end_turn", /country/],
    ["a truncated answer", '{"city":', "max_tokens", /max_tokens/],
  ])("rejects %s with LlmOutputError and still ledgers the tokens", async (_n, text, stop, why) => {
    const { ledger, provider } = setup(cannedMessagesApi(text, stop).fetch);
    const failure = provider.generate(request);
    await expect(failure).rejects.toThrow(LlmOutputError);
    await expect(failure).rejects.toThrow(why);
    await expect(failure).rejects.toHaveProperty("text", text);
    expect(ledger.entries()).toHaveLength(1);
  });

  it.each([
    ["text that is not JSON", "Paris", "end_turn"],
    ["JSON that misses the schema", '{"city":"Paris"}', "end_turn"],
    ["a truncated answer", '{"city":', "max_tokens"],
  ])(
    "carries the ledgered usage and model on the LlmOutputError for %s",
    async (_n, text, stop) => {
      const { ledger, provider } = setup(cannedMessagesApi(text, stop).fetch);
      const failure = await provider.generate(request).catch((e) => e);
      expect(failure).toBeInstanceOf(LlmOutputError);
      const [row] = ledger.entries();
      expect(row?.tokens.in).toBeGreaterThan(0);
      expect(failure.usage).toEqual(row?.tokens);
      expect(failure.model).toBe(row?.model);
    },
  );

  it("caps the schema issues an LlmOutputError lists", async () => {
    const Many = z.object(
      Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`field${i}`, z.string()])),
    );
    const { provider } = setup(cannedMessagesApi("{}").fetch);
    const failure = await provider.generate({ ...request, schema: Many }).catch((e) => e);
    expect(failure).toBeInstanceOf(LlmOutputError);
    const listed = (failure as Error).message.split("; ");
    expect(listed).toHaveLength(MAX_REPORTED_ISSUES + 1);
    expect(listed.at(-1)).toBe(`and ${25 - MAX_REPORTED_ISSUES} more issues`);
  });

  describe("a reported issue (retry prompts carry the message)", () => {
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const issueOf = async (key: string) => {
      const { provider } = setup(cannedMessagesApi(JSON.stringify({ [key]: 1 })).fetch);
      const failure = await provider
        .generate({ ...request, schema: z.strictObject({}) })
        .catch((e) => e);
      expect(failure).toBeInstanceOf(LlmOutputError);
      return (failure as Error).message.replace("model output does not match the schema: ", "");
    };

    it("is cut to exactly 200 code points ending in an ellipsis", async () => {
      const issue = await issueOf("k".repeat(300));
      expect(Array.from(issue)).toHaveLength(200);
      expect(issue.endsWith("…")).toBe(true);
    });

    it("never ends in half of an astral character", async () => {
      // The emoji straddle the cut: the 199th code point is the first of many pairs.
      const issue = await issueOf("😀".repeat(300));
      expect(Array.from(issue)).toHaveLength(200);
      expect(issue.endsWith("…")).toBe(true);
      expect(issue).not.toMatch(LONE_SURROGATE);
    });

    it("has control and line-separator characters replaced", async () => {
      const issue = await issueOf("k\nIGNORE\u0007\u2028\u202E\uFEFF\u200E\u061C");
      expect(issue).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_C}\uFEFF]/u);
      expect(issue).toContain("k\uFFFDIGNORE\uFFFD");
    });
  });

  it("refuses a run whose sha is not a full git sha, before any call", () => {
    const { bodies, fetch } = cannedMessagesApi(PARIS);
    expect(() =>
      createClaudeProvider({
        models: DEFAULT_MODELS,
        ledger: createLedger(),
        runId: "r",
        run: { kind: "build", sha: "nope" },
        apiKey: "canned",
        fetch,
      }),
    ).toThrow(LlmError);
    expect(bodies).toHaveLength(0);
  });

  it("stamps every ledger entry with the run's kind and sha", async () => {
    const ledger = createLedger();
    const provider = createClaudeProvider({
      models: DEFAULT_MODELS,
      ledger,
      runId: "build-1",
      run: { kind: "build", sha: "c".repeat(40) },
      apiKey: "canned",
      fetch: cannedMessagesApi(PARIS).fetch,
      now: () => new Date("2026-10-01T12:00:00Z"),
    });
    await provider.generate(request);
    expect(ledger.entries()[0]).toMatchObject({ runKind: "build", sha: "c".repeat(40) });
  });

  it("stamps batched entries, including ones collected from a resumed batch", async () => {
    const run = { kind: "update" as const, sha: "d".repeat(40) };
    const held = new Map<string, JournalEntry>();
    // Never expires and never forgets, so the second provider can resume what the first sent.
    const journal: BatchJournal = {
      lookup: (key) => {
        const entry = held.get(key);
        return entry === undefined ? null : { ...entry, createdAt: new Date().toISOString() };
      },
      record: (batchId, createdAt, items) => {
        for (const { requestKey, customId } of items) {
          held.set(requestKey, { batchId, customId, createdAt });
        }
      },
      forget: () => {},
    };
    const make = (fetch: FetchLike, ledger: TokenLedger) =>
      createClaudeProvider({
        models: DEFAULT_MODELS,
        ledger,
        runId: "update-1",
        run,
        apiKey: "canned",
        fetch,
        pollIntervalMs: 0,
        batchJournal: journal,
      });

    const sentLedger = createLedger();
    const sent = cannedBatchApi([succeededLine("req-0", PARIS)]);
    await make(sent.fetch, sentLedger).generate({ ...request, batch: true });
    expect(sent.posts).toHaveLength(1);
    expect(sentLedger.entries()).toMatchObject([{ batch: true, runKind: "update", sha: run.sha }]);

    const resumedLedger = createLedger();
    const resumed = cannedBatchApi([succeededLine("req-0", PARIS)]);
    await make(resumed.fetch, resumedLedger).generate({ ...request, batch: true });
    expect(resumed.posts).toHaveLength(0);
    expect(resumedLedger.entries()).toMatchObject([
      { batch: true, runKind: "update", sha: run.sha },
    ]);
  });

  it("leaves ledger entries without run fields when no run is given", async () => {
    const { ledger, provider } = setup(cannedMessagesApi(PARIS).fetch);
    await provider.generate(request);
    expect(ledger.entries()[0]).not.toHaveProperty("runKind");
    expect(ledger.entries()[0]).not.toHaveProperty("sha");
  });

  it("routes batch requests through the Batches API and ledgers them as batched", async () => {
    const { fetch, posts } = cannedBatchApi([succeededLine("req-0", PARIS)]);
    const { ledger, provider } = setup(fetch);
    const result = await provider.generate({ ...request, batch: true });
    expect(result.output.city).toBe("Paris");
    expect(posts).toHaveLength(1);
    expect(ledger.entries().map((e) => e.batch)).toEqual([true]);
  });

  it("ledgers a batched call once when its first attempt errors and its second succeeds", async () => {
    const rounds = [
      cannedBatchApi([
        {
          custom_id: "req-0",
          result: {
            type: "errored",
            error: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
          },
        },
      ]),
      cannedBatchApi([succeededLine("req-0", PARIS)]),
    ];
    let round = 0;
    const fetch: FetchLike = async (input, init) => {
      if (init?.method === "POST") round += 1;
      const api = rounds[Math.max(round - 1, 0)];
      if (!api) throw new Error("no canned round");
      return api.fetch(input, init);
    };
    const { ledger, provider } = setup(fetch);
    const result = await provider.generate({ ...request, batch: true });
    expect(result.output.city).toBe("Paris");
    expect(round).toBe(2);
    expect(ledger.entries().map((e) => e.batch)).toEqual([true]);
  });

  it("reports created batch ids and cancels a batch past its deadline", async () => {
    const paths: string[] = [];
    const inProgress = {
      id: "msgbatch_slow",
      type: "message_batch",
      processing_status: "in_progress",
      request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      results_url: null,
      created_at: "2026-10-01T12:00:00Z",
      ended_at: null,
      expires_at: "2026-10-02T12:00:00Z",
      archived_at: null,
      cancel_initiated_at: null,
    };
    const fetch: FetchLike = async (input, init) => {
      paths.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return new Response(JSON.stringify(inProgress), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const created: string[] = [];
    const provider = createClaudeProvider({
      models: DEFAULT_MODELS,
      ledger: createLedger(),
      runId: "test-run",
      apiKey: "canned",
      fetch,
      pollIntervalMs: 0,
      batchDeadlineMs: 0,
      onBatchCreated: (batch) => created.push(batch.id),
    });
    await expect(provider.generate({ ...request, batch: true })).rejects.toThrow(
      "batch msgbatch_slow passed its 0 s deadline and was canceled",
    );
    expect(created).toEqual(["msgbatch_slow"]);
    expect(paths.at(-1)).toBe("POST /v1/messages/batches/msgbatch_slow/cancel");
  });

  it("refuses to start without an API key", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() =>
        createClaudeProvider({ models: DEFAULT_MODELS, ledger: createLedger(), runId: "r" }),
      ).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
