import { memberId } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import type { SymbolDef } from "../index/index.ts";
import { buildFileGraph } from "./graph.ts";
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
