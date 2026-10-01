import { describe, expect, it } from "vitest";
import { FEATURE_ID_MAX_LENGTH, Feature, FeatureId } from "./feature.ts";
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

  it("accepts an id of exactly FEATURE_ID_MAX_LENGTH characters", () => {
    expect(FEATURE_ID_MAX_LENGTH).toBe(64);
    expect(FeatureId.safeParse(`a-${"b".repeat(62)}`).success).toBe(true);
  });

  it("rejects an id one character longer, with a message naming the limit", () => {
    const result = FeatureId.safeParse(`a-${"b".repeat(63)}`);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("feature ids are at most 64 characters");
  });
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
    const lineage = [
      { kind: "create" as const, sha: SHA_A },
      { kind: "merge" as const, sha: SHA_B, into: "signals" },
    ];
    const result = Feature.safeParse(
      makeFeature({ lineage, status: { kind: "redirect", to: "signals" } }),
    );
    expect(result.error?.issues.some((i) => i.message.includes("cannot redirect to itself"))).toBe(
      true,
    );
  });

  it("requires a disambiguation to list at least two targets", () => {
    const status = { kind: "disambiguation" as const, to: ["signal-ingest"] };
    const result = Feature.safeParse(makeFeature({ status }));
    // Only the min(2) rule on status.to fires; cannot match with a split lineage
    expect(result.error?.issues.some((i) => i.path?.includes("to"))).toBe(true);
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
    const lineage = [
      { kind: "create" as const, sha: SHA_A },
      { kind: "split" as const, sha: SHA_B, into: ["signals", "signal-ingest"] },
    ];
    const status = { kind: "disambiguation" as const, to: ["signals", "signal-ingest"] };
    const result = Feature.safeParse(makeFeature({ lineage, status }));
    expect(
      result.error?.issues.some((i) => i.message.includes("disambiguation cannot include self")),
    ).toBe(true);
  });

  it("rejects disambiguation with duplicate targets", () => {
    const lineage = [
      { kind: "create" as const, sha: SHA_A },
      { kind: "split" as const, sha: SHA_B, into: ["signal-ingest", "signal-ingest"] },
    ];
    const status = { kind: "disambiguation" as const, to: ["signal-ingest", "signal-ingest"] };
    const result = Feature.safeParse(makeFeature({ lineage, status }));
    expect(
      result.error?.issues.some((i) => i.message.includes("disambiguation targets must be unique")),
    ).toBe(true);
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

  it("rejects redirect without matching merge lineage", () => {
    const status = { kind: "redirect" as const, to: "deliverables" };
    const result = Feature.safeParse(makeFeature({ status }));
    expect(result.error?.issues.some((i) => i.message.includes("requires a merge"))).toBe(true);
  });

  it("rejects disambiguation without matching split lineage", () => {
    const status = { kind: "disambiguation" as const, to: ["signal-ingest", "signal-scoring"] };
    const result = Feature.safeParse(makeFeature({ status }));
    expect(result.error?.issues.some((i) => i.message.includes("requires a matching split"))).toBe(
      true,
    );
  });
});
