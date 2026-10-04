import { describe, expect, it } from "vitest";
import { ALIAS_MAX_LENGTH, aliasProblem, controlCharacters } from "./alias.ts";

describe("aliasProblem", () => {
  it("accepts ordinary names, routes and emoji up to 60 code points", () => {
    expect(aliasProblem("signal pipeline")).toBeNull();
    expect(aliasProblem("/api/signals")).toBeNull();
    expect(aliasProblem("a".repeat(ALIAS_MAX_LENGTH))).toBeNull();
    expect(aliasProblem("\u{1F600}".repeat(ALIAS_MAX_LENGTH))).toBeNull();
    // Persian needs ZWNJ and emoji sequences need ZWJ, so those two pass.
    expect(aliasProblem("می\u200Cخواهم")).toBeNull();
    expect(aliasProblem("\u{1F468}\u200D\u{1F469}")).toBeNull();
  });

  it("refuses blank, over-long and control-bearing aliases, naming the reason", () => {
    expect(aliasProblem("")).toBe("is empty");
    expect(aliasProblem(" \t ")).toBe("is empty");
    expect(aliasProblem("a".repeat(61))).toBe("is 61 characters; use at most 60");
    expect(aliasProblem("\u{1F600}".repeat(61))).toBe("is 61 characters; use at most 60");
    for (const [char, code] of [
      ["\u0000", "U+0000"],
      ["\n", "U+000A"],
      ["\u007F", "U+007F"],
      ["\u0085", "U+0085"],
      ["\u2028", "U+2028"],
      ["\u2029", "U+2029"],
      ["\u202A", "U+202A"],
      ["\u202E", "U+202E"],
      ["\u2066", "U+2066"],
      ["\u2069", "U+2069"],
      ["\uFEFF", "U+FEFF"],
    ] as const) {
      expect(aliasProblem(`a${char}b`)).toBe(`has a control or invisible character (${code})`);
    }
  });

  it("lists each distinct control character once, in order of appearance", () => {
    expect(controlCharacters("a\u202Eb\u0007c\u202E")).toEqual(["U+202E", "U+0007"]);
    expect(controlCharacters("plain")).toEqual([]);
  });
});
