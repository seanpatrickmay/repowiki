import type { WeightedEdge } from "./graph.ts";

interface Level {
  /** adjacency[i]: neighbour index → summed edge weight (self-loops included). */
  adjacency: Map<number, number>[];
  /** Weighted degree of each node; a self-loop counts twice. */
  degree: number[];
}

function buildLevel(size: number, edges: Iterable<[number, number, number]>): Level {
  const adjacency = Array.from({ length: size }, () => new Map<number, number>());
  const degree = new Array<number>(size).fill(0);
  for (const [i, j, w] of edges) {
    adjacency[i]?.set(j, (adjacency[i]?.get(j) ?? 0) + w);
    if (i !== j) adjacency[j]?.set(i, (adjacency[j]?.get(i) ?? 0) + w);
    degree[i] = (degree[i] ?? 0) + w;
    degree[j] = (degree[j] ?? 0) + w;
  }
  return { adjacency, degree };
}

/**
 * One round of local moving: each node, in index order, joins the neighbouring community with the
 * largest modularity gain. Ties keep the current community, then prefer the lowest community id,
 * so the result depends only on the input. Returns community ids renumbered 0..k-1 by first node.
 */
function localMoving(level: Level, totalWeight: number, resolution: number): number[] | null {
  const n = level.degree.length;
  const community = Array.from({ length: n }, (_, i) => i);
  const tot = [...level.degree];
  let movedAny = false;
  for (let moved = true; moved; ) {
    moved = false;
    for (let i = 0; i < n; i++) {
      const ki = level.degree[i] ?? 0;
      const current = community[i] ?? i;
      const links = new Map<number, number>();
      for (const [j, w] of level.adjacency[i] ?? []) {
        if (j === i) continue;
        const c = community[j] ?? j;
        links.set(c, (links.get(c) ?? 0) + w);
      }
      tot[current] = (tot[current] ?? 0) - ki;
      const gain = (c: number): number =>
        (links.get(c) ?? 0) - (resolution * (tot[c] ?? 0) * ki) / totalWeight;
      let best = current;
      let bestGain = gain(current);
      for (const c of [...links.keys()].sort((x, y) => x - y)) {
        const g = gain(c);
        if (g > bestGain + 1e-12) {
          best = c;
          bestGain = g;
        }
      }
      tot[best] = (tot[best] ?? 0) + ki;
      if (best !== current) {
        community[i] = best;
        moved = true;
        movedAny = true;
      }
    }
  }
  if (!movedAny) return null;
  const renumber = new Map<number, number>();
  return community.map((c) => {
    if (!renumber.has(c)) renumber.set(c, renumber.size);
    return renumber.get(c) ?? 0;
  });
}

/** Rejects input the algorithm would silently mis-handle: duplicate ids, unknown endpoints, bad weights. */
function validate(nodes: readonly string[], edges: readonly WeightedEdge[]): void {
  const known = new Set<string>();
  for (const node of nodes) {
    if (known.has(node)) throw new Error(`louvain: duplicate node id "${node}"`);
    known.add(node);
  }
  for (const { a, b, weight } of edges) {
    for (const end of [a, b]) {
      if (!known.has(end)) {
        throw new Error(`louvain: edge "${a}" - "${b}" names "${end}", which is not in nodes`);
      }
    }
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`louvain: edge "${a}" - "${b}" has invalid weight ${weight}`);
    }
  }
}

/**
 * Louvain community detection (Blondel et al. 2008) on an undirected weighted graph. Deterministic:
 * nodes are visited in the given order and no randomness is used. Returns each node's community,
 * numbered 0..k-1 in order of each community's first node.
 */
export function louvain(
  nodes: readonly string[],
  edges: readonly WeightedEdge[],
  resolution = 1,
): Map<string, number> {
  validate(nodes, edges);
  const indexOf = new Map(nodes.map((node, i) => [node, i]));
  let level = buildLevel(
    nodes.length,
    edges.map((e): [number, number, number] => [
      indexOf.get(e.a) ?? -1,
      indexOf.get(e.b) ?? -1,
      e.weight,
    ]),
  );
  const totalWeight = level.degree.reduce((sum, d) => sum + d, 0);
  let membership = nodes.map((_, i) => i);
  if (totalWeight === 0) return new Map(nodes.map((node, i) => [node, i]));

  for (;;) {
    const communities = localMoving(level, totalWeight, resolution);
    if (communities === null) break;
    membership = membership.map((c) => communities[c] ?? c);
    const size = Math.max(...communities) + 1;
    const merged = new Map<string, [number, number, number]>();
    level.adjacency.forEach((neighbours, i) => {
      for (const [j, w] of neighbours) {
        if (j < i) continue;
        const ci = communities[i] ?? 0;
        const cj = communities[j] ?? 0;
        const [x, y] = ci <= cj ? [ci, cj] : [cj, ci];
        const key = `${x},${y}`;
        const entry = merged.get(key);
        if (entry) entry[2] += w;
        else merged.set(key, [x, y, w]);
      }
    });
    level = buildLevel(size, merged.values());
  }
  return new Map(nodes.map((node, i) => [node, membership[i] ?? i]));
}
