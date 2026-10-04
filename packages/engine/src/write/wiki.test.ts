import type { Feature } from "@repowiki/core";
import { makeFeature, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
import { LlmError, type Provider } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { openStore } from "../store/index.ts";
import { addSampleReadme, architectureDraft } from "./test-architecture.ts";
import { deliverablesDraft, fakeWikipedia, pageProvider, signalsDraft } from "./test-provider.ts";
import { testWiki } from "./test-wiki.ts";
import { buildJournal, buildWiki, WikiBuildError } from "./wiki.ts";

function setup(fail: string[] = [], extraFeatures: Feature[] = []) {
  const wiki = testWiki();
  wiki.manifest.features.push(...extraFeatures);
  wiki.sources.set("src/signals/store.py", 'URL = os.getenv("SIGNALS_URL")\n');
  // The project article's purpose claim cites the README.
  addSampleReadme(wiki);
  const store = openStore(":memory:");
  store.putManifest(wiki.manifest, { llmRevised: true });
  // The Architecture call has no feature id, so the provider sees "" for it.
  const { provider, requests } = pageProvider((featureId) =>
    fail.includes(featureId)
      ? new LlmError("expired")
      : featureId === ""
        ? architectureDraft()
        : featureId === "signals"
          ? signalsDraft()
          : deliverablesDraft(),
  );
  const options = {
    provider,
    repoName: "sample",
    wikipediaFetch: fakeWikipedia,
    now: () => new Date("2026-10-01T12:00:00Z"),
  };
  const { manifest: _manifest, ...input } = wiki;
  return { store, input, options, requests };
}

describe("buildWiki", () => {
  it("adds code aliases, stores every page and the head, and caches Wikipedia lookups", async () => {
    const { store, input, options } = setup();
    const build = await buildWiki(store, input, options);
    expect(build.aliases).toEqual({ signals: ["SIGNALS_URL"] });
    expect(store.getLatestManifest()?.features[0]?.aliases).toEqual([
      "signal pipeline",
      "SIGNALS_URL",
    ]);
    expect(build.stored.map((r) => r.featureId)).toEqual(["deliverables", "signals"]);
    expect(store.listCurrentRevisions().map((r) => r.id)).toEqual(build.stored.map((r) => r.id));
    expect(store.getHead()).toBe(input.index.sha);
    expect(store.getWikipediaSummary("Message queue")?.summary?.title).toBe("Message queue");
    expect(build.architectureSkipped).toBeNull();
    expect(build.architecture?.failure).toBeNull();
    expect(store.getCurrentArchitecture()).toEqual(build.architecture?.architecture);
    expect(store.getCurrentArchitecture()?.basis).toEqual(build.stored.map((r) => r.id).sort());
  });

  it("asks for the Architecture article only after every page's round, in a call of its own", async () => {
    const { store, input, options, requests } = setup();
    await buildWiki(store, input, options);
    expect(requests.map((r) => r.featureId)).toEqual(["deliverables", "signals", undefined]);
    const pageTurn = Math.max(...requests.slice(0, 2).map((r) => r.turn));
    expect(requests[2]?.turn).toBeGreaterThan(pageTurn);
  });

  it("makes no call, even to a provider that fails on any, when every page is stored", async () => {
    const { store, input, options, requests } = setup();
    await buildWiki(store, input, options);
    const calls = requests.length;
    const refusing: Provider = {
      async generate() {
        throw new Error("a finished rerun must not call the provider");
      },
    };
    const again = await buildWiki(store, input, { ...options, provider: refusing });
    expect(again).toMatchObject({
      stored: [],
      written: null,
      architecture: null,
      architectureSkipped: "current",
    });
    expect(requests).toHaveLength(calls);
    expect(again.aliases).toEqual({ signals: ["SIGNALS_URL"] });
    expect(store.getLatestManifest()?.features[0]?.aliases).toEqual([
      "signal pipeline",
      "SIGNALS_URL",
    ]);
  });

  it("writes only the missing pages on a rerun at the same sha", async () => {
    const first = setup(["signals"]);
    const build = await buildWiki(first.store, first.input, first.options);
    expect(build.stored.map((r) => r.featureId)).toEqual(["deliverables"]);
    const { requests, options } = setup();
    await buildWiki(first.store, first.input, options);
    // One page was too few for an Architecture article; with both, the rerun writes it.
    expect(build.architectureSkipped).toBe("too few pages");
    expect(requests.map((r) => r.featureId)).toEqual(["signals", undefined]);
    expect(first.store.listArchitectureHistory()).toHaveLength(1);
    expect(first.store.listCurrentRevisions()).toHaveLength(2);
    // The resumed run shares the first run's cached prefix, though it writes fewer pages.
    expect(requests[0]?.cacheKey).toBeDefined();
    expect(requests[0]?.cacheKey).toBe(first.requests[0]?.cacheKey);
    expect(requests[0]?.system).toBe(first.requests[0]?.system);
  });

  it("refuses a store built at another sha, or without a manifest for this one", async () => {
    const { store, input, options, requests } = setup();
    store.setHead(SHA_B);
    await expect(buildWiki(store, input, options)).rejects.toThrow(
      `the wiki was built at ${SHA_B}; moving it to ${input.index.sha} is an update, not a build`,
    );
    expect(requests).toHaveLength(0);
    expect(store.getLatestManifest()?.features[0]?.aliases).toEqual(["signal pipeline"]);
    expect(store.listCurrentRevisions()).toEqual([]);

    const empty = openStore(":memory:");
    const refusal = buildWiki(empty, input, options);
    await expect(refusal).rejects.toThrow(WikiBuildError);
    await expect(refusal).rejects.toThrow(
      `the store has no manifest for ${input.index.sha}; run manifest:build first`,
    );
    expect(requests).toHaveLength(0);
    expect(empty.getLatestManifest()).toBeNull();
    expect(empty.getHead()).toBeNull();
  });

  it("never writes a retired or a redirect feature, and a finished rerun still makes no call", async () => {
    const retired = makeFeature({
      id: "legacy-export",
      title: "Legacy export",
      aliases: [],
      lineage: [
        { kind: "create", sha: SHA_A },
        { kind: "retire", sha: SHA_A },
      ],
      status: { kind: "retired" },
    });
    const merged = makeFeature({
      id: "old-signals",
      title: "Old signals",
      aliases: [],
      lineage: [
        { kind: "create", sha: SHA_A },
        { kind: "merge", sha: SHA_A, into: "signals" },
      ],
      status: { kind: "redirect", to: "signals" },
    });
    const { store, input, options, requests } = setup([], [retired, merged]);
    const build = await buildWiki(store, input, options);
    expect(build.stored.map((r) => r.featureId)).toEqual(["deliverables", "signals"]);
    expect(new Set(requests.map((r) => r.featureId))).toEqual(
      new Set(["deliverables", "signals", undefined]),
    );
    expect(store.getCurrentRevision("legacy-export")).toBeNull();
    expect(store.getCurrentRevision("old-signals")).toBeNull();

    const refusing: Provider = {
      async generate() {
        throw new Error("a finished rerun must not call the provider");
      },
    };
    const again = await buildWiki(store, input, { ...options, provider: refusing });
    expect(again).toMatchObject({ stored: [], written: null, architectureSkipped: "current" });
  });

  it("writes no Architecture article, and makes no call for one, for a one-feature wiki", async () => {
    const { store, input, options, requests } = setup();
    const manifest = store.getManifest(input.index.sha);
    if (manifest === null) throw new Error("no manifest");
    const alone = openStore(":memory:");
    alone.putManifest(
      {
        ...manifest,
        features: manifest.features.filter((f) => f.id === "signals"),
        membership: Object.fromEntries(
          Object.entries(manifest.membership).map(([member, m]) => [
            member,
            { ...m, featureId: "signals" },
          ]),
        ),
      },
      { llmRevised: true },
    );
    const build = await buildWiki(alone, input, options);
    expect(build.stored.map((r) => r.featureId)).toEqual(["signals"]);
    expect(build).toMatchObject({ architecture: null, architectureSkipped: "too few pages" });
    expect(requests.map((r) => r.featureId)).toEqual(["signals"]);
    expect(alone.getCurrentArchitecture()).toBeNull();
    alone.close();
    store.close();
  });

  it("keeps the pages when the Architecture call fails, and a rerun writes only the article", async () => {
    const first = setup([""]);
    const build = await buildWiki(first.store, first.input, first.options);
    expect(build.stored).toHaveLength(2);
    expect(build.architecture?.failure).toBe("the architecture call failed: LlmError: expired");
    expect(first.store.getHead()).toBe(first.input.index.sha);
    expect(first.store.getCurrentArchitecture()).toBeNull();

    const { requests, options } = setup();
    const again = await buildWiki(first.store, first.input, options);
    expect(requests.map((r) => r.featureId)).toEqual([undefined]);
    expect(again.stored).toEqual([]);
    expect(first.store.getCurrentArchitecture()?.parentId).toBeNull();
  });

  it("still writes the article when a rerun's only missing page fails again, others being stored", async () => {
    const extra = makeFeature({ id: "extra", title: "Extra", aliases: [] });
    const first = setup(["extra", ""], [extra]);
    const build = await buildWiki(first.store, first.input, first.options);
    expect(build.stored.map((r) => r.featureId)).toEqual(["deliverables", "signals"]);
    expect(build.architecture?.failure).not.toBeNull();
    expect(first.store.getCurrentArchitecture()).toBeNull();

    // The same page fails again; the other two are stored, so the article must still be written.
    const { requests, options } = setup(["extra"], [extra]);
    const again = await buildWiki(first.store, first.input, options);
    expect(again.stored).toEqual([]);
    expect(again.written?.pages.map((p) => [p.featureId, p.revision])).toEqual([["extra", null]]);
    expect(again.architecture?.failure).toBeNull();
    expect(requests.map((r) => r.featureId)).toEqual(["extra", undefined]);
    expect(first.store.getCurrentArchitecture()?.basis).toHaveLength(2);
    expect(first.store.getHead()).toBe(first.input.index.sha);
  });

  it("rewrites the article, parented on the old one, when the set of pages changed", async () => {
    const { store, input, options } = setup();
    const build = await buildWiki(store, input, options);
    const old = build.architecture?.architecture;
    // A page stored outside this build (as an update would) changes the article's basis.
    const signals = store.getCurrentRevision("signals");
    if (signals === null || old === undefined || old === null) throw new Error("no build");
    store.putRevision({ ...signals, id: "signals-2", parentId: signals.id, reason: "update" });
    await buildWiki(store, input, options);
    const history = store.listArchitectureHistory();
    expect(history.map((a) => a.parentId)).toEqual([null, old.id]);
    expect(history[1]?.id).toBe(`architecture-${input.index.sha.slice(0, 12)}-2`);
    expect(history[1]?.basis).toContain("signals-2");
  });

  it("stores nothing when no page could be written", async () => {
    const { store, input, options } = setup(["signals", "deliverables"]);
    await expect(buildWiki(store, input, options)).rejects.toThrow(/no page could be written/);
    expect(store.getHead()).toBeNull();
    expect(store.listCurrentRevisions()).toEqual([]);
  });

  it("stores the pages and the head together: a failure midway stores none of them", async () => {
    const { store, input, options } = setup();
    let puts = 0;
    const failing = {
      ...store,
      putRevision(revision: Parameters<typeof store.putRevision>[0]) {
        puts += 1;
        if (puts === 2) throw new Error("disk full");
        store.putRevision(revision);
      },
    };
    await expect(buildWiki(failing, input, options)).rejects.toThrow("disk full");
    expect(puts).toBe(2);
    expect(store.listCurrentRevisions()).toEqual([]);
    expect(store.getHead()).toBeNull();

    const failingHead = {
      ...store,
      setHead() {
        throw new Error("meta locked");
      },
    };
    await expect(buildWiki(failingHead, input, options)).rejects.toThrow("meta locked");
    expect(store.listCurrentRevisions()).toEqual([]);
    expect(store.getHead()).toBeNull();

    // The failed runs left the store clean, so a plain rerun builds everything.
    const build = await buildWiki(store, input, options);
    expect(build.stored.map((r) => r.featureId)).toEqual(["deliverables", "signals"]);
    expect(store.getHead()).toBe(input.index.sha);
  });

  it("forgets journal rows only in the transaction that settles the pages, failed ones too", async () => {
    const { store, input, options } = setup(["signals", "deliverables"]);
    const journal = buildJournal(store);
    const at = new Date().toISOString();
    const keys = ["deliverables", "signals"];
    journal.record(
      "msgbatch_1",
      at,
      keys.map((key, i) => ({ requestKey: key, customId: `req-${i}` })),
    );
    // The batcher forgets a request as soon as its answer is read, as this provider does.
    const forgetting = (inner: Provider): Provider => ({
      generate(request) {
        journal.forget("msgbatch_1", [request.featureId ?? ""]);
        return inner.generate(request);
      },
    });
    const failing = {
      ...store,
      putRevision() {
        throw new Error("disk full");
      },
    };
    const passing = setup().options;
    await expect(
      buildWiki(failing, input, { ...passing, provider: forgetting(passing.provider), journal }),
    ).rejects.toThrow("disk full");
    expect(keys.map((key) => store.findBatchRequest(key)?.batchId)).toEqual([
      "msgbatch_1",
      "msgbatch_1",
    ]);

    // Every page failed: the rows are forgotten all the same, so a rerun asks afresh.
    const provider = forgetting(options.provider);
    await expect(buildWiki(store, input, { ...options, provider, journal })).rejects.toThrow(
      /no page could be written/,
    );
    expect(keys.map((key) => store.findBatchRequest(key))).toEqual([null, null]);
  });

  it("forgets a failed article's journal row too, and stores nothing for it", async () => {
    const { store, input, options } = setup([""]);
    const journal = buildJournal(store);
    journal.record("msgbatch_2", new Date().toISOString(), [
      { requestKey: "architecture", customId: "req-a" },
    ]);
    const provider: Provider = {
      generate(request) {
        if (request.featureId === undefined) journal.forget("msgbatch_2", ["architecture"]);
        return options.provider.generate(request);
      },
    };
    const build = await buildWiki(store, input, { ...options, provider, journal });
    expect(build.architecture?.failure).not.toBeNull();
    expect(store.findBatchRequest("architecture")).toBeNull();
    expect(store.getCurrentArchitecture()).toBeNull();
    expect(store.listCurrentRevisions()).toHaveLength(2);
  });

  it("forgets the project article's journal row only once the article is stored", async () => {
    const { store, input, options } = setup();
    const journal = buildJournal(store);
    journal.record("msgbatch_2", new Date().toISOString(), [
      { requestKey: "architecture", customId: "req-a" },
    ]);
    let rowAtStore: unknown = "unread";
    const watching = {
      ...store,
      putArchitecture(article: Parameters<typeof store.putArchitecture>[0]) {
        rowAtStore = store.findBatchRequest("architecture")?.batchId;
        store.putArchitecture(article);
      },
    };
    const provider: Provider = {
      generate(request) {
        if (request.featureId === undefined) journal.forget("msgbatch_2", ["architecture"]);
        return options.provider.generate(request);
      },
    };
    await buildWiki(watching, input, { ...options, provider, journal });
    expect(rowAtStore).toBe("msgbatch_2");
    expect(store.findBatchRequest("architecture")).toBeNull();
    expect(store.getCurrentArchitecture()?.title).toBe("Sample Ops");
  });

  it("forgets the article's journal row even when the store refuses the article", async () => {
    const { store, input, options } = setup();
    const journal = buildJournal(store);
    journal.record("msgbatch_2", new Date().toISOString(), [
      { requestKey: "architecture", customId: "req-a" },
    ]);
    const refusing = {
      ...store,
      putArchitecture() {
        throw new Error("disk full");
      },
    };
    const provider: Provider = {
      generate(request) {
        if (request.featureId === undefined) journal.forget("msgbatch_2", ["architecture"]);
        return options.provider.generate(request);
      },
    };
    await expect(buildWiki(refusing, input, { ...options, provider, journal })).rejects.toThrow(
      "disk full",
    );
    // A rerun pays for one new article call instead of replaying the answer the store refused.
    expect(store.findBatchRequest("architecture")).toBeNull();
    expect(store.listCurrentRevisions()).toHaveLength(2);
  });
});

describe("buildJournal", () => {
  it("keeps every untagged row while one untagged request is still unanswered", () => {
    const store = openStore(":memory:");
    const journal = buildJournal(store);
    const at = new Date().toISOString();
    // Round 1 of the article was answered; its retry batch failed as a whole.
    journal.record("msgbatch_1", at, [{ requestKey: "round-1", customId: "req-1" }]);
    journal.record("msgbatch_2", at, [{ requestKey: "retry", customId: "req-2" }]);
    journal.tag("round-1", null);
    journal.tag("retry", null);
    journal.forget("msgbatch_1", ["round-1"]);
    store.transaction(() => journal.flush());
    expect(store.findBatchRequest("round-1")?.batchId).toBe("msgbatch_1");
    // Once the retry is answered too, both are forgotten.
    journal.forget("msgbatch_2", ["retry"]);
    store.transaction(() => journal.flush());
    expect([store.findBatchRequest("round-1"), store.findBatchRequest("retry")]).toEqual([
      null,
      null,
    ]);
    store.close();
  });
});
