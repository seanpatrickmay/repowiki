import { describe, expect, it } from "vitest";
import { buildFileGraph } from "./graph.ts";
import { makeIndex } from "./test-index.ts";

const weightOf = (graph: ReturnType<typeof buildFileGraph>, a: string, b: string) =>
  graph.edges.find((e) => e.a === a && e.b === b)?.weight;

describe("buildFileGraph", () => {
  it("has a node for every file, code or not, sorted", () => {
    const graph = buildFileGraph(makeIndex(["web/app.ts", "README.md", "api/main.py"]));
    expect(graph.nodes).toEqual(["README.md", "api/main.py", "web/app.ts"]);
  });

  it("weighs an import 1 and a mutual import 2", () => {
    const index = makeIndex(["a/x.py", "b/y.py", "c/z.py"], {
      imports: [
        ["a/x.py", "b/y.py"],
        ["b/y.py", "a/x.py"],
        ["c/z.py", "a/x.py"],
      ],
    });
    const graph = buildFileGraph(index);
    expect(weightOf(graph, "a/x.py", "b/y.py")).toBe(2);
    expect(weightOf(graph, "a/x.py", "c/z.py")).toBe(1);
  });

  it("scales down imports into a hub that more than four files import", () => {
    const importers = ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => `app/${name}.py`);
    const index = makeIndex([...importers, "lib/__init__.py"], {
      imports: importers.map((from): [string, string] => [from, "lib/__init__.py"]),
    });
    // 8 importers: each import weighs 4 / 8 = 0.5.
    expect(weightOf(buildFileGraph(index), "app/a.py", "lib/__init__.py")).toBe(0.5);
  });

  it("weighs co-change as twice the Jaccard similarity of the commit sets", () => {
    const index = makeIndex(["a/x.py", "b/y.tf"], { coChange: [["a/x.py", "b/y.tf", 2]] });
    index.coChange.fileCommits = { "a/x.py": 4, "b/y.tf": 3 };
    // |x ∩ y| = 2, |x ∪ y| = 4 + 3 - 2 = 5, so 2 * 2 / 5. Dividing by either file's own commit
    // count (4 or 3) or by the larger one would give 1 or 1.33 instead.
    expect(weightOf(buildFileGraph(index), "a/x.py", "b/y.tf")).toBeCloseTo(0.8);
  });

  it("keeps a pair seen in exactly minCoChangeCount commits and drops one seen once", () => {
    const index = makeIndex(["a/x.py", "b/y.tf", "c/z.md"], {
      coChange: [
        ["a/x.py", "b/y.tf", 2],
        ["a/x.py", "c/z.md", 1],
      ],
    });
    index.coChange.fileCommits = { "a/x.py": 4, "b/y.tf": 3, "c/z.md": 1 };
    const graph = buildFileGraph(index);
    expect(weightOf(graph, "a/x.py", "b/y.tf")).toBeCloseTo(0.8);
    expect(weightOf(graph, "a/x.py", "c/z.md")).toBeUndefined();
    expect(graph.edges).toHaveLength(1);
  });

  it("links directory siblings weakly, sharing 0.3 per file", () => {
    const graph = buildFileGraph(makeIndex(["d/a.md", "d/b.md", "d/c.md", "e/only.md"]));
    expect(graph.edges).toEqual([
      { a: "d/a.md", b: "d/b.md", weight: 0.15 },
      { a: "d/a.md", b: "d/c.md", weight: 0.15 },
      { a: "d/b.md", b: "d/c.md", weight: 0.15 },
    ]);
  });

  it("sums the signals for one pair and ignores edges to unknown files", () => {
    const index = makeIndex(["d/a.py", "d/b.py"], {
      imports: [
        ["d/a.py", "d/b.py"],
        ["d/a.py", "gone.py"],
      ],
    });
    expect(buildFileGraph(index).edges).toEqual([{ a: "d/a.py", b: "d/b.py", weight: 1.3 }]);
  });

  it("gives a file that imports itself no edge", () => {
    const graph = buildFileGraph(makeIndex(["a/x.py"], { imports: [["a/x.py", "a/x.py"]] }));
    expect(graph.edges).toEqual([]);
  });

  it("sorts edges by (a, b) with a < b whatever order the signals arrive in", () => {
    // Insertion order is (m, z), (a, z), (a, m); the edges must come back (a, m), (a, z), (m, z).
    const index = makeIndex(["z/a.py", "a/b.py", "m/c.py"], {
      imports: [
        ["z/a.py", "m/c.py"],
        ["z/a.py", "a/b.py"],
        ["m/c.py", "a/b.py"],
      ],
    });
    expect(buildFileGraph(index).edges).toEqual([
      { a: "a/b.py", b: "m/c.py", weight: 1 },
      { a: "a/b.py", b: "z/a.py", weight: 1 },
      { a: "m/c.py", b: "z/a.py", weight: 1 },
    ]);
  });

  it("sums import, co-change and directory weight on one pair", () => {
    const index = makeIndex(["d/a.py", "d/b.py"], {
      imports: [["d/a.py", "d/b.py"]],
      coChange: [["d/a.py", "d/b.py", 3]],
    });
    index.coChange.fileCommits = { "d/a.py": 4, "d/b.py": 3 };
    const { edges } = buildFileGraph(index);
    // import 1 + co-change 2 * 3 / (4 + 3 - 3) = 1.5 + directory 0.3.
    expect(edges).toHaveLength(1);
    expect(edges[0]?.weight).toBeCloseTo(2.8);
  });

  it("uses the weights it is given instead of the defaults", () => {
    const index = makeIndex(
      ["d/a.py", "d/b.py", "e/hub.py", "f/p.py", "g/q.py", "h/r.py", "i/s.py"],
      {
        imports: [
          ["d/a.py", "d/b.py"],
          ["f/p.py", "e/hub.py"],
          ["g/q.py", "e/hub.py"],
        ],
        coChange: [
          ["d/a.py", "d/b.py", 3],
          ["h/r.py", "i/s.py", 2],
        ],
      },
    );
    index.coChange.fileCommits = { "d/a.py": 4, "d/b.py": 3, "h/r.py": 2, "i/s.py": 2 };
    const graph = buildFileGraph(index, {
      import: 3,
      coChange: 5,
      directory: 0.6,
      minCoChangeCount: 3,
      hubInDegree: 1,
    });
    // d/a.py - d/b.py: import 3 + co-change 5 * 3 / 4 = 3.75 + directory 0.6.
    expect(weightOf(graph, "d/a.py", "d/b.py")).toBeCloseTo(7.35);
    // e/hub.py has 2 importers > hubInDegree 1, so each import weighs 3 * 1 / 2.
    expect(weightOf(graph, "e/hub.py", "f/p.py")).toBeCloseTo(1.5);
    expect(weightOf(graph, "e/hub.py", "g/q.py")).toBeCloseTo(1.5);
    // h/r.py - i/s.py was seen twice, below minCoChangeCount 3.
    expect(weightOf(graph, "h/r.py", "i/s.py")).toBeUndefined();
    expect(graph.edges).toHaveLength(3);
  });
});
