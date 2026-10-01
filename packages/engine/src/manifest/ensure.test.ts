import { makeManifest } from "@repowiki/core/test-fixtures";
import type { Provider } from "@repowiki/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/index.ts";
import { ManifestBuildError } from "./build.ts";
import { ensureManifest } from "./ensure.ts";
import { sampleIndex } from "./test-index.ts";
import { SAMPLE_CLUSTER_OPTIONS, SAMPLE_PROPOSAL, scriptedProvider } from "./test-provider.ts";

const options = (provider: Provider) => ({
  provider,
  repoName: "sample",
  clusterOptions: SAMPLE_CLUSTER_OPTIONS,
});

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => store.close());

describe("ensureManifest", () => {
  it("builds and stores the first manifest as the drift baseline", async () => {
    const { provider } = scriptedProvider(SAMPLE_PROPOSAL);
    const { manifest, build } = await ensureManifest(store, sampleIndex(), options(provider));
    expect(build?.manifest).toEqual(manifest);
    expect(store.getLatestManifest()).toEqual(manifest);
    expect(store.getDriftBaseline()).toEqual(manifest);
  });

  it("returns the stored manifest for the same sha without calling the LLM", async () => {
    await ensureManifest(store, sampleIndex(), options(scriptedProvider(SAMPLE_PROPOSAL).provider));
    const { provider, requests } = scriptedProvider();
    const again = await ensureManifest(store, sampleIndex(), options(provider));
    expect(again.build).toBeNull();
    expect(again.manifest.sha).toBe("c".repeat(40));
    expect(requests).toHaveLength(0);
  });

  it("refuses to rebuild over a manifest for another sha", async () => {
    store.putManifest(makeManifest());
    const { provider, requests } = scriptedProvider(SAMPLE_PROPOSAL);
    const attempt = ensureManifest(store, sampleIndex(), options(provider));
    await expect(attempt).rejects.toBeInstanceOf(ManifestBuildError);
    await expect(attempt).rejects.toThrow(/is an update, not a build/);
    expect(requests).toHaveLength(0);
  });

  it("returns the stored manifest for an older sha even when a newer one is stored", async () => {
    const older = makeManifest({ sha: "c".repeat(40) });
    store.putManifest(older);
    store.putManifest(makeManifest({ sha: "d".repeat(40) }));
    const { provider, requests } = scriptedProvider(SAMPLE_PROPOSAL);
    const again = await ensureManifest(store, sampleIndex(), options(provider));
    expect(again.build).toBeNull();
    expect(again.manifest).toEqual(older);
    expect(requests).toHaveLength(0);
  });

  it("returns the manifest another caller stored first when two calls race on an empty store", async () => {
    const first = scriptedProvider(SAMPLE_PROPOSAL);
    const second = scriptedProvider(SAMPLE_PROPOSAL);
    const [a, b] = await Promise.all([
      ensureManifest(store, sampleIndex(), options(first.provider)),
      ensureManifest(store, sampleIndex(), options(second.provider)),
    ]);
    expect(a.manifest).toEqual(b.manifest);
    expect(store.getLatestManifest()).toEqual(a.manifest);
    expect([a.build, b.build].filter((build) => build === null)).toHaveLength(1);
  });
});
