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
    return { hasError: parsed.hasError, symbols: extractSymbols(language, parsed.root) };
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

  it("stops collecting symbols at syntax error regions", () => {
    const source =
      "export function ok() {}\nexport function bad( {\nexport function after() {}\nexport const k = 1;\n";
    const result = symbolsOf("typescript", source);
    expect(result.hasError).toBe(true);
    expect(result.symbols).toEqual([
      { qualifiedName: "ok", kind: "function", startLine: 1, endLine: 1, exported: true },
    ]);
  });

  it("does not emit function locals or keywords as symbols", () => {
    const source =
      "export function outer() {\n  function inner() {}\n  const loc = 1;\n  if ( {\n  function inner2() {}\n}\nexport function after() {}\n";
    const result = symbolsOf("typescript", source);
    expect(result.hasError).toBe(true);
    // When there's a syntax error, we only emit well-formed root-level declarations
    // Do NOT emit: function locals (inner, loc, inner2), keywords (function, export)
    const names = result.symbols.map((s) => s.qualifiedName);
    expect(names).not.toContain("inner");
    expect(names).not.toContain("loc");
    expect(names).not.toContain("inner2");
    expect(names).not.toContain("function");
    expect(names).not.toContain("export");
  });
});
