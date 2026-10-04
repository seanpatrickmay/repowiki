import { describe, expect, it } from "vitest";
import { clusterFiles } from "./clusters.ts";
import { buildFileGraph, type FileGraph } from "./graph.ts";
import { makeIndex } from "./test-index.ts";

const clique = (files: string[]): [string, string][] =>
  files.flatMap((x, i) => files.slice(i + 1).map((y): [string, string] => [x, y]));

/** Two tightly importing groups of four files plus whatever `extra` adds. */
function twoGroups(extra: string[] = [], imports: [string, string][] = []) {
  const api = ["api/a.py", "api/b.py", "api/c.py", "api/d.py"];
  const web = ["web/a.ts", "web/b.ts", "web/c.ts", "web/d.ts"];
  return buildFileGraph(
    makeIndex([...api, ...web, ...extra], {
      imports: [...clique(api), ...clique(web), ...imports],
    }),
  );
}

/** Index-built graph over `paths`, with a clique of imports inside each group and `imports` between. */
function grouped(groups: string[][], paths: string[], imports: [string, string][] = []) {
  return buildFileGraph(
    makeIndex([...groups.flat(), ...paths], { imports: [...groups.flatMap(clique), ...imports] }),
  );
}

/** A graph with exactly the given weighted edges (a < b is applied here), no directory edges. */
function weighted(edges: [string, string, number][]): FileGraph {
  return {
    nodes: [...new Set(edges.flatMap(([a, b]) => [a, b]))].sort(),
    edges: edges
      .map(([x, y, weight]) => ({ a: x < y ? x : y, b: x < y ? y : x, weight }))
      .sort((l, r) => (l.a < r.a ? -1 : l.a > r.a ? 1 : l.b < r.b ? -1 : l.b > r.b ? 1 : 0)),
  };
}

describe("clusterFiles", () => {
  it("finds the groups, largest first, with sorted files and c01-style ids", () => {
    const clusters = clusterFiles(twoGroups(["web/e.ts"], [["web/e.ts", "web/a.ts"]]), {
      resolution: 1,
      minClusterSize: 1,
    });
    expect(clusters).toEqual([
      { id: "c01", files: ["web/a.ts", "web/b.ts", "web/c.ts", "web/d.ts", "web/e.ts"] },
      { id: "c02", files: ["api/a.py", "api/b.py", "api/c.py", "api/d.py"] },
    ]);
  });

  it("absorbs a small cluster into the cluster it shares the most weight with", () => {
    const graph = twoGroups(
      ["tools/x.py", "tools/y.py"],
      [
        ["tools/x.py", "api/a.py"],
        ["tools/x.py", "tools/y.py"],
        ["tools/y.py", "tools/x.py"],
      ],
    );
    const tools = ["tools/x.py", "tools/y.py"];
    const api = ["api/a.py", "api/b.py", "api/c.py", "api/d.py"];
    expect(clusterFiles(graph, { resolution: 1, minClusterSize: 1 })[2]?.files).toEqual(tools);
    expect(clusterFiles(graph, { resolution: 1, minClusterSize: 3 })[0]?.files).toEqual([
      ...api,
      ...tools,
    ]);
  });

  it("absorbs an unconnected small cluster into the cluster with the deepest shared directory", () => {
    const clusters = clusterFiles(twoGroups(["web/assets/logo.svg"]), {
      resolution: 1,
      minClusterSize: 2,
    });
    expect(clusters.find((c) => c.files.includes("web/assets/logo.svg"))?.files).toContain(
      "web/a.ts",
    );
  });

  it("keeps a lone cluster even when it is below the minimum size", () => {
    expect(clusterFiles(buildFileGraph(makeIndex(["README.md"])))).toEqual([
      { id: "c01", files: ["README.md"] },
    ]);
  });

  it("does not depend on the order of the index's edges", () => {
    const index = makeIndex(["a/1.py", "a/2.py", "b/1.py", "b/2.py", "b/3.py"], {
      imports: [
        ["a/1.py", "a/2.py"],
        ["b/1.py", "b/2.py"],
        ["b/2.py", "b/3.py"],
        ["a/2.py", "b/1.py"],
      ],
    });
    const reversed = { ...index, imports: [...index.imports].reverse() };
    const options = { resolution: 1, minClusterSize: 1 };
    expect(clusterFiles(buildFileGraph(reversed), options)).toEqual(
      clusterFiles(buildFileGraph(index), options),
    );
  });

  describe("absorption rules", () => {
    const options = (minClusterSize: number) => ({ resolution: 1, minClusterSize });
    const filesOf = (clusters: { files: string[] }[]) => clusters.map((c) => c.files);

    it("prefers shared edge weight over directory depth, size and community id", () => {
      // The big a/ cluster has the lower id, is larger, and shares the directory with a/sub/,
      // but a/sub/ only has an edge to z/.
      const big = ["a/1.py", "a/2.py", "a/3.py", "a/4.py", "a/5.py"];
      const linked = ["z/1.py", "z/2.py", "z/3.py", "z/4.py"];
      const sub = ["a/sub/s1.py", "a/sub/s2.py"];
      const graph = grouped([big, linked], sub, [
        ["a/sub/s1.py", "a/sub/s2.py"],
        ["a/sub/s2.py", "a/sub/s1.py"],
        ["a/sub/s1.py", "z/1.py"],
      ]);
      expect(filesOf(clusterFiles(graph, options(1)))).toEqual([big, linked, sub]);
      expect(filesOf(clusterFiles(graph, options(3)))).toEqual([[...sub, ...linked], big]);
    });

    it("with no edges, scores a cluster by its best-matching file's directory depth", () => {
      // x/n* shares only "x" with x/y/z/s.py; the z/ cluster holds x/y/z/w/near.py, which shares
      // three levels. N has the lower id and equal size, so only the deepest member can win.
      const near = ["x/n1.py", "x/n2.py", "x/n3.py", "x/n4.py"];
      const deep = ["z/1.py", "z/2.py", "z/3.py", "x/y/z/w/near.py"];
      const graph = grouped([near, deep], ["x/y/z/s.py"]);
      expect(filesOf(clusterFiles(graph, options(1)))).toEqual([
        near,
        ["x/y/z/w/near.py", "z/1.py", "z/2.py", "z/3.py"],
        ["x/y/z/s.py"],
      ]);
      expect(clusterFiles(graph, options(2))[0]?.files).toEqual(["x/y/z/s.py", ...deep].sort());
    });

    it("with equal depth, joins the larger cluster even when it has the higher id", () => {
      const four = ["a/1.py", "a/2.py", "a/3.py", "a/4.py"];
      const six = ["b/1.py", "b/2.py", "b/3.py", "b/4.py", "b/5.py", "b/6.py"];
      const clusters = clusterFiles(grouped([four, six], ["s.py"]), options(2));
      expect(filesOf(clusters)).toEqual([[...six, "s.py"], four]);
    });

    it("with equal depth and size, joins the lower community id", () => {
      const a = ["a/1.py", "a/2.py", "a/3.py", "a/4.py"];
      const b = ["b/1.py", "b/2.py", "b/3.py", "b/4.py"];
      const clusters = clusterFiles(grouped([a, b], ["s.py"]), options(2));
      expect(filesOf(clusters)).toEqual([[...a, "s.py"], b]);
    });

    it("absorbs the smallest cluster first, so a larger small cluster can stay whole", () => {
      // pair (2 files) is below 4 and links only to trio (3 files); trio links to big more
      // strongly than to pair. Smallest first: pair joins trio and the result is big enough to
      // stand. Largest first: trio would join big, and pair would follow it.
      const big = ["b/1.py", "b/2.py", "b/3.py", "b/4.py", "b/5.py"];
      const trio = ["c/1.py", "c/2.py", "c/3.py"];
      const pair = ["d/1.py", "d/2.py"];
      const graph = weighted([
        ...clique(big).map(([a, b]): [string, string, number] => [a, b, 10]),
        ...clique(trio).map(([a, b]): [string, string, number] => [a, b, 10]),
        ["d/1.py", "d/2.py", 10],
        ["d/1.py", "c/1.py", 1],
        ["c/1.py", "b/1.py", 2],
      ]);
      expect(filesOf(clusterFiles(graph, options(1)))).toEqual([big, trio, pair]);
      expect(filesOf(clusterFiles(graph, options(4)))).toEqual([big, [...trio, ...pair]]);
    });

    it("breaks ties between equally small clusters by lower community id", () => {
      // p and q are both pairs. p links to big (2) and to q (1); q links only to p. Taking p
      // first sends p to big and then q follows into big. Taking q first would pair q with p.
      const big = ["b/1.py", "b/2.py", "b/3.py", "b/4.py", "b/5.py"];
      const graph = weighted([
        ...clique(big).map(([a, b]): [string, string, number] => [a, b, 10]),
        ["p/1.py", "p/2.py", 10],
        ["q/1.py", "q/2.py", 10],
        ["p/1.py", "b/1.py", 2],
        ["p/2.py", "q/1.py", 1],
      ]);
      expect(filesOf(clusterFiles(graph, options(1)))).toEqual([
        big,
        ["p/1.py", "p/2.py"],
        ["q/1.py", "q/2.py"],
      ]);
      expect(filesOf(clusterFiles(graph, options(3)))).toEqual([
        [...big, "p/1.py", "p/2.py", "q/1.py", "q/2.py"],
      ]);
    });

    it("scores directory depth over every file of the small cluster, not just its first", () => {
      // The pair's first file (a/x.py) shares a level with the a/ cluster; its second file
      // (z/deep/y.py) shares two levels with the z/deep/ cluster, which must win.
      const near = ["z/deep/q1.py", "z/deep/q2.py", "z/deep/q3.py", "z/deep/q4.py"];
      const far = ["a/b1.py", "a/b2.py", "a/b3.py", "a/b4.py", "a/b5.py"];
      const pair = ["a/x.py", "z/deep/y.py"];
      const graph = weighted([
        ...clique(near).map(([a, b]): [string, string, number] => [a, b, 10]),
        ...clique(far).map(([a, b]): [string, string, number] => [a, b, 10]),
        [pair[0] ?? "", pair[1] ?? "", 10],
      ]);
      expect(filesOf(clusterFiles(graph, options(1)))).toEqual([far, near, pair]);
      expect(filesOf(clusterFiles(graph, options(3)))).toEqual([
        [...pair.slice(0, 1), ...near, ...pair.slice(1)],
        far,
      ]);
    });

    it("collapses everything into one cluster when every cluster is small", () => {
      const graph = weighted([
        ["a/1.py", "a/2.py", 10],
        ["b/1.py", "b/2.py", 10],
        ["c/1.py", "c/2.py", 10],
      ]);
      expect(filesOf(clusterFiles(graph, options(1)))).toHaveLength(3);
      expect(filesOf(clusterFiles(graph, options(5)))).toEqual([
        ["a/1.py", "a/2.py", "b/1.py", "b/2.py", "c/1.py", "c/2.py"],
      ]);
    });
  });

  it("widens ids so they sort lexically with more than 99 clusters", () => {
    const groups = Array.from({ length: 120 }, (_, i) =>
      Array.from({ length: 5 }, (_, j) => `m${String(i).padStart(3, "0")}/f${j}.py`),
    );
    const graph = weighted(
      groups.flatMap((g) => clique(g).map(([a, b]): [string, string, number] => [a, b, 1])),
    );
    const ids = clusterFiles(graph, { resolution: 1, minClusterSize: 5 }).map((c) => c.id);
    expect(ids).toHaveLength(120);
    expect(ids[0]).toBe("c001");
    expect(ids[119]).toBe("c120");
    expect(ids).toEqual([...ids].sort());
  });
});
