import { describe, expect, it } from "vitest";
import { Feature, FeatureId } from "./feature.ts";
import { makeFeature, SHA_A, SHA_B } from "./test-fixtures.ts";

describe("FeatureId", () => {
  it.each(["signals", "signal-ingestion", "sow-v2"])("accepts %s", (id) => {
    expect(FeatureId.safeParse(id).success).toBe(true);
  });

  it.each(["Signals", "signal_ingestion", "-signals", "signals-", "", "a--b"])(
    "rejects %j",
    (id) => {
      expect(FeatureId.safeParse(id).success).toBe(false);
    },
  );
});

describe("Feature", () => {
  it("accepts an active feature", () => {
    expect(Feature.parse(makeFeature())).toEqual(makeFeature());
  });

  it("requires lineage to start with create", () => {
    const lineage = [{ kind: "rename" as const, sha: SHA_A, fromTitle: "Signals" }];
    expect(Feature.safeParse(makeFeature({ lineage })).success).toBe(false);
  });

  it("rejects a redirect to itself", () => {
    expect(
      Feature.safeParse(makeFeature({ status: { kind: "redirect", to: "signals" } })).success,
    ).toBe(false);
  });

  it("requires a disambiguation to list at least two targets", () => {
    const status = { kind: "disambiguation" as const, to: ["signal-ingest"] };
    expect(Feature.safeParse(makeFeature({ status })).success).toBe(false);
  });

  it("accepts merge and split lineage events", () => {
    const lineage = [
      { kind: "create" as const, sha: SHA_A },
      { kind: "split" as const, sha: SHA_B, into: ["signal-ingest", "signal-scoring"] },
    ];
    const status = { kind: "disambiguation" as const, to: ["signal-ingest", "signal-scoring"] };
    expect(Feature.safeParse(makeFeature({ lineage, status })).success).toBe(true);
  });

  it("rejects disambiguation that includes self", () => {
    const status = { kind: "disambiguation" as const, to: ["signals", "signal-ingest"] };
    expect(Feature.safeParse(makeFeature({ status })).success).toBe(false);
  });

  it("rejects disambiguation with duplicate targets", () => {
    const status = { kind: "disambiguation" as const, to: ["signal-ingest", "signal-ingest"] };
    expect(Feature.safeParse(makeFeature({ status })).success).toBe(false);
  });

  it("rejects merge lineage that targets self", () => {
    const lineage = [
      { kind: "create" as const, sha: SHA_A },
      { kind: "merge" as const, sha: SHA_B, into: "signals" },
    ];
    expect(Feature.safeParse(makeFeature({ lineage })).success).toBe(false);
  });

  it("rejects split lineage that includes self", () => {
    const lineage = [
      { kind: "create" as const, sha: SHA_A },
      { kind: "split" as const, sha: SHA_B, into: ["signals", "signal-ingest"] },
    ];
    expect(Feature.safeParse(makeFeature({ lineage })).success).toBe(false);
  });

  it("rejects split lineage with duplicate targets", () => {
    const lineage = [
      { kind: "create" as const, sha: SHA_A },
      { kind: "split" as const, sha: SHA_B, into: ["signal-ingest", "signal-ingest"] },
    ];
    expect(Feature.safeParse(makeFeature({ lineage })).success).toBe(false);
  });
});
