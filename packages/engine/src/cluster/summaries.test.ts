import { memberId } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import type { SymbolDef } from "../index/index.ts";
import { buildFileGraph, type FileGraph } from "./graph.ts";
import { summarizeClusters } from "./summaries.ts";
import { makeIndex } from "./test-index.ts";

function symbol(path: string, qualifiedName: string, kind: SymbolDef["kind"], exported = true) {
  return {
    id: memberId(path, qualifiedName),
    qualifiedName,
    kind,
    startLine: 1,
    endLine: 2,
    exported,
  };
}

const index = makeIndex(["api/app.py", "api/routes.py", "api/README.md", "web/main.ts"], {
  imports: [
    ["api/routes.py", "api/app.py"],
    ["web/main.ts", "api/app.py"],
  ],
});
for (const file of index.files) {
  if (file.path.endsWith(".py")) file.language = "python";
  if (file.path.endsWith(".ts")) file.language = "typescript";
}
const app = index.files.find((f) => f.path === "api/app.py");
if (app) {
  app.symbols = [
    symbol("api/app.py", "logger", "variable"),
    symbol("api/app.py", "create_app", "function"),
    symbol("api/app.py", "App", "class"),
    symbol("api/app.py", "App.run", "method"),
    symbol("api/app.py", "_private", "function", false),
  ];
}
index.unresolved = [
  { from: "api/app.py", specifier: "fastapi.routing", line: 1, external: true },
  { from: "api/routes.py", specifier: "fastapi", line: 1, external: true },
  { from: "api/routes.py", specifier: "os", line: 2, external: true },
  { from: "web/main.ts", specifier: "@tanstack/react-query/devtools", line: 1, external: true },
  { from: "api/routes.py", specifier: "missing_internal", line: 3, external: false },
];
const clusters = [
  { id: "c01", files: ["api/README.md", "api/app.py", "api/routes.py"] },
  { id: "c02", files: ["web/main.ts"] },
];

describe("summarizeClusters", () => {
  const [api, web] = summarizeClusters(index, buildFileGraph(index), clusters);

  it("counts files, symbols, languages, and directories", () => {
    expect(api).toMatchObject({
      id: "c01",
      fileCount: 3,
      symbolCount: 5,
      languages: ["python 2", "other 1"],
      directories: [{ dir: "api", files: 3 }],
    });
  });

  it("lists best-connected files first and exported non-method symbols, types first", () => {
    expect(api?.files[0]).toBe("api/app.py");
    expect(api?.symbols).toEqual(["api/app.py#App", "api/app.py#create_app", "api/app.py#logger"]);
  });

  it("names external packages, most used first, ignoring unresolved internal imports", () => {
    expect(api?.externalImports).toEqual(["fastapi", "os"]);
    expect(web?.externalImports).toEqual(["@tanstack/react-query"]);
  });

  it("lists neighbouring clusters with the weight they share", () => {
    expect(api?.neighbours).toEqual([{ id: "c02", weight: 1 }]);
    expect(web?.neighbours).toEqual([{ id: "c01", weight: 1 }]);
  });

  it("caps each listing at the given limits", () => {
    const limits = { files: 1, symbols: 1, directories: 1, externalImports: 1, neighbours: 0 };
    const [small] = summarizeClusters(index, buildFileGraph(index), clusters, limits);
    expect(small).toMatchObject({
      files: ["api/app.py"],
      symbols: ["api/app.py#App"],
      externalImports: ["fastapi"],
      neighbours: [],
    });
  });
});

describe("summarizeClusters ranking rules", () => {
  const paths = ["p/a.ts", "p/d.ts", "q/x.ts", "r/b.ts", "s/c.ts", "top.ts", "z/y.py"];
  const ranking = makeIndex(paths);
  const symbolsByPath: Record<string, [string, SymbolDef["kind"]][]> = {
    "p/a.ts": [
      ["va", "variable"],
      ["fa", "function"],
    ],
    "p/d.ts": [["ED", "enum"]],
    "r/b.ts": [["IB", "interface"]],
    "s/c.ts": [["TC", "type"]],
  };
  for (const file of ranking.files) {
    file.symbols = (symbolsByPath[file.path] ?? []).map(([name, kind]) =>
      symbol(file.path, name, kind),
    );
  }
  const miss = (from: string, specifier: string, external = true) => ({
    from,
    specifier,
    line: 1,
    external,
  });
  ranking.unresolved = [
    miss("p/a.ts", "zod"),
    miss("p/a.ts", "@scope/pkg/x"),
    miss("p/d.ts", "zod/v4"),
    miss("p/d.ts", "chart.js/auto"),
    miss("r/b.ts", "react-dom/client"),
    miss("s/c.ts", "zod"),
    miss("s/c.ts", "react-dom"),
    miss("s/c.ts", "./gone", false),
    miss("z/y.py", "os.path"),
    miss("z/y.py", "os"),
    miss("z/y.py", "numpy.linalg"),
    miss("z/y.py", ".sibling", false),
  ];
  // Inner weights: r/b 7, s/c 7, p/a 5, p/d 5. Node order in the file never matches that rank,
  // and a file sits on the low side of one edge and the high side of another.
  const edge = (x: string, y: string, weight: number) =>
    x < y ? { a: x, b: y, weight } : { a: y, b: x, weight };
  const graph: FileGraph = {
    nodes: paths,
    edges: [
      edge("p/a.ts", "p/d.ts", 5),
      edge("r/b.ts", "s/c.ts", 7),
      edge("s/c.ts", "q/x.ts", 9),
      edge("p/a.ts", "z/y.py", 0.12345),
    ],
  };
  const ranked = [
    { id: "c01", files: ["s/c.ts", "r/b.ts", "p/d.ts", "p/a.ts"] },
    { id: "c02", files: ["q/x.ts"] },
    { id: "c03", files: ["z/y.py", "top.ts"] },
  ];
  const [main, , root] = summarizeClusters(ranking, graph, ranked);

  it("ranks files by the edge weight they keep inside the cluster, not across it", () => {
    expect(main?.files).toEqual(["r/b.ts", "s/c.ts", "p/a.ts", "p/d.ts"]);
  });

  it("orders symbols types, then functions, then variables, central files first within a kind", () => {
    expect(main?.symbols).toEqual([
      "r/b.ts#IB",
      "s/c.ts#TC",
      "p/d.ts#ED",
      "p/a.ts#fa",
      "p/a.ts#va",
    ]);
  });

  it("reduces specifiers to package roots, ranked by use then name", () => {
    // zod 3 (including "zod/v4"), react-dom 2, then the single uses in alphabetical order.
    expect(main?.externalImports).toEqual(["zod", "react-dom", "@scope/pkg", "chart.js"]);
    expect(root?.externalImports).toEqual(["os", "numpy"]);
  });

  it("rounds shared weight to two decimals and labels the repo root", () => {
    expect(main?.neighbours).toEqual([
      { id: "c02", weight: 9 },
      { id: "c03", weight: 0.12 },
    ]);
    expect(root?.directories).toEqual([
      { dir: "(root)", files: 1 },
      { dir: "z", files: 1 },
    ]);
  });

  it("breaks count ties alphabetically and applies each limit to its own listing", () => {
    const limits = { files: 3, symbols: 2, directories: 2, externalImports: 1, neighbours: 1 };
    const [small] = summarizeClusters(ranking, graph, ranked, limits);
    expect(small).toMatchObject({
      files: ["r/b.ts", "s/c.ts", "p/a.ts"],
      symbols: ["r/b.ts#IB", "s/c.ts#TC"],
      directories: [
        { dir: "p", files: 2 },
        { dir: "r", files: 1 },
      ],
      externalImports: ["zod"],
      neighbours: [{ id: "c02", weight: 9 }],
    });
  });
});
