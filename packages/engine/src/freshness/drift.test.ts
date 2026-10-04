import { makeFeature, makeManifest } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { DEFAULT_DRIFT_THRESHOLD, driftedFeatures, featureChurn } from "./drift.ts";

const baseline = makeManifest({
  membership: {
    "src/signals/ingest.py": { featureId: "signals", weight: 1 },
    "src/signals/store.py": { featureId: "signals", weight: 1 },
    "src/signals/queue.py": { featureId: "signals", weight: 2 },
    "src/deliverables/crud.py": { featureId: "deliverables", weight: 0.5 },
  },
});

describe("featureChurn", () => {
  it("is weight gained plus weight lost over the baseline weight, per feature", () => {
    const now = {
      "src/signals/ingest.py": { featureId: "signals", weight: 1 },
      // store.py deleted, queue.py moved to deliverables, a new file joined signals.
      "src/signals/queue.py": { featureId: "deliverables", weight: 2 },
      "src/signals/new.py": { featureId: "signals", weight: 0.5 },
      "src/deliverables/crud.py": { featureId: "deliverables", weight: 0.5 },
    };
    expect(featureChurn(baseline, now)).toEqual(
      new Map([
        ["signals", (1 + 2 + 0.5) / 4],
        ["deliverables", 2 / 0.5],
      ]),
    );
  });

  it("is zero for an unchanged membership and Infinity for a feature with no baseline weight", () => {
    expect([...featureChurn(baseline, baseline.membership).values()]).toEqual([0, 0]);
    const created = { ...baseline.membership, "x.py": { featureId: "billing", weight: 0.2 } };
    expect(featureChurn(baseline, created).get("billing")).toBe(Number.POSITIVE_INFINITY);
  });

  it("counts a member added and later removed again as nothing", () => {
    expect(
      [...featureChurn(baseline, { ...baseline.membership }).values()].every((c) => c === 0),
    ).toBe(true);
  });
});

describe("driftedFeatures", () => {
  it("lists the active features over the threshold, sorted", () => {
    const manifest = makeManifest({
      features: [
        makeFeature(),
        makeFeature({ id: "deliverables", title: "Deliverables", aliases: [] }),
        makeFeature({
          id: "gone",
          title: "Gone",
          aliases: [],
          status: { kind: "retired" },
          lineage: [
            { kind: "create", sha: "a".repeat(40) },
            { kind: "retire", sha: "a".repeat(40) },
          ],
        }),
      ],
    });
    const churn = new Map([
      ["signals", 0.21],
      ["deliverables", 0.2],
      ["gone", 5],
    ]);
    expect(driftedFeatures(manifest, churn, DEFAULT_DRIFT_THRESHOLD)).toEqual(["signals"]);
  });
});
