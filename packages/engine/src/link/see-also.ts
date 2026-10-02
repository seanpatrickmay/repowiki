import { type Manifest, memberId } from "@repowiki/core";
import type { FileGraph } from "../cluster/index.ts";

/** Combined edge weight between every pair of features, from the file graph and membership. */
export function featureNeighbours(
  graph: FileGraph,
  manifest: Manifest,
): Map<string, Map<string, number>> {
  const featureOf = (path: string) => manifest.membership[memberId(path)]?.featureId;
  const neighbours = new Map<string, Map<string, number>>();
  const add = (from: string, to: string, weight: number) => {
    const row = neighbours.get(from) ?? new Map<string, number>();
    row.set(to, (row.get(to) ?? 0) + weight);
    neighbours.set(from, row);
  };
  for (const { a, b, weight } of graph.edges) {
    const x = featureOf(a);
    const y = featureOf(b);
    if (x === undefined || y === undefined || x === y) continue;
    add(x, y, weight);
    add(y, x, weight);
  }
  return neighbours;
}

/** How many features "See also" lists (spec §7.3). */
export const SEE_ALSO_LIMIT = 5;

/**
 * A page's "See also": its top neighbours by combined edge weight, heaviest first (ties by id).
 * Only active features of the manifest qualify, never the page itself, so the list can never
 * name an id that has no page (spec §8).
 */
export function seeAlsoFor(
  featureId: string,
  neighbours: ReadonlyMap<string, ReadonlyMap<string, number>>,
  manifest: Manifest,
  limit = SEE_ALSO_LIMIT,
): string[] {
  const active = new Set(
    manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id),
  );
  return [...(neighbours.get(featureId) ?? new Map<string, number>())]
    .filter(([id]) => id !== featureId && active.has(id))
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit)
    .map(([id]) => id);
}
