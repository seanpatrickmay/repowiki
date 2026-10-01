import { describe, expect, it } from "vitest";
import { Manifest } from "./manifest.ts";
import { makeFeature, makeManifest, SHA_A, SHA_B } from "./test-fixtures.ts";

describe("Manifest", () => {
  it("accepts a consistent manifest", () => {
    expect(Manifest.parse(makeManifest())).toEqual(makeManifest());
  });

  it("rejects duplicate feature ids", () => {
    expect(
      Manifest.safeParse(makeManifest({ features: [makeFeature(), makeFeature()], membership: {} }))
        .success,
    ).toBe(false);
  });

  it("rejects membership pointing at an unknown feature", () => {
    const membership = { "src/x.py": { featureId: "ghost", weight: 0.5 } };
    expect(Manifest.safeParse(makeManifest({ membership })).success).toBe(false);
  });

  it("rejects membership pointing at a redirect", () => {
    const features = [
      makeFeature(),
      makeFeature({
        id: "deliverables",
        title: "Deliverables",
        lineage: [
          { kind: "create", sha: SHA_A },
          { kind: "merge", sha: SHA_B, into: "signals" },
        ],
        status: { kind: "redirect", to: "signals" },
      }),
    ];
    expect(Manifest.safeParse(makeManifest({ features })).success).toBe(false);
  });

  it("rejects redirect targets that do not exist", () => {
    const features = [
      makeFeature({
        lineage: [
          { kind: "create", sha: SHA_A },
          { kind: "merge", sha: SHA_B, into: "ghost" },
        ],
        status: { kind: "redirect", to: "ghost" },
      }),
    ];
    const result = Manifest.safeParse(makeManifest({ features, membership: {} }));
    expect(result.error?.issues.some((i) => i.message.includes("unknown target"))).toBe(true);
  });

  it.each([0, -0.1, 1.5])("rejects weight %s", (weight) => {
    const membership = { "src/x.py": { featureId: "signals", weight } };
    expect(Manifest.safeParse(makeManifest({ membership })).success).toBe(false);
  });

  it.each([1, 0.01, 0.5])("accepts weight %s", (weight) => {
    const membership = { "src/x.py": { featureId: "signals", weight } };
    expect(Manifest.safeParse(makeManifest({ membership })).success).toBe(true);
  });

  it("rejects merged feature without matching lineage event", () => {
    const features = [
      makeFeature({ id: "signals" }),
      makeFeature({
        id: "deliverables",
        title: "Deliverables",
        aliases: [],
        lineage: [{ kind: "create", sha: SHA_A }],
        status: { kind: "redirect", to: "signals" },
      }),
    ];
    const result = Manifest.safeParse(makeManifest({ features, membership: {} }));
    expect(result.error?.issues.some((i) => i.message.includes("requires a merge"))).toBe(true);
  });

  it("accepts merged feature with matching lineage", () => {
    const features = [
      makeFeature({
        id: "deliverables",
        lineage: [
          { kind: "create", sha: SHA_A },
          { kind: "merge", sha: SHA_B, into: "signals" },
        ],
        status: { kind: "redirect", to: "signals" },
      }),
      makeFeature({ id: "signals" }),
    ];
    expect(Manifest.safeParse(makeManifest({ features, membership: {} })).success).toBe(true);
  });

  it("rejects split feature without matching lineage event", () => {
    const features = [
      makeFeature({
        lineage: [{ kind: "create", sha: SHA_A }],
        status: { kind: "disambiguation", to: ["signal-ingest", "signal-scoring"] },
      }),
      makeFeature({ id: "signal-ingest", title: "Signal Ingest" }),
      makeFeature({ id: "signal-scoring", title: "Signal Scoring" }),
    ];
    const result = Manifest.safeParse(makeManifest({ features, membership: {} }));
    expect(result.error?.issues.some((i) => i.message.includes("requires a matching split"))).toBe(
      true,
    );
  });

  it("accepts split feature with matching lineage", () => {
    const features = [
      makeFeature({
        lineage: [
          { kind: "create", sha: SHA_A },
          { kind: "split", sha: SHA_B, into: ["signal-ingest", "signal-scoring"] },
        ],
        status: { kind: "disambiguation", to: ["signal-ingest", "signal-scoring"] },
      }),
      makeFeature({ id: "signal-ingest", title: "Signal Ingest" }),
      makeFeature({ id: "signal-scoring", title: "Signal Scoring" }),
    ];
    expect(Manifest.safeParse(makeManifest({ features, membership: {} })).success).toBe(true);
  });

  it("rejects redirect cycles", () => {
    const features = [
      makeFeature({
        id: "a",
        lineage: [
          { kind: "create", sha: SHA_A },
          { kind: "merge", sha: SHA_B, into: "b" },
        ],
        status: { kind: "redirect", to: "b" },
      }),
      makeFeature({
        id: "b",
        lineage: [
          { kind: "create", sha: SHA_A },
          { kind: "merge", sha: SHA_B, into: "a" },
        ],
        status: { kind: "redirect", to: "a" },
      }),
    ];
    expect(Manifest.safeParse(makeManifest({ features, membership: {} })).success).toBe(false);
  });

  it("rejects lineage merge/split targets that do not exist", () => {
    const features = [
      makeFeature({
        lineage: [
          { kind: "create", sha: SHA_A },
          { kind: "merge", sha: SHA_B, into: "ghost" },
        ],
      }),
    ];
    expect(Manifest.safeParse(makeManifest({ features, membership: {} })).success).toBe(false);
  });

  it("rejects split lineage target that does not exist", () => {
    const features = [
      makeFeature({
        lineage: [
          { kind: "create", sha: SHA_A },
          { kind: "split", sha: SHA_B, into: ["signal-ingest", "ghost"] },
        ],
        status: { kind: "disambiguation", to: ["signal-ingest", "ghost"] },
      }),
      makeFeature({ id: "signal-ingest", title: "Signal Ingest" }),
    ];
    const result = Manifest.safeParse(makeManifest({ features, membership: {} }));
    expect(
      result.error?.issues.some(
        (i) => i.message.includes("split target") && i.message.includes("does not exist"),
      ),
    ).toBe(true);
  });

  it.each(["../x.py", "/abs.py", "src\\a.py", "src/a.py#", "#fn"])(
    "rejects invalid member id %j",
    (memberId) => {
      const membership = { [memberId]: { featureId: "signals", weight: 0.5 } };
      expect(Manifest.safeParse(makeManifest({ membership })).success).toBe(false);
    },
  );

  it.each(["src/a.py", "src/a.py#fn"])("accepts valid member id %j", (memberId) => {
    const membership = { [memberId]: { featureId: "signals", weight: 0.5 } };
    expect(Manifest.safeParse(makeManifest({ membership })).success).toBe(true);
  });
});
