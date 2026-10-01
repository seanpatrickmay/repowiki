import { describe, expect, it } from "vitest";
import { clusterFiles } from "./clusters.ts";
import { buildFileGraph } from "./graph.ts";
import { makeIndex } from "./test-index.ts";

/** Two tightly importing groups of four files plus whatever `extra` adds. */
function twoGroups(extra: string[] = [], imports: [string, string][] = []) {
  const api = ["api/a.py", "api/b.py", "api/c.py", "api/d.py"];
  const web = ["web/a.ts", "web/b.ts", "web/c.ts", "web/d.ts"];
  const clique = (files: string[]) =>
    files.flatMap((x, i) => files.slice(i + 1).map((y): [string, string] => [x, y]));
  return buildFileGraph(
    makeIndex([...api, ...web, ...extra], {
      imports: [...clique(api), ...clique(web), ...imports],
    }),
  );
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
});
