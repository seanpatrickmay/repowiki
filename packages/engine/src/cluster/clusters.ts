import { posix } from "node:path";
import type { FileGraph } from "./graph.ts";
import { louvain } from "./louvain.ts";

export interface Cluster {
  /** "c01", "c02", …: largest cluster first, ties broken by first path. */
  id: string;
  /** Sorted repo paths. */
  files: string[];
}

export interface ClusterOptions {
  /** Louvain resolution; higher gives more, smaller clusters. */
  resolution: number;
  /** Clusters with fewer files are absorbed into their best neighbour. */
  minClusterSize: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = { resolution: 3, minClusterSize: 5 };

function sharedPrefixDepth(a: string, b: string): number {
  const x = posix.dirname(a).split("/");
  const y = posix.dirname(b).split("/");
  let depth = 0;
  while (depth < x.length && depth < y.length && x[depth] === y[depth]) depth++;
  return depth;
}

/**
 * Clusters the file graph: Louvain, then small clusters are absorbed into the cluster they share
 * the most edge weight with, or, with no edges, the one sharing the deepest directory prefix.
 * Deterministic: the same graph always yields the same clusters and ids.
 */
export function clusterFiles(
  graph: FileGraph,
  options: ClusterOptions = DEFAULT_CLUSTER_OPTIONS,
): Cluster[] {
  const communityOf = louvain(graph.nodes, graph.edges, options.resolution);
  const groups = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const c = communityOf.get(node) ?? -1;
    groups.set(c, [...(groups.get(c) ?? []), node]);
  }

  const neighbours = new Map<string, Map<string, number>>();
  for (const { a, b, weight } of graph.edges) {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const map = neighbours.get(x) ?? new Map<string, number>();
      map.set(y, (map.get(y) ?? 0) + weight);
      neighbours.set(x, map);
    }
  }

  const bySize = (x: [number, string[]], y: [number, string[]]) =>
    x[1].length - y[1].length || x[0] - y[0];
  for (;;) {
    const small = [...groups]
      .sort(bySize)
      .find(([, files]) => files.length < options.minClusterSize);
    if (small === undefined || groups.size === 1) break;
    const [id, files] = small;
    const weightTo = new Map<number, number>();
    for (const file of files) {
      for (const [other, w] of neighbours.get(file) ?? []) {
        const c = communityOf.get(other) ?? -1;
        if (c !== id) weightTo.set(c, (weightTo.get(c) ?? 0) + w);
      }
    }
    const score = (c: number, members: string[]): [number, number, number] => [
      weightTo.get(c) ?? 0,
      Math.max(...members.flatMap((m) => files.map((f) => sharedPrefixDepth(m, f)))),
      members.length,
    ];
    let target: number | null = null;
    let best: [number, number, number] = [-1, -1, -1];
    for (const [c, members] of [...groups].sort((x, y) => x[0] - y[0])) {
      if (c === id) continue;
      const s = score(c, members);
      if (
        s[0] > best[0] ||
        (s[0] === best[0] && (s[1] > best[1] || (s[1] === best[1] && s[2] > best[2])))
      ) {
        target = c;
        best = s;
      }
    }
    if (target === null) break;
    for (const file of files) communityOf.set(file, target);
    groups.set(target, [...(groups.get(target) ?? []), ...files].sort());
    groups.delete(id);
  }

  const sorted = [...groups.values()]
    .map((files) => [...files].sort())
    .sort((x, y) => y.length - x.length || ((x[0] ?? "") < (y[0] ?? "") ? -1 : 1));
  // Wide enough that ids sort lexically in list order: c01..c99, then c001.. past 99 clusters.
  const width = Math.max(2, String(sorted.length).length);
  return sorted.map((files, i) => ({ id: `c${String(i + 1).padStart(width, "0")}`, files }));
}
