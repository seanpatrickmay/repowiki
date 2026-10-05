import { beforeAll, describe, expect, it } from "vitest";
import { createSourceParser, type SourceLanguage, type SourceParser } from "./languages.ts";
import { extractSymbols } from "./symbols.ts";

let parser: SourceParser;
beforeAll(async () => {
  parser = await createSourceParser();
});

function symbolsOf(language: SourceLanguage, source: string) {
  const parsed = parser.parse(language, source);
  try {
    return { hasError: parsed.hasError, symbols: extractSymbols(language, parsed.root, parser) };
  } finally {
    parsed.dispose();
  }
}

const names = (language: SourceLanguage, source: string) =>
  symbolsOf(language, source).symbols.map((s) => `${s.kind} ${s.qualifiedName}`);

describe("extractSymbols (python)", () => {
  it("finds functions, classes, and qualified methods, but not nested functions", () => {
    const source = [
      "def top():",
      "    def inner():",
      "        pass",
      "",
      "class Service:",
      "    def run(self):",
      "        pass",
      "    class Config:",
      "        def load(self): ...",
    ].join("\n");
    expect(names("python", source)).toEqual([
      "function top",
      "class Service",
      "method Service.run",
      "class Service.Config",
      "method Service.Config.load",
    ]);
  });

  it("includes decorators in the line span", () => {
    const source = "import x\n\n@app.get('/')\n@cached\ndef index():\n    return 1\n";
    expect(symbolsOf("python", source).symbols).toEqual([
      { qualifiedName: "index", kind: "function", startLine: 3, endLine: 6, exported: true },
    ]);
  });

  it("indexes public module-level bindings but not class attributes or private names", () => {
    const source = [
      "router = APIRouter()",
      "MAX_RETRIES: int = 3",
      "_cache = {}",
      "class Model:",
      "    id: int = 0",
    ].join("\n");
    expect(names("python", source)).toEqual([
      "variable router",
      "variable MAX_RETRIES",
      "class Model",
    ]);
  });

  it("marks underscore names as not exported", () => {
    const [helper] = symbolsOf("python", "def _helper():\n    pass\n").symbols;
    expect(helper?.exported).toBe(false);
  });

  it("counts __dunder__ names as exported and leaves other underscore names unexported", () => {
    const source = [
      "__version__ = '1'",
      "_cache = {}",
      "class K:",
      "    def __init__(self): pass",
      "    def _hidden(self): pass",
      "    def __mangled(self): pass",
      "def __trailing_only(): pass",
    ].join("\n");
    const exported = Object.fromEntries(
      symbolsOf("python", source).symbols.map((s) => [s.qualifiedName, s.exported]),
    );
    expect(exported).toEqual({
      __version__: true,
      K: true,
      "K.__init__": true,
      "K._hidden": false,
      "K.__mangled": false,
      __trailing_only: false,
    });
  });

  it("merges a property getter and setter into one span", () => {
    const source = [
      "class K:",
      "    @property",
      "    def x(self): return 1",
      "    @x.setter",
      "    def x(self, v): pass",
    ].join("\n");
    expect(symbolsOf("python", source).symbols.find((s) => s.qualifiedName === "K.x")).toEqual({
      qualifiedName: "K.x",
      kind: "method",
      startLine: 2,
      endLine: 5,
      exported: true,
    });
  });

  it("keeps the valid definitions of a file with a syntax error", () => {
    const result = symbolsOf("python", "def ok():\n    pass\n\ndef broken(:\n    pass\n");
    expect(result.hasError).toBe(true);
    expect(result.symbols.map((s) => s.qualifiedName)).toContain("ok");
  });
});

describe("extractSymbols (typescript)", () => {
  it("finds declarations and marks exports, with the export keyword in the span", () => {
    const source = [
      "export function build() {}",
      "function local() {}",
      "export interface Options {}",
      "export type Id = string;",
      "export enum Mode { A }",
      "export const Schema = z.object({});",
      "const hidden = 1;",
      "export const run = async () => {};",
    ].join("\n");
    expect(symbolsOf("typescript", source).symbols).toEqual([
      { qualifiedName: "build", kind: "function", startLine: 1, endLine: 1, exported: true },
      { qualifiedName: "local", kind: "function", startLine: 2, endLine: 2, exported: false },
      { qualifiedName: "Options", kind: "interface", startLine: 3, endLine: 3, exported: true },
      { qualifiedName: "Id", kind: "type", startLine: 4, endLine: 4, exported: true },
      { qualifiedName: "Mode", kind: "enum", startLine: 5, endLine: 5, exported: true },
      { qualifiedName: "Schema", kind: "variable", startLine: 6, endLine: 6, exported: true },
      { qualifiedName: "run", kind: "function", startLine: 8, endLine: 8, exported: true },
    ]);
  });

  it("orders same-line symbols by code unit, not by locale", () => {
    const source = "function z() {} function ä() {} function a() {} function Z() {}\n";
    expect(symbolsOf("typescript", source).symbols.map((s) => s.qualifiedName)).toEqual([
      "Z",
      "a",
      "z",
      "ä",
    ]);
  });

  it("merges same-name symbols of different kinds into one span with the first kind", () => {
    const source = "type Foo = { a: 1 };\nexport const Foo = 1;\n";
    expect(symbolsOf("typescript", source).symbols).toEqual([
      { qualifiedName: "Foo", kind: "type", startLine: 1, endLine: 2, exported: true },
    ]);
  });

  it("finds class methods, including private and abstract ones", () => {
    const source = [
      "export abstract class Store {",
      "  #secret() {}",
      "  static open() {}",
      "  abstract close(): void;",
      "}",
    ].join("\n");
    expect(names("typescript", source)).toEqual([
      "class Store",
      "method Store.#secret",
      "method Store.open",
      "method Store.close",
    ]);
  });

  it("names anonymous default exports 'default'", () => {
    expect(names("typescript", "export default function () {}")).toEqual(["function default"]);
  });

  it("finds TSX components", () => {
    const source =
      "export const Button = () => <button />;\nexport function Page() { return <main />; }\n";
    expect(names("tsx", source)).toEqual(["function Button", "function Page"]);
  });

  it("recovers the declarations after an unclosed paren from re-parsed chunks", () => {
    const source =
      "export function ok() {}\nexport function bad( {\nexport function after() {}\nexport const k = 1;\n";
    const result = symbolsOf("typescript", source);
    expect(result.hasError).toBe(true);
    expect(result.symbols).toEqual([
      { qualifiedName: "ok", kind: "function", startLine: 1, endLine: 1, exported: true },
      { qualifiedName: "after", kind: "function", startLine: 3, endLine: 3, exported: true },
      { qualifiedName: "k", kind: "variable", startLine: 4, endLine: 4, exported: true },
    ]);
  });

  it("recovers later declarations after an unclosed brace in a function, without its locals", () => {
    const source =
      "export function outer() {\n  function inner() {}\n  const loc = 1;\n  if ( {\n  function inner2() {}\n}\nexport function after() {}\n";
    const result = symbolsOf("typescript", source);
    expect(result.hasError).toBe(true);
    expect(result.symbols).toEqual([
      { qualifiedName: "after", kind: "function", startLine: 7, endLine: 7, exported: true },
    ]);
  });

  it("bounds a declaration whose missing brace swallowed the next one", () => {
    const source = "export function outer() {\n  if (x) {\n}\nfunction after() {}\n";
    expect(symbolsOf("typescript", source).symbols).toEqual([
      { qualifiedName: "outer", kind: "function", startLine: 1, endLine: 3, exported: true },
      { qualifiedName: "after", kind: "function", startLine: 4, endLine: 4, exported: false },
    ]);
  });

  it("keeps recovered class members qualified under their own class", () => {
    const source = [
      "export class A {",
      "  m1() {",
      "    if (x) {",
      "  }",
      "}",
      "export class B {",
      "  m3() {}",
      "}",
      "function priv() {}",
    ].join("\n");
    expect(symbolsOf("typescript", source).symbols).toEqual([
      { qualifiedName: "A", kind: "class", startLine: 1, endLine: 5, exported: true },
      { qualifiedName: "A.m1", kind: "method", startLine: 2, endLine: 5, exported: true },
      { qualifiedName: "B", kind: "class", startLine: 6, endLine: 8, exported: true },
      { qualifiedName: "B.m3", kind: "method", startLine: 7, endLine: 7, exported: true },
      { qualifiedName: "priv", kind: "function", startLine: 9, endLine: 9, exported: false },
    ]);
  });

  it("keeps decorators with a recovered declaration", () => {
    const source = "f( {\n@Component({\n  x: 1,\n})\nexport class View {}\n";
    expect(symbolsOf("typescript", source).symbols).toEqual([
      { qualifiedName: "View", kind: "class", startLine: 2, endLine: 5, exported: true },
    ]);
  });

  it("never cuts a chunk inside a template literal or a block comment", () => {
    for (const [open, close] of [
      ["const s = `", "`;"],
      ["/*", "*/"],
    ]) {
      const source = [
        "export function bad( {",
        open,
        "export function fake1() {}",
        "export function fake2() {}",
        close,
        "export const real = 2;",
      ].join("\n");
      expect(names("typescript", source)).toEqual(["variable real"]);
    }
  });

  it("keeps a broken declaration's own symbol, ending where the next chunk starts", () => {
    const source = [
      "export function outer() {",
      "  const s = 'abc';",
      "  if ( {",
      "export function after() {}",
      "// c",
      "export const k = 'x';",
    ].join("\n");
    expect(symbolsOf("typescript", source).symbols).toEqual([
      { qualifiedName: "outer", kind: "function", startLine: 1, endLine: 3, exported: true },
      { qualifiedName: "after", kind: "function", startLine: 4, endLine: 4, exported: true },
      { qualifiedName: "k", kind: "variable", startLine: 6, endLine: 6, exported: true },
    ]);
  });

  it("keeps a broken declaration whose template literal or comment holds column-0 lines", () => {
    const build = [
      "export function build() {",
      "  const q = `",
      "type Query { a: Int }",
      "`;",
      "  if (x) {",
      "}",
      "export function after() {}",
    ].join("\n");
    expect(symbolsOf("typescript", build).symbols).toEqual([
      { qualifiedName: "build", kind: "function", startLine: 1, endLine: 6, exported: true },
      { qualifiedName: "after", kind: "function", startLine: 7, endLine: 7, exported: true },
    ]);
    const svc = [
      "export class Svc {",
      "  /*",
      "function old() {}",
      "  */",
      "  m() {",
      "    if (x) {",
      "  }",
      "}",
      "export function after() {}",
    ].join("\n");
    expect(symbolsOf("typescript", svc).symbols).toEqual([
      { qualifiedName: "Svc", kind: "class", startLine: 1, endLine: 8, exported: true },
      { qualifiedName: "Svc.m", kind: "method", startLine: 5, endLine: 8, exported: true },
      { qualifiedName: "after", kind: "function", startLine: 9, endLine: 9, exported: true },
    ]);
  });

  it("never cuts a chunk inside JSX text", () => {
    const source = [
      "export function C() {",
      "  return (<div>",
      "const a = 1;",
      "function x() {}",
      "</div>;",
      "}",
      "export const after = 1;",
    ].join("\n");
    expect(symbolsOf("tsx", source).symbols).toEqual([
      { qualifiedName: "C", kind: "function", startLine: 1, endLine: 6, exported: true },
      { qualifiedName: "after", kind: "variable", startLine: 7, endLine: 7, exported: true },
    ]);
  });

  it("drops column-0 locals that a later stray closing brace shows were in a block", () => {
    const source = [
      "export function outer() {",
      "foo( {",
      "function loc1() {}",
      "function loc2() {}",
      "}",
      "export function after() {}",
    ].join("\n");
    expect(names("typescript", source)).toEqual(["function after"]);
  });

  it("does not take exports in an unindented namespace body for top-level symbols", () => {
    for (const open of ["namespace N {", "export namespace N {"]) {
      const source = [
        "foo( {",
        open,
        "export function inner() {}",
        "export const v = 1;",
        "}",
        "export function after() {}",
      ].join("\n");
      expect(names("typescript", source)).toEqual(["function after"]);
    }
    const errorLater = "namespace N {\nexport const inner = 1\n}\nexport function bad( {\n";
    expect(names("typescript", errorLater)).toEqual([]);
  });

  it("stays linear in the nesting of multi-line template literals", () => {
    // Quadratic row marking took about 9 s here; linear takes well under a second.
    const depth = 16_000;
    const source = `f( {\nconst s = ${"`\n${".repeat(depth)}1${"}\n`".repeat(depth)};\nfunction z() {}\n`;
    const parsed = parser.parse("typescript", source);
    try {
      const started = performance.now();
      const symbols = extractSymbols("typescript", parsed.root, parser);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(symbols.map((s) => s.qualifiedName)).toEqual(["z"]);
    } finally {
      parsed.dispose();
    }
  });

  it("keeps a bare `export default` line with the declaration under it", () => {
    const source = "foo( {\nexport default\nclass C {}\nexport const k = 1;\n";
    expect(symbolsOf("typescript", source).symbols).toEqual([
      { qualifiedName: "C", kind: "class", startLine: 2, endLine: 3, exported: true },
      { qualifiedName: "k", kind: "variable", startLine: 4, endLine: 4, exported: true },
    ]);
  });
});

describe("extractSymbols (python) after a syntax error", () => {
  it("recovers the definitions after an unclosed paren", () => {
    const source = [
      "x = foo(",
      "",
      "@dec",
      "def after():",
      "    pass",
      "",
      "class _K:",
      "    def m(self):",
      "        pass",
      "",
      "LIMIT = 3",
    ].join("\n");
    const result = symbolsOf("python", source);
    expect(result.hasError).toBe(true);
    expect(result.symbols).toEqual([
      { qualifiedName: "x", kind: "variable", startLine: 1, endLine: 1, exported: true },
      { qualifiedName: "after", kind: "function", startLine: 3, endLine: 5, exported: true },
      { qualifiedName: "_K", kind: "class", startLine: 7, endLine: 9, exported: false },
      { qualifiedName: "_K.m", kind: "method", startLine: 8, endLine: 9, exported: true },
      { qualifiedName: "LIMIT", kind: "variable", startLine: 11, endLine: 11, exported: true },
    ]);
  });

  it("never cuts a chunk inside a triple-quoted string", () => {
    const source = [
      "x = foo(",
      's = """',
      "def fake1():",
      "    pass",
      "def fake2():",
      "    pass",
      '"""',
      "def real():",
      "    pass",
    ].join("\n");
    expect(names("python", source)).toEqual(["function real"]);
    const docstring = [
      "class Svc:",
      '    """',
      "def usage(): ...",
      '    """',
      "    def m(self):",
      "        foo(",
      "def after():",
      "    pass",
    ].join("\n");
    expect(symbolsOf("python", docstring).symbols).toEqual([
      { qualifiedName: "Svc", kind: "class", startLine: 1, endLine: 6, exported: true },
      { qualifiedName: "Svc.m", kind: "method", startLine: 5, endLine: 6, exported: true },
      { qualifiedName: "after", kind: "function", startLine: 7, endLine: 8, exported: true },
    ]);
  });

  it("does not take column-0 keyword arguments for bindings", () => {
    const source = ["setup(", "name='foo'", "version='1.0',", ")", "def real():", "    pass"].join(
      "\n",
    );
    expect(names("python", source)).toEqual(["function real"]);
  });

  it("returns the same symbols for the same broken source", () => {
    const source = "def a(:\n    pass\nclass B:\n    pass\nC = (\ndef d():\n    pass\n";
    expect(symbolsOf("python", source)).toEqual(symbolsOf("python", source));
  });
});
