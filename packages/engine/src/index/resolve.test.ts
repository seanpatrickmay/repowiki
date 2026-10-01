import { describe, expect, it } from "vitest";
import type { RawImport } from "./imports.ts";
import { createResolver, parseWorkspacePackage } from "./resolve.ts";

const FILES = [
  "src/pkg/__init__.py",
  "src/pkg/a.py",
  "src/pkg/sub/__init__.py",
  "src/pkg/sub/b.py",
  "tests/test_a.py",
  "tools/run.py",
  "web/src/main.tsx",
  "web/src/lib/index.ts",
  "web/src/lib/util.ts",
  "web/src/components/Button.tsx",
  "web/src/data.json",
  "packages/core/src/index.ts",
];
const CORE = { name: "@x/core", exports: { ".": "packages/core/src/index.ts" } };
const resolver = createResolver(FILES, [CORE]);

const py = (module: string, names: string[] = [], level = 0): RawImport => ({
  kind: "python",
  module,
  level,
  names,
  line: 1,
});
const es = (specifier: string): RawImport => ({ kind: "es", specifier, line: 1 });

describe("python resolution", () => {
  it.each([
    ["absolute import through a src/ root", "tests/test_a.py", py("pkg.a"), ["src/pkg/a.py"]],
    ["package import to __init__.py", "tests/test_a.py", py("pkg"), ["src/pkg/__init__.py"]],
    ["from-import of a submodule", "tests/test_a.py", py("pkg", ["a"]), ["src/pkg/a.py"]],
    [
      "from-import of a name in __init__",
      "tests/test_a.py",
      py("pkg", ["VERSION"]),
      ["src/pkg/__init__.py"],
    ],
    [
      "from-import mixing a submodule and a name",
      "tests/test_a.py",
      py("pkg.sub", ["b", "helper"]),
      ["src/pkg/sub/__init__.py", "src/pkg/sub/b.py"],
    ],
    ["relative import two levels up", "src/pkg/sub/b.py", py("", ["a"], 2), ["src/pkg/a.py"]],
    [
      "relative import of the own package",
      "src/pkg/sub/b.py",
      py("", ["missing"], 1),
      ["src/pkg/sub/__init__.py"],
    ],
  ])("%s", (_name, from, raw, targets) => {
    expect(resolver.resolve(from, raw)).toEqual({ targets, external: false });
  });

  it("marks unknown absolute imports as external", () => {
    expect(resolver.resolve("src/pkg/a.py", py("os"))).toEqual({ targets: [], external: true });
  });

  it("marks unresolvable relative imports as internal misses", () => {
    expect(resolver.resolve("src/pkg/a.py", py("nope", [], 1))).toEqual({
      targets: [],
      external: false,
    });
  });

  it("refuses relative imports that climb above the repo root", () => {
    expect(resolver.resolve("tools/run.py", py("x", [], 3))).toEqual({
      targets: [],
      external: false,
    });
  });
});

describe("es resolution", () => {
  it.each([
    ["extensionless file", "./lib/util", ["web/src/lib/util.ts"]],
    ["directory index", "./lib", ["web/src/lib/index.ts"]],
    [
      "ESM .js specifier for a .tsx source",
      "./components/Button.js",
      ["web/src/components/Button.tsx"],
    ],
    ["exact file with extension", "./data.json", ["web/src/data.json"]],
    ["workspace package root export", "@x/core", ["packages/core/src/index.ts"]],
  ])("%s", (_name, specifier, targets) => {
    expect(resolver.resolve("web/src/main.tsx", es(specifier))).toEqual({
      targets,
      external: false,
    });
  });

  it("marks npm packages as external", () => {
    expect(resolver.resolve("web/src/main.tsx", es("react-dom/client"))).toEqual({
      targets: [],
      external: true,
    });
  });

  it.each([
    ["missing relative file", "./nope"],
    ["path escaping the repo", "../../../outside"],
    ["absolute path", "/etc/passwd"],
    ["unexported workspace subpath", "@x/core/internal"],
  ])("leaves a %s unresolved and internal", (_name, specifier) => {
    expect(resolver.resolve("web/src/main.tsx", es(specifier))).toEqual({
      targets: [],
      external: false,
    });
  });
});

describe("parseWorkspacePackage", () => {
  it.each([
    ["string exports", { name: "a", exports: "./src/index.ts" }, { ".": "pkgs/a/src/index.ts" }],
    [
      "conditional root exports",
      { name: "a", exports: { import: "./esm.js", require: "./cjs.js" } },
      { ".": "pkgs/a/esm.js" },
    ],
    [
      "subpath exports with conditions",
      { name: "a", exports: { ".": "./i.ts", "./x": { default: "./x.ts" } } },
      { ".": "pkgs/a/i.ts", "./x": "pkgs/a/x.ts" },
    ],
    ["main fallback", { name: "a", main: "lib/main.js" }, { ".": "pkgs/a/lib/main.js" }],
    ["no entry points", { name: "a" }, {}],
  ])("reads %s", (_name, json, exports) => {
    expect(parseWorkspacePackage("pkgs/a/package.json", JSON.stringify(json))).toEqual({
      name: "a",
      exports,
    });
  });

  it("resolves a root package.json relative to the repo root", () => {
    expect(parseWorkspacePackage("package.json", '{"name":"root","main":"index.ts"}')).toEqual({
      name: "root",
      exports: { ".": "index.ts" },
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["no name", "{}"],
    ["a non-object", "[]"],
  ])("returns null for %s", (_name, text) => {
    expect(parseWorkspacePackage("package.json", text)).toBeNull();
  });
});
