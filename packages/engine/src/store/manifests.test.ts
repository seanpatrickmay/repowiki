import { makeFeature, makeManifest, SHA_A, SHA_B, SHA_C } from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DroppedFeatureError, DuplicateManifestError } from "./errors.ts";
import { openStore, type Store } from "./store.ts";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => store.close());

describe("manifests", () => {
  it("round-trips a manifest by sha", () => {
    store.putManifest(makeManifest());
    expect(store.getManifest(SHA_A)).toEqual(makeManifest());
    expect(store.getManifest(SHA_B)).toBeNull();
  });

  it("returns the most recently stored manifest as latest", () => {
    expect(store.getLatestManifest()).toBeNull();
    store.putManifest(makeManifest());
    store.putManifest(makeManifest({ sha: SHA_B }));
    expect(store.getLatestManifest()?.sha).toBe(SHA_B);
  });

  it("refuses a second manifest for the same sha", () => {
    store.putManifest(makeManifest());
    expect(() => store.putManifest(makeManifest())).toThrow(DuplicateManifestError);
  });

  it("refuses a manifest that drops a feature id, and keeps the latest manifest unchanged", () => {
    store.putManifest(makeManifest());
    const dropped = makeManifest({
      sha: SHA_B,
      features: [makeFeature({ id: "deliverables", title: "Deliverables", aliases: [] })],
      membership: { "src/deliverables/crud.py": { featureId: "deliverables", weight: 0.7 } },
    });
    expect(() => store.putManifest(dropped)).toThrow(DroppedFeatureError);
    expect(() => store.putManifest(dropped)).toThrow(/signals/);
    expect(store.getManifest(SHA_B)).toBeNull();
    expect(store.getLatestManifest()).toEqual(makeManifest());
  });

  it("accepts a manifest that keeps every feature id and adds one", () => {
    store.putManifest(makeManifest());
    const base = makeManifest();
    const grown = makeManifest({
      sha: SHA_B,
      features: [...base.features, makeFeature({ id: "billing", title: "Billing", aliases: [] })],
    });
    store.putManifest(grown);
    expect(store.getLatestManifest()).toEqual(grown);
  });

  it("validates before storing", () => {
    const invalid = makeManifest({
      membership: { "src/x.py": { featureId: "ghost", weight: 0.5 } },
    });
    expect(() => store.putManifest(invalid)).toThrow();
    expect(store.getLatestManifest()).toBeNull();
  });

  it("rolls back everything written inside a failed transaction", () => {
    expect(() =>
      store.transaction(() => {
        store.putManifest(makeManifest());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getLatestManifest()).toBeNull();
  });
});

describe("head", () => {
  it("is null until set, then returns the last value", () => {
    expect(store.getHead()).toBeNull();
    store.setHead(SHA_A);
    store.setHead(SHA_B);
    expect(store.getHead()).toBe(SHA_B);
  });

  it("rejects abbreviated shas", () => {
    expect(() => store.setHead("abc123")).toThrow();
  });
});

describe("drift baseline", () => {
  it("is null until an LLM-revised manifest is stored", () => {
    store.putManifest(makeManifest());
    expect(store.getDriftBaseline()).toBeNull();
  });

  it("is the latest LLM-revised manifest; member-only manifests do not move it", () => {
    store.putManifest(makeManifest(), { llmRevised: true });
    store.putManifest(makeManifest({ sha: SHA_B }));
    expect(store.getLatestManifest()?.sha).toBe(SHA_B);
    expect(store.getDriftBaseline()?.sha).toBe(SHA_A);
    store.putManifest(makeManifest({ sha: SHA_C }), { llmRevised: true });
    expect(store.getDriftBaseline()?.sha).toBe(SHA_C);
  });
});
