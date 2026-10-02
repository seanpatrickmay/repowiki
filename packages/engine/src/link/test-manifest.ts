import type { Manifest } from "@repowiki/core";
import { makeFeature, makeManifest, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";

/**
 * signals (active), deliverables (active), legacy-signals (merged into signals), retired-thing
 * (retired), billing (active). Files: two per active feature. Test-only.
 */
export function linkManifest(): Manifest {
  const create = { kind: "create" as const, sha: SHA_A };
  return makeManifest({
    features: [
      makeFeature(),
      makeFeature({ id: "deliverables", title: "Deliverables", aliases: ["deliverable records"] }),
      makeFeature({ id: "billing", title: "Billing", aliases: ["invoices"] }),
      makeFeature({
        id: "legacy-signals",
        title: "Legacy signals",
        aliases: [],
        status: { kind: "redirect", to: "signals" },
        lineage: [create, { kind: "merge", sha: SHA_B, into: "signals" }],
      }),
      makeFeature({
        id: "retired-thing",
        title: "Retired thing",
        aliases: [],
        status: { kind: "retired" },
        lineage: [create, { kind: "retire", sha: SHA_B }],
      }),
    ],
    membership: {
      "src/signals/ingest.py": { featureId: "signals", weight: 1 },
      "src/signals/score.py": { featureId: "signals", weight: 0.8 },
      "src/deliverables/crud.py": { featureId: "deliverables", weight: 1 },
      "src/deliverables/api.py": { featureId: "deliverables", weight: 0.5 },
      "src/billing/invoice.py": { featureId: "billing", weight: 1 },
    },
  });
}
