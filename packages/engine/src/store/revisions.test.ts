import {
  bodyClaim,
  leadClaim,
  makeManifest,
  makeRevision,
  SHA_B,
} from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DuplicateRevisionError,
  StaleParentError,
  StoreError,
  UnknownFeatureError,
} from "./errors.ts";
import { openStore, type Store } from "./store.ts";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
  store.putManifest(makeManifest()); // features: signals, deliverables
});
afterEach(() => store.close());

const rev1 = makeRevision();
const rev2 = makeRevision({ id: "rev-2", parentId: "rev-1", reason: "update", sha: SHA_B, pr: 88 });

describe("revisions", () => {
  it("round-trips a revision, including non-ASCII text", () => {
    const unicode = makeRevision({
      sections: [
        { key: "lead", claims: [leadClaim({ text: "**信号** ingestion — ✓ émoji 🚀" })] },
        { key: "overview", claims: [bodyClaim()] },
      ],
    });
    store.putRevision(unicode);
    expect(store.getRevision("rev-1")).toEqual(unicode);
    expect(store.getRevision("missing")).toBeNull();
  });

  it("advances the current revision along the parent chain", () => {
    store.putRevision(rev1);
    store.putRevision(rev2);
    expect(store.getCurrentRevision("signals")).toEqual(rev2);
    expect(store.getCurrentRevision("deliverables")).toBeNull();
  });

  it("lists history oldest first", () => {
    store.putRevision(rev1);
    store.putRevision(rev2);
    expect(store.listHistory("signals").map((r) => r.id)).toEqual(["rev-1", "rev-2"]);
  });

  it("lists one current revision per feature, sorted by feature id", () => {
    store.putRevision(rev1);
    store.putRevision(rev2);
    store.putRevision(makeRevision({ id: "rev-d", featureId: "deliverables", seeAlso: [] }));
    expect(store.listCurrentRevisions().map((r) => r.id)).toEqual(["rev-d", "rev-2"]);
  });

  it("rejects a second build for a feature that already has a page", () => {
    store.putRevision(rev1);
    expect(() => store.putRevision(makeRevision({ id: "rev-1b" }))).toThrow(StaleParentError);
  });

  it("rejects an update built from a parent that is no longer current, and stores nothing", () => {
    store.putRevision(rev1);
    store.putRevision(rev2);
    const sibling = makeRevision({ id: "rev-2b", parentId: "rev-1", reason: "update", sha: SHA_B });
    expect(() => store.putRevision(sibling)).toThrow(StaleParentError);
    expect(store.getRevision("rev-2b")).toBeNull();
    expect(store.getCurrentRevision("signals")?.id).toBe("rev-2");
  });

  it("rejects a revision for a feature missing from the latest manifest, and stores nothing", () => {
    const ghost = makeRevision({ id: "rev-g", featureId: "ghost", seeAlso: [] });
    expect(() => store.putRevision(ghost)).toThrow(UnknownFeatureError);
    expect(() => store.putRevision(ghost)).toThrow(/ghost/);
    expect(store.getRevision("rev-g")).toBeNull();
    expect(store.getCurrentRevision("ghost")).toBeNull();
  });

  it("rejects a revision stored before any manifest, and stores nothing", () => {
    const empty = openStore(":memory:");
    try {
      expect(() => empty.putRevision(makeRevision())).toThrow(UnknownFeatureError);
      expect(empty.getRevision("rev-1")).toBeNull();
    } finally {
      empty.close();
    }
  });

  it("validates before storing", () => {
    expect(() => store.putRevision(makeRevision({ seeAlso: ["signals"] }))).toThrow();
    expect(store.getRevision("rev-1")).toBeNull();
  });

  it("refuses a revision id that is already stored, as a StoreError naming it", () => {
    store.putRevision(rev1);
    const reused = makeRevision({ featureId: "deliverables", seeAlso: [] });
    expect(() => store.putRevision(reused)).toThrow(DuplicateRevisionError);
    expect(() => store.putRevision(reused)).toThrow(StoreError);
    expect(() => store.putRevision(reused)).toThrow("a revision with id rev-1 is already stored");
    expect(store.getCurrentRevision("deliverables")).toBeNull();
  });
});

describe("a run's transaction (issue #53)", () => {
  it("leaves the current pointers, citation ranges and head untouched when it throws", () => {
    store.putRevision(rev1);
    store.setHead(rev1.sha);
    expect(() =>
      store.transaction(() => {
        store.putRevision(rev2);
        store.setHead(SHA_B);
        throw new Error("the run failed");
      }),
    ).toThrow("the run failed");
    expect(store.getCurrentRevision("signals")?.id).toBe("rev-1");
    expect(store.getRevision("rev-2")).toBeNull();
    expect(store.getHead()).toBe(rev1.sha);
    expect(store.findClaimsCitingRange("src/signals/ingest.py", 10, 24)).toEqual([
      { featureId: "signals", revisionId: "rev-1", claimId: "c-1", startLine: 10, endLine: 24 },
    ]);
  });
});
