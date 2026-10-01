import { describe, expect, it } from "vitest";
import { memberId, parseMemberId } from "./member-id.ts";

describe("memberId", () => {
  it.each([
    ["src/a.py", undefined, "src/a.py"],
    ["src/a.py", "Thing.save", "src/a.py#Thing.save"],
    ["docs/C#.md", undefined, "docs/C%23.md"],
    ["docs/100%.md", "x", "docs/100%25.md#x"],
    ["src/a.ts", "Cls.#secret", "src/a.ts#Cls.#secret"],
  ])("encodes %j + %j as %j", (path, symbol, id) => {
    expect(memberId(path, symbol)).toBe(id);
  });

  it.each([
    ["docs/C#.md", null],
    ["docs/%23 and %25.md", "f"],
    ["src/a.ts", "Cls.#secret"],
    ["a%2523b", null],
  ])("round-trips %j + %j", (path, symbol) => {
    expect(parseMemberId(memberId(path, symbol ?? undefined))).toEqual({ path, symbol });
  });
});

describe("parseMemberId", () => {
  it.each(["src/a.py#", "docs/C%2.md", "a%zz", "100%.md"])("rejects %j", (id) => {
    expect(parseMemberId(id)).toBeNull();
  });
});
