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

  it("weighs co-change as twice the Jaccard similarity, ignoring single co-commits", () => {
    const index = makeIndex(["a/x.py", "b/y.tf", "c/z.md"], {
      coChange: [
        ["a/x.py", "b/y.tf", 3],
        ["a/x.py", "c/z.md", 1],
      ],
    });
    index.coChange.fileCommits = { "a/x.py": 4, "b/y.tf": 3, "c/z.md": 1 };
    const graph = buildFileGraph(index);
    // |x ∩ y| = 3, |x ∪ y| = 4 + 3 - 3 = 4.
    expect(weightOf(graph, "a/x.py", "b/y.tf")).toBeCloseTo(1.5);
    expect(weightOf(graph, "a/x.py", "c/z.md")).toBeUndefined();
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
});
