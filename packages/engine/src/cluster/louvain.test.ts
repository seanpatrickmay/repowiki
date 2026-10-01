import { describe, expect, it } from "vitest";
import type { WeightedEdge } from "./graph.ts";
import { louvain } from "./louvain.ts";

const edge = (a: string, b: string, weight = 1): WeightedEdge => ({ a, b, weight });

/** Two triangles joined by one weak edge. */
const NODES = ["a1", "a2", "a3", "b1", "b2", "b3"];
const EDGES = [
  edge("a1", "a2"),
  edge("a1", "a3"),
  edge("a2", "a3"),
  edge("b1", "b2"),
  edge("b1", "b3"),
  edge("b2", "b3"),
  edge("a3", "b1", 0.1),
];

/** `cliques` complete graphs of `size` nodes; clique k's last node links to clique k+1's first. */
function ringOfCliques(cliques: number, size: number) {
  const id = (c: number, i: number) => `c${String(c).padStart(2, "0")}n${i}`;
  const nodes: string[] = [];
  const edges: WeightedEdge[] = [];
  for (let c = 0; c < cliques; c++) {
    for (let i = 0; i < size; i++) nodes.push(id(c, i));
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) edges.push(edge(id(c, i), id(c, j)));
    }
    const from = id(c, size - 1);
    const to = id((c + 1) % cliques, 0);
    edges.push(from < to ? edge(from, to) : edge(to, from));
  }
  return { nodes, edges, id };
}

/** Newman modularity at resolution 1: sum over communities of in/2m - (tot/2m)^2. */
function modularity(edges: readonly WeightedEdge[], partition: Map<string, number>): number {
  let twoM = 0;
  const inside = new Map<number, number>();
  const total = new Map<number, number>();
  for (const { a, b, weight } of edges) {
    const ca = partition.get(a) ?? -1;
    const cb = partition.get(b) ?? -1;
    twoM += 2 * weight;
    total.set(ca, (total.get(ca) ?? 0) + weight);
    total.set(cb, (total.get(cb) ?? 0) + weight);
    if (ca === cb) inside.set(ca, (inside.get(ca) ?? 0) + 2 * weight);
  }
  let q = 0;
  for (const [c, t] of total) q += (inside.get(c) ?? 0) / twoM - (t / twoM) ** 2;
  return q;
}

/** Deterministic PRNG in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each community as the sorted, comma-joined input indices of its nodes, ordered by first node. */
function groupsOf(nodes: readonly string[], partition: Map<string, number>): string[] {
  const groups = new Map<number, number[]>();
  nodes.forEach((node, i) => {
    const c = partition.get(node) ?? -1;
    groups.set(c, [...(groups.get(c) ?? []), i]);
  });
  return [...groups.values()].sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0)).map((g) => g.join(","));
}

describe("louvain", () => {
  it("separates two dense groups joined by a weak edge", () => {
    expect(Object.fromEntries(louvain(NODES, EDGES))).toEqual({
      a1: 0,
      a2: 0,
      a3: 0,
      b1: 1,
      b2: 1,
      b3: 1,
    });
  });

  it("gives the same answer whatever order the edges come in", () => {
    const reversed = [...EDGES].reverse();
    const rotated = [...EDGES.slice(3), ...EDGES.slice(0, 3)];
    expect(louvain(NODES, reversed)).toEqual(louvain(NODES, EDGES));
    expect(louvain(NODES, rotated)).toEqual(louvain(NODES, EDGES));
  });

  it("merges a chain of groups at low resolution and splits it at high resolution", () => {
    const nodes = ["p", "q", "r", "s"];
    const edges = [edge("p", "q"), edge("q", "r", 0.5), edge("r", "s")];
    expect(new Set(louvain(nodes, edges, 0.1).values()).size).toBe(1);
    expect(new Set(louvain(nodes, edges, 1).values()).size).toBe(2);
  });

  it("leaves isolated nodes alone and handles a graph with no edges", () => {
    expect(Object.fromEntries(louvain(["x", "y", "z"], [edge("x", "y")]))).toEqual({
      x: 0,
      y: 0,
      z: 1,
    });
    expect(Object.fromEntries(louvain(["x", "y"], []))).toEqual({ x: 0, y: 1 });
  });

  it("rejects an edge endpoint that is not in nodes", () => {
    expect(() => louvain(["x", "y"], [edge("x", "ghost")])).toThrow(/ghost/);
    expect(() => louvain(["x", "y"], [edge("ghost", "y")])).toThrow(/ghost/);
  });

  it("rejects a duplicate node id", () => {
    expect(() => louvain(["x", "y", "x"], [edge("x", "y")])).toThrow(/duplicate.*"x"/);
  });

  it("rejects negative and non-finite weights but allows zero", () => {
    expect(() => louvain(["x", "y"], [edge("x", "y", -1)])).toThrow(/x.*y.*-1/);
    expect(() => louvain(["x", "y"], [edge("x", "y", Number.NaN)])).toThrow(/x.*y.*NaN/);
    expect(() => louvain(["x", "y"], [edge("x", "y", Number.POSITIVE_INFINITY)])).toThrow(
      /x.*y.*Infinity/,
    );
    expect(Object.fromEntries(louvain(["x", "y"], [edge("x", "y", 0)]))).toEqual({ x: 0, y: 1 });
  });

  it("keeps each K4 of a ring of 8 as its own community", () => {
    const { nodes, edges, id } = ringOfCliques(8, 4);
    const result = louvain(nodes, edges);
    expect(new Set(result.values()).size).toBe(8);
    for (let c = 0; c < 8; c++) {
      for (let i = 0; i < 4; i++) expect(result.get(id(c, i))).toBe(c);
    }
  });

  it("pairs neighbouring K5s of a ring of 30 and numbers the pairs by first node", () => {
    const { nodes, edges, id } = ringOfCliques(30, 5);
    const result = louvain(nodes, edges);
    expect(new Set(result.values()).size).toBe(15);
    for (let c = 0; c < 30; c++) {
      for (let i = 0; i < 5; i++) expect(result.get(id(c, i))).toBe(Math.floor(c / 2));
    }
    expect(result.get(id(0, 0))).toBe(0);
    expect(Math.max(...result.values())).toBe(14);
  });

  it("finds the planted groups of a seeded random graph", () => {
    const rand = mulberry32(20261001);
    const nodes = Array.from({ length: 100 }, (_, i) => `n${String(i).padStart(3, "0")}`);
    const edges: WeightedEdge[] = [];
    for (let i = 0; i < 100; i++) {
      for (let j = i + 1; j < 100; j++) {
        if (rand() < (i % 5 === j % 5 ? 0.3 : 0.02))
          edges.push(edge(nodes[i] ?? "", nodes[j] ?? ""));
      }
    }
    const result = louvain(nodes, edges);
    expect(edges).toHaveLength(383);
    expect(groupsOf(nodes, result)).toEqual([
      "0,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95",
      "1,6,11,16,21,26,31,36,41,46,51,56,61,76,81,86,91,96",
      "2,7,12,17,22,27,32,37,42,47,52,57,62,67,72,77,82,87,92,97",
      "3,8,13,18,23,28,33,38,43,48,53,58,63,66,68,73,78,83,88,93,98",
      "4,9,14,19,24,29,34,39,44,49,54,59,64,69,74,79,84,89,94,99",
      "71",
    ]);
    const q = modularity(edges, result);
    const singletons = modularity(edges, new Map(nodes.map((node, i) => [node, i])));
    expect(q).toBeGreaterThanOrEqual(singletons);
    expect(q).toBeCloseTo(0.5802173305428492, 9);
  });

  it("keeps a node in its current community when another community ties", () => {
    // c sits with a. Joining b would gain exactly as much (1 - 1.5 * 1 * 2 / 4), and b's id is lower.
    const result = louvain(["a", "b", "c"], [edge("a", "c"), edge("b", "c")], 1.5);
    expect(Object.fromEntries(result)).toEqual({ a: 0, b: 1, c: 0 });
  });

  it("counts a cross-community edge once when it aggregates communities", () => {
    // {a, d} and {b, c} form first. Their single weight-1 link must not pull them together at
    // resolution 0.5: the gain is 1 - 0.5 * 5 * 5 / 10 < 0.
    const edges = [edge("a", "d", 2), edge("b", "c", 2), edge("b", "d")];
    const result = louvain(["a", "b", "c", "d"], edges, 0.5);
    expect(Object.fromEntries(result)).toEqual({ a: 0, b: 1, c: 1, d: 0 });
  });
});
