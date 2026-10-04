import type { Manifest, Membership } from "@repowiki/core";

/** A feature drifts when its churn passes this share of its baseline weight (spec §6.1 step 4). */
export const DEFAULT_DRIFT_THRESHOLD = 0.2;

/**
 * Each feature's membership churn since the drift baseline (spec §6.1 step 4): the weight of the
 * members it gained plus the weight of those it lost (a member that changed feature counts for
 * both), over its weight at the baseline. Measured against the baseline itself, so a member added
 * and later removed again counts for nothing, and the figure is the same however many updates the
 * churn took. A feature with no weight at the baseline that gained any is Infinity.
 */
export function featureChurn(
  baseline: Manifest,
  membership: Readonly<Record<string, Membership>>,
): Map<string, number> {
  const base = new Map<string, number>();
  const moved = new Map<string, number>();
  const add = (map: Map<string, number>, id: string, weight: number) =>
    map.set(id, (map.get(id) ?? 0) + weight);
  for (const { featureId, weight } of Object.values(baseline.membership))
    add(base, featureId, weight);
  for (const [member, then] of Object.entries(baseline.membership)) {
    const now = membership[member];
    if (now?.featureId === then.featureId)
      add(moved, then.featureId, Math.abs(now.weight - then.weight));
    else {
      add(moved, then.featureId, then.weight);
      if (now !== undefined) add(moved, now.featureId, now.weight);
    }
  }
  for (const [member, now] of Object.entries(membership)) {
    if (baseline.membership[member] === undefined) add(moved, now.featureId, now.weight);
  }
  const churn = new Map<string, number>();
  for (const [id, weight] of moved) {
    const at = base.get(id) ?? 0;
    churn.set(id, at === 0 ? (weight > 0 ? Number.POSITIVE_INFINITY : 0) : weight / at);
  }
  return churn;
}

/** The active features of `manifest` whose churn is over `threshold`, sorted. */
export function driftedFeatures(
  manifest: Manifest,
  churn: ReadonlyMap<string, number>,
  threshold: number,
): string[] {
  return manifest.features
    .filter((f) => f.status.kind === "active" && (churn.get(f.id) ?? 0) > threshold)
    .map((f) => f.id)
    .sort();
}
