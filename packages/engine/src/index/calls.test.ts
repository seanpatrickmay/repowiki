import { beforeAll, describe, expect, it } from "vitest";
import { extractBindings, extractCalls } from "./calls.ts";
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
});
