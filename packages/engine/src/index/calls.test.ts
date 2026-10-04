import { beforeAll, describe, expect, it } from "vitest";
import {
  type CallSite,
  extractBindings,
  extractCalls,
  type ImportBinding,
  type ResolvedBinding,
  resolveBinding,
  resolveCalls,
  type SymbolSpan,
} from "./calls.ts";
import { createSourceParser, type SourceLanguage, type SourceParser } from "./languages.ts";

let parser: SourceParser;
beforeAll(async () => {
  parser = await createSourceParser();
});

function parsed<T>(language: SourceLanguage, source: string, read: (root: never) => T): T {
  const tree = parser.parse(language, source);
  try {
    return read(tree.root as never);
  } finally {
    tree.dispose();
  }
}
const bindings = (language: SourceLanguage, source: string) =>
  parsed(language, source, (root) => extractBindings(language, root));
const calls = (language: SourceLanguage, source: string) =>
  parsed(language, source, (root) => extractCalls(language, root));

describe("extractBindings", () => {
  it("binds Python from-imports by name or alias, and aliased or single-segment modules", () => {
    const found = bindings(
      "python",
      "from .a import b as c, d\nimport x.y as z\nimport q\nimport u.v\n",
    );
    expect(found.map(({ local, imported }) => [local, imported])).toEqual([
      ["c", "b"],
      ["d", "d"],
      ["z", null],
      ["q", null],
    ]);
    expect(found[0]?.raw).toEqual({ kind: "python", module: "a", level: 1, names: ["b"], line: 1 });
    expect(found[2]?.raw).toEqual({ kind: "python", module: "x.y", level: 0, names: [], line: 2 });
  });

  it("binds ES default, named, aliased and namespace imports", () => {
    const source =
      'import D, { a, b as c } from "./m";\nimport * as ns from "./n";\nimport "./side";\n';
    const found = bindings("typescript", source);
    expect(found.map(({ local, imported }) => [local, imported])).toEqual([
      ["D", "default"],
      ["a", "a"],
      ["c", "b"],
      ["ns", null],
    ]);
    expect(found[3]?.raw).toEqual({ kind: "es", specifier: "./n", line: 2 });
  });

  it("binds a bare relative from-import, and binds nothing for a re-export", () => {
    const found = bindings("python", "from . import x\n");
    expect(found.map(({ local, imported }) => [local, imported])).toEqual([["x", "x"]]);
    expect(found[0]?.raw).toEqual({ kind: "python", module: "", level: 1, names: ["x"], line: 1 });
    expect(bindings("typescript", 'export { x } from "./y";\n')).toEqual([]);
  });
});

describe("extractCalls", () => {
  it("finds Python calls, attribute calls and self calls, inside function bodies too", () => {
    const source = "def f():\n    g(1)\n    self.m()\n    z.h()\n    a.b.c()\nK()\n";
    expect(calls("python", source)).toEqual([
      { name: "g", receiver: null, line: 2 },
      { name: "m", receiver: "self", line: 3 },
      { name: "h", receiver: "z", line: 4 },
      { name: "K", receiver: null, line: 6 },
    ]);
  });

  it("finds TS calls, new expressions and this calls, once per line", () => {
    const source = "foo(1); foo(2);\nns.bar();\nnew K();\nclass A { m() { this.n(); } }\n";
    expect(calls("typescript", source)).toEqual([
      { name: "foo", receiver: null, line: 1 },
      { name: "bar", receiver: "ns", line: 2 },
      { name: "K", receiver: null, line: 3 },
      { name: "n", receiver: "self", line: 4 },
    ]);
  });

  it("treats capitalized JSX elements in TSX as calls, and skips HTML tags", () => {
    const source = "const x = <Comp a={1} />;\nconst y = <div><Box.Item></Box.Item></div>;\n";
    expect(calls("tsx", source)).toEqual([
      { name: "Comp", receiver: null, line: 1 },
      { name: "Item", receiver: "Box", line: 2 },
    ]);
  });

  it("maps cls to self in Python only, and self or cls stay receivers in TS", () => {
    expect(calls("python", "cls.m()\n")).toEqual([{ name: "m", receiver: "self", line: 1 }]);
    expect(calls("typescript", "self.k();\ncls.m();\n")).toEqual([
      { name: "k", receiver: "self", line: 1 },
      { name: "m", receiver: "cls", line: 2 },
    ]);
  });

  it("records optional calls, and a JSX element once despite its closing tag", () => {
    expect(calls("typescript", "a?.b();\n")).toEqual([{ name: "b", receiver: "a", line: 1 }]);
    expect(calls("tsx", "const x = <Foo>hi</Foo>;\n")).toEqual([
      { name: "Foo", receiver: null, line: 1 },
    ]);
  });

  it("gives a this member tag in TSX the receiver self", () => {
    expect(calls("tsx", "const x = <this.X />;\n")).toEqual([
      { name: "X", receiver: "self", line: 1 },
    ]);
  });
});

const py = (module: string, level: number, name: string, local = name): ImportBinding => ({
  local,
  imported: name,
  raw: { kind: "python", module, level, names: [name], line: 1 },
});

describe("resolveBinding", () => {
  it("binds a real submodule as the module itself", () => {
    expect(resolveBinding(py("", 1, "sub"), ["app/sub.py"])).toEqual({
      local: "sub",
      imported: null,
      target: "app/sub.py",
    });
    expect(resolveBinding(py("pkg", 1, "sub"), ["app/pkg/sub.py"])).toEqual({
      local: "sub",
      imported: null,
      target: "app/pkg/sub.py",
    });
    expect(resolveBinding(py("", 1, "sub"), ["app/sub/__init__.py"])?.imported).toBeNull();
  });

  it("keeps a from-import of a name that shares its module's file stem as a symbol import", () => {
    expect(resolveBinding(py("util", 1, "util"), ["app/util.py"])).toEqual({
      local: "util",
      imported: "util",
      target: "app/util.py",
    });
    expect(resolveBinding(py("config", 1, "config"), ["app/config/__init__.py"])?.imported).toBe(
      "config",
    );
  });

  it("is null when nothing resolved", () => {
    expect(resolveBinding(py("x", 1, "y"), [])).toBeNull();
  });
});

const span = (qualifiedName: string, kind: string, startLine: number, endLine: number) => ({
  id: `f.py#${qualifiedName}`,
  qualifiedName,
  kind,
  startLine,
  endLine,
});
const FILE_SYMBOLS: SymbolSpan[] = [
  span("run", "function", 1, 5),
  span("K", "class", 10, 20),
  span("K.m", "function", 11, 14),
  span("K.n", "function", 15, 20),
  span("save", "function", 30, 31),
];
const file = { id: "f.py", path: "f.py", symbols: FILE_SYMBOLS };
const site = (name: string, line: number, receiver: string | null = null): CallSite => ({
  name,
  receiver,
  line,
});
const resolve = (
  sites: CallSite[],
  bound: ResolvedBinding[] = [],
  others: Record<string, SymbolSpan[]> = {},
) =>
  resolveCalls(file, sites, bound, (path) =>
    path === "f.py" ? FILE_SYMBOLS : (others[path] ?? []),
  );

describe("resolveCalls", () => {
  it("drops recursion and self-method recursion", () => {
    expect(resolve([site("run", 3), site("m", 12, "self")])).toEqual([]);
  });

  it("keeps one edge per pair, at the first line", () => {
    expect(resolve([site("save", 2), site("save", 4)])).toEqual([
      { from: "f.py#run", to: "f.py#save", line: 2 },
    ]);
  });

  it("resolves self.m() to the enclosing class, and nothing outside a class", () => {
    expect(resolve([site("n", 12, "self")])).toEqual([
      { from: "f.py#K.m", to: "f.py#K.n", line: 12 },
    ]);
    expect(resolve([site("m", 3, "self")])).toEqual([]);
  });

  it("uses the file for module-level calls", () => {
    expect(resolve([site("save", 40)])).toEqual([{ from: "f.py", to: "f.py#save", line: 40 }]);
  });

  it("finds an imported symbol, but a symbol-import receiver has no edge", () => {
    const util: SymbolSpan[] = [span("util", "function", 1, 2), span("load", "function", 4, 5)];
    const bound: ResolvedBinding[] = [{ local: "util", imported: "util", target: "u.py" }];
    const symbolsOf = { "u.py": util.map((s) => ({ ...s, id: `u.py#${s.qualifiedName}` })) };
    expect(resolve([site("util", 2)], bound, symbolsOf)).toEqual([
      { from: "f.py#run", to: "u.py#util", line: 2 },
    ]);
    expect(resolve([site("load", 2, "util")], bound, symbolsOf)).toEqual([]);
  });

  it("resolves a module binding's attribute", () => {
    const bound: ResolvedBinding[] = [{ local: "sub", imported: null, target: "sub.py" }];
    const symbolsOf = { "sub.py": [{ ...span("f", "function", 1, 2), id: "sub.py#f" }] };
    expect(resolve([site("f", 2, "sub")], bound, symbolsOf)).toEqual([
      { from: "f.py#run", to: "sub.py#f", line: 2 },
    ]);
  });

  it("prefers the file's own top-level symbol over an import of the same name", () => {
    const bound: ResolvedBinding[] = [{ local: "save", imported: "save", target: "s.py" }];
    const symbolsOf = { "s.py": [{ ...span("save", "function", 1, 2), id: "s.py#save" }] };
    expect(resolve([site("save", 2)], bound, symbolsOf)).toEqual([
      { from: "f.py#run", to: "f.py#save", line: 2 },
    ]);
  });
});
