import { createClaudeProvider, createLedger, DEFAULT_MODELS, type FetchLike } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { openStore } from "../store/index.ts";
import { writePages } from "./build.ts";
import { addSampleReadme, architectureDraft } from "./test-architecture.ts";
import { memoryWikipediaCache } from "./test-cache.ts";
import { deliverablesDraft, fakeWikipedia, signalsDraft } from "./test-provider.ts";
import { testWiki } from "./test-wiki.ts";
import { buildJournal, buildWiki } from "./wiki.ts";

/**
 * The Batches API, answering each request from `answer(pageText, batchNumber)`. Every created
 * batch ends at once, unless `hold(batchNumber)` gives a promise its status polls wait on or
 * `running(batchNumber)` keeps it in progress; its POST bodies are kept, cancels apart.
 */
function batchesApi(
  answer: (page: string, batch: number) => unknown,
  hold: (batch: number) => Promise<never> | null = () => null,
  running: (batch: number) => boolean = () => false,
) {
  const canceled: number[] = [];
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
    // Now, so a journal entry is never too old to collect.
    created_at: new Date().toISOString(),
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
    if (path.endsWith("/cancel")) {
      canceled.push(n);
      return json(batch(n, "canceling"));
    }
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return json(batch(posts.length, "in_progress"));
    }
    return (await hold(n)) ?? json(batch(n, running(n) ? "in_progress" : "ended"));
  };
  return { fetch, posts, canceled };
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
/** The project article's pack, which the article's call sends after the pages' rounds. */
const isProject = (page: string) => page.startsWith("# Project:");

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

describe("buildWiki through the real batcher and the store's journal", () => {
  it("collects every batch a killed build left, instead of paying for round 1 again", async () => {
    const broken = signalsDraft();
    const overview = broken.sections[1]?.claims[0];
    if (overview) overview.cite = ["src/signals/ingest.py:90-99"];
    const fixed = { claims: [{ ...overview, cite: ["src/signals/ingest.py:10-24"] }] };
    // The retry batch's polls never end while the first build runs: it is killed there.
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let killed = true;
    const api = batchesApi(
      (page, n) =>
        isProject(page)
          ? architectureDraft()
          : isSignals(page)
            ? n === 1
              ? broken
              : fixed
            : deliverablesDraft(),
      (n) => {
        if (n !== 2 || !killed) return null;
        reached();
        return new Promise<never>(() => {});
      },
    );
    const { manifest, ...input } = testWiki();
    addSampleReadme(input);
    const store = openStore(":memory:");
    store.putManifest(manifest, { llmRevised: true });
    const journaled: string[] = [];
    const build = () => {
      const journal = buildJournal(store);
      const record = journal.record;
      journal.record = (batchId, createdAt, items) => {
        journaled.push(...items.map((item) => item.requestKey));
        record(batchId, createdAt, items);
      };
      const provider = createClaudeProvider({
        models: DEFAULT_MODELS,
        ledger: createLedger(),
        runId: "test-run",
        apiKey: "canned",
        fetch: api.fetch,
        pollIntervalMs: 0,
        batchJournal: journal,
      });
      return buildWiki(store, input, {
        provider,
        journal,
        repoName: "sample",
        wikipediaFetch: fakeWikipedia,
      });
    };
    void build();
    await waiting;
    expect(api.posts.map((p) => p.requests.length)).toEqual([2, 1]);
    killed = false;
    const rerun = await build();
    // Round 1 and the retry are both collected from the batches the killed build created; only
    // the project article's call is new.
    expect(api.posts.map((p) => p.requests.length)).toEqual([2, 1, 1]);
    expect(rerun.stored.map((r) => r.featureId)).toEqual(["deliverables", "signals"]);
    expect(rerun.architecture?.failure).toBeNull();
    // The pages and the article are stored, so every row is forgotten: a third run would send
    // afresh.
    expect(journaled).toHaveLength(4);
    expect(journaled.map((key) => store.findBatchRequest(key))).toEqual([null, null, null, null]);
  });

  it("collects the article's batch a build was killed in, instead of paying for it again", async () => {
    // Batch 1 holds both pages; batch 2 is the article's, whose polls never end in the first run.
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let killed = true;
    const api = batchesApi(
      (page) =>
        isProject(page)
          ? architectureDraft()
          : isSignals(page)
            ? signalsDraft()
            : deliverablesDraft(),
      (n) => {
        if (n !== 2 || !killed) return null;
        reached();
        return new Promise<never>(() => {});
      },
    );
    const { manifest, ...input } = testWiki();
    addSampleReadme(input);
    const store = openStore(":memory:");
    store.putManifest(manifest, { llmRevised: true });
    const journaled: string[] = [];
    const build = () => {
      const journal = buildJournal(store);
      const record = journal.record;
      journal.record = (batchId, createdAt, items) => {
        journaled.push(...items.map((item) => item.requestKey));
        record(batchId, createdAt, items);
      };
      const provider = createClaudeProvider({
        models: DEFAULT_MODELS,
        ledger: createLedger(),
        runId: "test-run",
        apiKey: "canned",
        fetch: api.fetch,
        pollIntervalMs: 0,
        batchJournal: journal,
      });
      return buildWiki(store, input, {
        provider,
        journal,
        repoName: "sample",
        wikipediaFetch: fakeWikipedia,
      });
    };
    void build();
    await waiting;
    // The pages are stored and forgotten; only the article's row is left, and no article is.
    expect(api.posts.map((p) => p.requests.length)).toEqual([2, 1]);
    expect(store.listCurrentRevisions()).toHaveLength(2);
    expect(store.getCurrentArchitecture()).toBeNull();
    expect(journaled).toHaveLength(3);
    expect(journaled.map((key) => store.findBatchRequest(key) !== null)).toEqual([
      false,
      false,
      true,
    ]);
    killed = false;
    const rerun = await build();
    expect(api.posts.map((p) => p.requests.length)).toEqual([2, 1]);
    expect(rerun.stored).toEqual([]);
    expect(rerun.architecture?.failure).toBeNull();
    expect(store.getCurrentArchitecture()?.title).toBe("Sample Ops");
    expect(journaled).toHaveLength(3);
    expect(journaled.map((key) => store.findBatchRequest(key))).toEqual([null, null, null]);
  });

  it("keeps every row of a page whose retry batch was canceled, so a rerun pays for nothing", async () => {
    const broken = signalsDraft();
    const overview = broken.sections[1]?.claims[0];
    if (overview) overview.cite = ["src/signals/ingest.py:90-99"];
    const fixed = { claims: [{ ...overview, cite: ["src/signals/ingest.py:10-24"] }] };
    let first = true;
    const api = batchesApi(
      (page, n) =>
        isProject(page)
          ? architectureDraft()
          : isSignals(page)
            ? n === 1
              ? broken
              : fixed
            : deliverablesDraft(),
      () => null,
      // The first build's retry batch never ends in time: its deadline cancels it.
      (n) => first && n === 2,
    );
    const { manifest, ...input } = testWiki();
    addSampleReadme(input);
    const store = openStore(":memory:");
    store.putManifest(manifest, { llmRevised: true });
    const journaled: string[] = [];
    const build = (deadline?: number) => {
      const journal = buildJournal(store);
      const record = journal.record;
      journal.record = (batchId, createdAt, items) => {
        journaled.push(...items.map((item) => item.requestKey));
        record(batchId, createdAt, items);
      };
      const provider = createClaudeProvider({
        models: DEFAULT_MODELS,
        ledger: createLedger(),
        runId: "test-run",
        apiKey: "canned",
        fetch: api.fetch,
        pollIntervalMs: 0,
        batchJournal: journal,
        onBatchRequest: journal.tag,
        ...(deadline === undefined ? {} : { batchDeadlineMs: deadline }),
      });
      return buildWiki(store, input, {
        provider,
        journal,
        repoName: "sample",
        wikipediaFetch: fakeWikipedia,
      });
    };
    const killed = await build(50);
    expect(api.canceled).toEqual([2]);
    expect(killed.stored.map((r) => r.featureId)).toEqual(["deliverables"]);
    first = false;
    const rerun = await build();
    // The rerun collects signals' round-1 answer and its retry from the batches already paid for,
    // then asks for the project article, which one page alone did not get.
    expect(api.posts.map((p) => p.requests.length)).toEqual([2, 1, 1]);
    expect(rerun.stored.map((r) => r.featureId)).toEqual(["signals"]);
    // Everything is settled and stored, so no row is left for a third run to collect.
    expect(journaled.length).toBeGreaterThan(0);
    expect(journaled.map((key) => store.findBatchRequest(key))).toEqual(journaled.map(() => null));
  });
});
