import { posix } from "node:path";
import type { RepoIndex } from "../index/index.ts";

/** An undirected weighted edge between two repo files, with a < b. */
export interface WeightedEdge {
  a: string;
  b: string;
  weight: number;
}

/** Every indexed file, sorted, and the combined import / co-change / directory edges between them. */
export interface FileGraph {
  nodes: string[];
  edges: WeightedEdge[];
}

export interface GraphWeights {
  /** Weight of one resolved import between two files (mutual imports count twice). */
  import: number;
  /** Multiplier on the Jaccard similarity of two files' commit sets. */
  coChange: number;
  /** Total weight a file shares with its directory siblings (the weak signal). */
  directory: number;
  /** Co-changed pairs seen in fewer commits than this are ignored as noise. */
  minCoChangeCount: number;
  /**
   * Imports into a file that more than this many files import are scaled down by
   * hubInDegree / inDegree, so barrels (index.ts) and shared test fixtures stop pulling unrelated
   * files together; such hubs then cluster by directory and co-change.
   */
  hubInDegree: number;
}

export const DEFAULT_GRAPH_WEIGHTS: GraphWeights = {
  import: 1,
  coChange: 2,
  directory: 0.3,
  minCoChangeCount: 2,
  hubInDegree: 4,
};

const pairKey = (x: string, y: string): string => (x < y ? `${x}\0${y}` : `${y}\0${x}`);

/** Builds the file graph clustering runs on. Non-code files join through co-change and directory only. */
export function buildFileGraph(
  index: RepoIndex,
  weights: GraphWeights = DEFAULT_GRAPH_WEIGHTS,
): FileGraph {
  const nodes = index.files.map((file) => file.path).sort();
  const known = new Set(nodes);
  const sums = new Map<string, number>();
  const add = (x: string, y: string, weight: number): void => {
    if (x === y || weight <= 0 || !known.has(x) || !known.has(y)) return;
    const key = pairKey(x, y);
    sums.set(key, (sums.get(key) ?? 0) + weight);
  };

  const inDegree = new Map<string, number>();
  for (const { to } of index.imports) inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  for (const { from, to } of index.imports) {
    const hub = Math.min(1, weights.hubInDegree / (inDegree.get(to) ?? 1));
    add(from, to, weights.import * hub);
  }

  const { fileCommits, pairs } = index.coChange;
  for (const { a, b, count } of pairs) {
    if (count < weights.minCoChangeCount) continue;
    const union = (fileCommits[a] ?? 0) + (fileCommits[b] ?? 0) - count;
    if (union > 0) add(a, b, (weights.coChange * count) / union);
  }

  const byDir = new Map<string, string[]>();
  for (const path of nodes) {
    const dir = posix.dirname(path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
  }
  for (const siblings of byDir.values()) {
    const share = weights.directory / (siblings.length - 1);
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++)
        add(siblings[i] ?? "", siblings[j] ?? "", share);
    }
  }

  const edges = [...sums]
    .map(([key, weight]) => {
      const [a = "", b = ""] = key.split("\0");
      return { a, b, weight };
    })
    .sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return { nodes, edges };
}
