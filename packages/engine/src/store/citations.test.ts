import {
  bodyClaim,
  codeCitation,
  commitCitation,
  leadClaim,
  makeManifest,
  makeRevision,
  SHA_B,
} from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "./store.ts";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
  store.putManifest(makeManifest());
  store.putRevision(makeRevision()); // c-1 cites src/signals/ingest.py L10-24
});
afterEach(() => store.close());

const PATH = "src/signals/ingest.py";
const hits = (start: number, end: number, path = PATH) =>
  store.findClaimsCitingRange(path, start, end).map((c) => c.claimId);

describe("findClaimsCitingRange", () => {
  it("returns the citing claim with its location", () => {
    expect(store.findClaimsCitingRange(PATH, 12, 13)).toEqual([
      { featureId: "signals", revisionId: "rev-1", claimId: "c-1", startLine: 10, endLine: 24 },
    ]);
  });

  it.each([
    [24, 30, "touching the last cited line"],
    [1, 10, "touching the first cited line"],
    [1, 100, "covering the whole range"],
    [10, 10, "a single boundary line"],
  ])("matches %i-%i (%s)", (start, end) => {
    expect(hits(start, end)).toEqual(["c-1"]);
  });

  it.each([
    [25, 30],
    [1, 9],
  ])("does not match the disjoint range %i-%i", (start, end) => {
    expect(hits(start, end)).toEqual([]);
  });

  it("does not match other paths", () => {
    expect(hits(10, 24, "src/signals/ingest_test.py")).toEqual([]);
  });

  it("only considers current revisions", () => {
    const moved = makeRevision({
      id: "rev-2",
      parentId: "rev-1",
      reason: "update",
      sha: SHA_B,
      sections: [
        { key: "lead", claims: [leadClaim()] },
        {
          key: "overview",
          claims: [bodyClaim({ citations: [codeCitation({ startLine: 40, endLine: 50 })] })],
        },
      ],
    });
    store.putRevision(moved);
    expect(hits(10, 24)).toEqual([]);
    expect(hits(45, 45)).toEqual(["c-1"]);
  });

  it("ignores commit citations", () => {
    const history = makeRevision({
      id: "rev-h",
      featureId: "deliverables",
      seeAlso: [],
      sections: [
        { key: "lead", claims: [leadClaim({ supports: ["h-1"] })] },
        {
          key: "history",
          claims: [bodyClaim({ id: "h-1", kind: "history", citations: [commitCitation()] })],
        },
      ],
    });
    store.putRevision(history);
    expect(hits(1, 1000)).toEqual(["c-1"]);
  });

  it("rejects an inverted range", () => {
    expect(() => store.findClaimsCitingRange(PATH, 30, 10)).toThrow(RangeError);
  });

  it.each([
    [Number.NaN, 10, "a NaN start"],
    [1, Number.NaN, "a NaN end"],
    [1.5, 10, "a fractional start"],
    [1, 10.5, "a fractional end"],
    [0, 10, "a start below line 1"],
    [1, 0, "an end below line 1"],
  ])("rejects non-line bounds %f-%f (%s)", (start, end) => {
    expect(() => store.findClaimsCitingRange(PATH, start, end)).toThrow(RangeError);
    expect(() => store.findClaimsCitingRange(PATH, start, end)).toThrow(/integer/);
  });
});
