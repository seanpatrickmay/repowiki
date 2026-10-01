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
});
