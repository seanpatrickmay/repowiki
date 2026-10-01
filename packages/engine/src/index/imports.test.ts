import { beforeAll, describe, expect, it } from "vitest";
import { extractImports } from "./imports.ts";
import { createSourceParser, type SourceLanguage, type SourceParser } from "./languages.ts";

let parser: SourceParser;
beforeAll(async () => {
  parser = await createSourceParser();
});

function importsOf(language: SourceLanguage, source: string) {
  const parsed = parser.parse(language, source);
  try {
    return extractImports(language, parsed.root);
  } finally {
    parsed.dispose();
  }
}

describe("extractImports (python)", () => {
  it("reads plain, aliased, and multi-module imports", () => {
    expect(importsOf("python", "import os, a.b as c\n")).toEqual([
      { kind: "python", module: "os", level: 0, names: [], line: 1 },
      { kind: "python", module: "a.b", level: 0, names: [], line: 1 },
    ]);
  });

  it("reads relative from-imports with their level and names", () => {
    expect(importsOf("python", "from ..a.b import c as d, e\nfrom . import f\n")).toEqual([
      { kind: "python", module: "a.b", level: 2, names: ["c", "e"], line: 1 },
      { kind: "python", module: "", level: 1, names: ["f"], line: 2 },
    ]);
  });

  it("treats a wildcard import as importing the module itself", () => {
    expect(importsOf("python", "from pkg.mod import *\n")).toEqual([
      { kind: "python", module: "pkg.mod", level: 0, names: [], line: 1 },
    ]);
  });

  it("finds imports nested in functions and try blocks", () => {
    const source =
      "def f():\n    import json\ntry:\n    from x import y\nexcept ImportError:\n    pass\n";
    expect(importsOf("python", source).map((i) => i.line)).toEqual([2, 4]);
  });

  it("ignores __future__ imports", () => {
    expect(importsOf("python", "from __future__ import annotations\n")).toEqual([]);
  });
});

describe("extractImports (typescript)", () => {
  it("reads static imports, re-exports, and dynamic imports", () => {
    const source = [
      'import React from "react";',
      'import type { A } from "./a.js";',
      'import "./styles.css";',
      'export * from "../b";',
      'export { c } from "@scope/pkg/sub";',
      'const Page = lazy(() => import("./Page"));',
      "export const x = 1;",
      'const y = require("ignored");',
    ].join("\n");
    expect(importsOf("tsx", source)).toEqual([
      { kind: "es", specifier: "react", line: 1 },
      { kind: "es", specifier: "./a.js", line: 2 },
      { kind: "es", specifier: "./styles.css", line: 3 },
      { kind: "es", specifier: "../b", line: 4 },
      { kind: "es", specifier: "@scope/pkg/sub", line: 5 },
      { kind: "es", specifier: "./Page", line: 6 },
    ]);
  });
});
