import { makeManifest, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuplicateManifestError } from "./errors.ts";
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
