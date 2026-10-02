import type { Feature } from "@repowiki/core";
import { makeFeature, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
import { LlmError, type Provider } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { openStore } from "../store/index.ts";
import { deliverablesDraft, fakeWikipedia, pageProvider, signalsDraft } from "./test-provider.ts";
import { testWiki } from "./test-wiki.ts";
import { buildWiki, WikiBuildError } from "./wiki.ts";

function setup(fail: string[] = [], extraFeatures: Feature[] = []) {
  const wiki = testWiki();
  wiki.manifest.features.push(...extraFeatures);
  wiki.sources.set("src/signals/store.py", 'URL = os.getenv("SIGNALS_URL")\n');
  const store = openStore(":memory:");
  store.putManifest(wiki.manifest, { llmRevised: true });
  const { provider, requests } = pageProvider((featureId) =>
    fail.includes(featureId)
      ? new LlmError("expired")
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
    expect(again).toMatchObject({ stored: [], written: null });
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
    expect(requests.map((r) => r.featureId)).toEqual(["signals"]);
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
    expect(new Set(requests.map((r) => r.featureId))).toEqual(new Set(["deliverables", "signals"]));
    expect(store.getCurrentRevision("legacy-export")).toBeNull();
    expect(store.getCurrentRevision("old-signals")).toBeNull();

    const refusing: Provider = {
      async generate() {
        throw new Error("a finished rerun must not call the provider");
      },
    };
    const again = await buildWiki(store, input, { ...options, provider: refusing });
    expect(again).toMatchObject({ stored: [], written: null });
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
});
