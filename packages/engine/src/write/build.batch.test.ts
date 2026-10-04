import { createClaudeProvider, createLedger, DEFAULT_MODELS, type FetchLike } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { writePages } from "./build.ts";
import { memoryWikipediaCache } from "./test-cache.ts";
import { deliverablesDraft, fakeWikipedia, signalsDraft } from "./test-provider.ts";
import { testWiki } from "./test-wiki.ts";

/**
 * The Batches API, answering each request from `answer(pageText, batchNumber)`. Every created
 * batch ends at once; its POST bodies are kept.
 */
function batchesApi(answer: (page: string, batch: number) => unknown) {
  const posts: {
    requests: { custom_id: string; params: { messages: { content: string }[] } }[];
  }[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const batch = (n: number, status: string) => ({
    id: `msgbatch_${n}`,
    type: "message_batch",
    processing_status: status,
    request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    results_url: `https://api.anthropic.com/v1/messages/batches/msgbatch_${n}/results`,
    created_at: "2026-10-01T12:00:00Z",
    ended_at: null,
    expires_at: "2026-10-02T12:00:00Z",
    archived_at: null,
    cancel_initiated_at: null,
  });
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const n = Number(/msgbatch_(\d+)/.exec(path)?.[1] ?? posts.length);
    if (path.endsWith("/results")) {
      const lines = (posts[n - 1]?.requests ?? []).map((r) => ({
        custom_id: r.custom_id,
        result: {
          type: "succeeded",
          message: {
            id: "msg",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5-20251001",
            content: [
              {
                type: "text",
                text: JSON.stringify(answer(r.params.messages[0]?.content ?? "", n)),
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
      }));
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n"), {
        status: 200,
        headers: { "content-type": "application/x-jsonl" },
      });
    }
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return json(batch(posts.length, "in_progress"));
    }
    return json(batch(n, "ended"));
  };
  return { fetch, posts };
}

function run(answer: (page: string, batch: number) => unknown) {
  const api = batchesApi(answer);
  const provider = createClaudeProvider({
    models: DEFAULT_MODELS,
    ledger: createLedger(),
    runId: "test-run",
    apiKey: "canned",
    fetch: api.fetch,
    pollIntervalMs: 0,
  });
  const written = writePages(testWiki(), {
    provider,
    repoName: "sample",
    wikipedia: { cache: memoryWikipediaCache(), fetch: fakeWikipedia },
  });
  return { api, written };
}

const isSignals = (page: string) => page.startsWith("# Page: Signal ingestion");

describe("writePages through the real batcher (M3 review: the same-tick contract)", () => {
  it("sends every page's first call in one Message Batch", async () => {
    const { api, written } = run((page) =>
      isSignals(page) ? signalsDraft() : deliverablesDraft(),
    );
    expect((await written).pages.every((p) => p.revision !== null)).toBe(true);
    expect(api.posts.map((p) => p.requests.length)).toEqual([2]);
  });

  it("sends the retry round as one more batch holding only the pages that need it", async () => {
    const broken = signalsDraft();
    const overview = broken.sections[1]?.claims[0];
    if (overview) overview.cite = ["src/signals/ingest.py:90-99"];
    const fixed = { claims: [{ ...overview, cite: ["src/signals/ingest.py:10-24"] }] };
    const { api, written } = run((page, n) =>
      isSignals(page) ? (n === 1 ? broken : fixed) : deliverablesDraft(),
    );
    expect((await written).pages.map((p) => p.dropped)).toEqual([[], []]);
    expect(api.posts.map((p) => p.requests.length)).toEqual([2, 1]);
    const retried = api.posts[1]?.requests.map((r) => r.params.messages[0]?.content ?? "");
    expect(retried?.map(isSignals)).toEqual([true]);
  });
});
