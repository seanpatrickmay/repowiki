import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { indexRepo } from "./build-index.ts";
import { extractCalls } from "./calls.ts";
import { createSourceParser, languageForPath, type SourceParser } from "./languages.ts";
import { extractSymbols } from "./symbols.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let parser: SourceParser;
beforeAll(async () => {
  parser = await createSourceParser();
});

function read<T>(source: string, fn: (parsed: ReturnType<SourceParser["parse"]>) => T): T {
  const parsed = parser.parse("rust", source);
  try {
    return fn(parsed);
  } finally {
    parsed.dispose();
  }
}
const symbolsOf = (source: string) =>
  read(source, (p) => extractSymbols("rust", p.root, parser)).map(
    (s) => `${s.kind} ${s.qualifiedName} ${s.startLine}-${s.endLine}${s.exported ? " pub" : ""}`,
  );

describe("rust language", () => {
  it("maps .rs files to rust", () => {
    expect(languageForPath("engine/src/lib.rs")).toBe("rust");
    expect(languageForPath("README.rst")).toBeNull();
  });

  it("does not report valid Rust with macros, attributes, lifetimes, generics, async, closures and ? as an error", () => {
    const source = [
      "#![allow(dead_code)]",
      "use std::collections::HashMap;",
      "",
      "/// Doc comment.",
      "#[derive(Debug, Clone)]",
      "pub struct Holder<'a, T: Clone + 'a>",
      "where",
      "    T: Default,",
      "{",
      "    items: &'a [T],",
      "}",
      "",
      '#[cfg(feature = "net")]',
      "pub async fn fetch<'a>(map: &'a HashMap<String, u8>) -> Result<u8, String> {",
      '    let v = map.get("k").copied().ok_or_else(|| format!("missing {}", 1))?;',
      "    let add = move |x: u8| -> u8 { x + v };",
      "    let r#type = vec![1u8, 2, 3];",
      '    let _s = r#"raw "string""#;',
      "    'outer: loop {",
      "        break 'outer;",
      "    }",
      "    let _ = async move { 1 }.await;",
      "    let Some(x) = Some(1u8) else { return Err(String::new()) };",
      '    assert_eq!(square!(2), 4, "math {}", "works");',
      "    Ok(add(x))",
      "}",
      "",
      "macro_rules! square {",
      "    ($x:expr) => {",
      "        $x * $x",
      "    };",
      "}",
      "",
      "unsafe impl<T: Clone + Default + Send> Send for Holder<'_, T> {}",
      "",
      "fn dynamic(f: Box<dyn Fn(u8) -> u8 + Send + 'static>) -> impl Iterator<Item = u8> {",
      "    (0..3).map(move |i| f(i)).collect::<Vec<_>>().into_iter()",
      "}",
    ].join("\n");
    expect(read(source, (p) => p.hasError)).toBe(false);
  });

  it("reports broken Rust as an error", () => {
    expect(read("fn broken( {\n", (p) => p.hasError)).toBe(true);
  });
});

describe("extractSymbols (rust)", () => {
  it("finds items, impl and trait methods as Type::method, and inline module members", () => {
    const source = [
      "#[derive(Debug)]", // 1
      "pub struct Board {",
      "    tiles: u8,",
      "}",
      "union Bits { a: u32 }", // 5
      "pub(crate) enum Phase { Setup }",
      "pub trait Bot {",
      "    fn act(&self) -> u8;",
      '    fn name(&self) -> &str { "bot" }',
      "}", // 10
      "impl Board {",
      "    pub fn new() -> Self { Board { tiles: 0 } }",
      "    fn helper(&self) {}",
      "}",
      "impl Bot for Board {", // 15
      "    fn act(&self) -> u8 { 1 }",
      "}",
      "impl<T> From<T> for Wrapper<T> { fn from(t: T) -> Self { Wrapper(t) } }",
      "pub type Score = i32;",
      "const MAX: u8 = 4;", // 20
      'pub static NAME: &str = "x";',
      "pub fn run() { fn inner() {} }",
      "#[macro_export]",
      "macro_rules! square { ($x:expr) => { $x * $x }; }",
      "macro_rules! local { () => {}; }", // 25
      "mod outer;",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn works() {}", // 30
      "    struct Fake;",
      "    impl Fake { pub fn go(&self) {} }",
      "}",
    ].join("\n");
    expect(symbolsOf(source)).toEqual([
      "class Board 1-4 pub",
      "class Bits 5-5",
      "enum Phase 6-6 pub",
      "interface Bot 7-10 pub",
      "method Bot::act 8-8 pub",
      "method Bot::name 9-9 pub",
      "method Board::new 12-12 pub",
      "method Board::helper 13-13",
      "method Board::act 16-16 pub",
      "method Wrapper::from 18-18 pub",
      "type Score 19-19 pub",
      "variable MAX 20-20",
      "variable NAME 21-21 pub",
      "function run 22-22 pub",
      "macro square! 23-24 pub",
      "macro local! 25-25",
      "module tests 27-33",
      "function tests::works 29-30",
      "class tests::Fake 31-31",
      "method tests::Fake::go 32-32 pub",
    ]);
  });

  it("recovers the items after a broken one", () => {
    const source = ["fn broken( {", "", "pub fn after() {}", "", "struct Kept;"].join("\n");
    expect(symbolsOf(source)).toEqual(["function after 3-3 pub", "class Kept 5-5"]);
  });
});

describe("extractCalls (rust)", () => {
  it("records plain, path, Self, self, method, generic, macro and struct-literal calls", () => {
    const source = [
      "fn f(x: Thing) {",
      "    g(1);",
      "    Board::new();",
      "    board::place();",
      "    Self::make();",
      "    self.tick();",
      "    x.go();",
      "    parse::<u8>();",
      "    Vec::<u8>::new();",
      "    square!(2);",
      "    Point { x: 1 };",
      "    a::b::c();",
      "    x.y.z();",
      "    self::here();",
      "    super::up();",
      "    let h = |v| v + 1;",
      "    h(2);",
      "}",
    ].join("\n");
    expect(read(source, (p) => extractCalls("rust", p.root))).toEqual([
      { name: "g", receiver: null, line: 2 },
      { name: "new", receiver: "Board", line: 3 },
      { name: "place", receiver: "board", line: 4 },
      { name: "make", receiver: "self", line: 5 },
      { name: "tick", receiver: "self", line: 6 },
      { name: "go", receiver: "x", line: 7 },
      { name: "parse", receiver: null, line: 8 },
      { name: "new", receiver: "Vec", line: 9 },
      { name: "square!", receiver: null, line: 10 },
      { name: "Point", receiver: null, line: 11 },
      { name: "here", receiver: null, line: 14 },
      { name: "up", receiver: "super", line: 15 },
      { name: "h", receiver: null, line: 17 },
    ]);
  });
});

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
});
afterEach(() => repo.remove());

describe("indexRepo on Rust", () => {
  it("indexes Rust symbols and resolves same-file calls", async () => {
    repo.write(
      "src/board.rs",
      [
        "pub struct Board { tiles: u8 }", // 1
        "",
        "impl Board {",
        "    pub fn new() -> Self {",
        "        Self::empty()", // 5
        "    }",
        "    fn empty() -> Self {",
        "        Board { tiles: count() }",
        "    }",
        "    pub fn tick(&mut self) {", // 10
        "        self.reset();",
        "        log!(1);",
        "    }",
        "    fn reset(&mut self) {}",
        "}", // 15
        "",
        "fn count() -> u8 { 0 }",
        "",
        "macro_rules! log { ($x:expr) => {}; }",
        "", // 20
        "#[cfg(test)]",
        "mod tests {",
        "    fn fixture() -> Board { Board::new() }",
        "    #[test]",
        "    fn ticks() { fixture().tick(); helper(); super::count(); }", // 25
        "    fn helper() {}",
        "}",
      ].join("\n"),
    );
    repo.commit("rust");
    const index = await indexRepo(repo.dir, "HEAD");
    const file = index.files.find((f) => f.path === "src/board.rs");
    expect(file?.language).toBe("rust");
    expect(file?.parseError).toBe(false);
    expect(file?.symbols.map((s) => s.id)).toEqual([
      "src/board.rs#Board",
      "src/board.rs#Board::new",
      "src/board.rs#Board::empty",
      "src/board.rs#Board::tick",
      "src/board.rs#Board::reset",
      "src/board.rs#count",
      "src/board.rs#log!",
      "src/board.rs#tests",
      "src/board.rs#tests::fixture",
      "src/board.rs#tests::ticks",
      "src/board.rs#tests::helper",
    ]);
    expect(index.calls).toEqual([
      { from: "src/board.rs#Board::empty", to: "src/board.rs#Board", line: 8 },
      { from: "src/board.rs#Board::empty", to: "src/board.rs#count", line: 8 },
      { from: "src/board.rs#Board::new", to: "src/board.rs#Board::empty", line: 5 },
      { from: "src/board.rs#Board::tick", to: "src/board.rs#Board::reset", line: 11 },
      { from: "src/board.rs#Board::tick", to: "src/board.rs#log!", line: 12 },
      { from: "src/board.rs#tests::fixture", to: "src/board.rs#Board::new", line: 23 },
      { from: "src/board.rs#tests::ticks", to: "src/board.rs#count", line: 25 },
      { from: "src/board.rs#tests::ticks", to: "src/board.rs#tests::fixture", line: 25 },
      { from: "src/board.rs#tests::ticks", to: "src/board.rs#tests::helper", line: 25 },
    ]);
  });
});
