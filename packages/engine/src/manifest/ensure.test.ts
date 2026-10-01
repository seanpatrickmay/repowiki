import { makeManifest } from "@repowiki/core/test-fixtures";
import type { Provider } from "@repowiki/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/index.ts";
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
    await expect(ensureManifest(store, sampleIndex(), options(provider))).rejects.toThrow(
      /is an update, not a build/,
    );
    expect(requests).toHaveLength(0);
  });
});
