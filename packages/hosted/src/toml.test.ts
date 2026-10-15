import { describe, expect, it } from "vitest";
import { tomlTables } from "./toml.ts";

describe("tomlTables", () => {
  it("reads headers, quoted keys, multi-line strings and nested values", () => {
    const tables = tomlTables(`top = 1
[a."b.c"]
s = """two
lines"""
l = 'lit'
arr = [[1, 2], ["x"], { k = "v" }]
[[bin]]
name = "x"
`);
    expect(tables?.map((t) => [t.path, t.entries.map((e) => e.key.join("."))])).toEqual([
      [[], ["top"]],
      [
        ["a", "b.c"],
        ["s", "l", "arr"],
      ],
      [["bin"], ["name"]],
    ]);
  });
});

describe("tomlTables on malformed input", () => {
  it("gives null for unclosed headers, strings, arrays and inline tables", () => {
    for (const text of [
      "[a",
      'x = "open',
      "x = 'open\n'",
      "x = [1, 2",
      'x = { a = "b"',
      'x = """never closed',
      "x = 1 trailing",
      "= 1",
    ]) {
      expect(tomlTables(text)).toBeNull();
    }
  });
});
