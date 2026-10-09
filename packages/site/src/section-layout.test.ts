import { describe, expect, it } from "vitest";
import {
  listHtml,
  ORPHAN_CHARS,
  PARAGRAPH_CHARS,
  paragraphGroups,
  paragraphsHtml,
} from "./section-layout.ts";

interface Fake {
  name: string;
  files: string[];
  length: number;
}
const claim = (name: string, files: string[] = [], length = 100): Fake => ({
  name,
  files,
  length,
});
const group = (claims: Fake[]): string[][] =>
  paragraphGroups(
    claims,
    (c) => new Set(c.files),
    (c) => c.length,
  ).map((g) => g.map((c) => c.name));

describe("paragraphGroups", () => {
  it("has the thresholds the controller tuned", () => {
    expect([PARAGRAPH_CHARS, ORPHAN_CHARS]).toEqual([550, 200]);
  });

  it("returns no groups for no claims, and one for a single claim", () => {
    expect(group([])).toEqual([]);
    expect(group([claim("a", ["x.ts"])])).toEqual([["a"]]);
  });

  it("breaks when the cited files change, once the group holds two claims", () => {
    const claims = [
      claim("a", ["x.ts"]),
      claim("b", ["x.ts"]),
      claim("c", ["y.ts"]),
      claim("d", ["y.ts"]),
    ];
    expect(group(claims)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("does not break before a second claim, even when its files differ", () => {
    expect(group([claim("a", ["x.ts"]), claim("b", ["y.ts"]), claim("c", ["y.ts"])])).toEqual([
      ["a", "b", "c"],
    ]);
  });

  it("keeps a group together while its files overlap or a claim cites none", () => {
    const claims = [
      claim("a", ["x.ts"]),
      claim("b", ["y.ts"]),
      claim("c", ["y.ts", "z.ts"]),
      claim("d", []),
      claim("e", ["x.ts"]),
    ];
    expect(group(claims)).toEqual([["a", "b", "c", "d", "e"]]);
  });

  it("breaks when the group's length reaches the limit", () => {
    const claims = [claim("a", [], 300), claim("b", [], 250), claim("c", [], 300)];
    expect(group(claims)).toEqual([["a", "b"], ["c"]]);
  });

  it("does not break just under the limit", () => {
    const claims = [claim("a", [], 300), claim("b", [], 249), claim("c", [], 300)];
    expect(group(claims)).toEqual([["a", "b", "c"]]);
  });

  it("applies only the length rule to claims with no code citations", () => {
    const claims = Array.from({ length: 12 }, (_, i) => claim(`n${i}`, [], 100));
    expect(group(claims).map((g) => g.length)).toEqual([6, 6]);
  });

  it("joins a short single last claim to the group before it", () => {
    const claims = [
      claim("a", ["x.ts"]),
      claim("b", ["x.ts"]),
      claim("c", ["y.ts"], ORPHAN_CHARS - 1),
    ];
    expect(group(claims)).toEqual([["a", "b", "c"]]);
  });

  it("leaves a last claim of the orphan length or more as its own paragraph", () => {
    const claims = [claim("a", ["x.ts"]), claim("b", ["x.ts"]), claim("c", ["y.ts"], ORPHAN_CHARS)];
    expect(group(claims)).toEqual([["a", "b"], ["c"]]);
  });

  it("keeps a short last claim in its group when no break came before it", () => {
    const claims = [claim("a", ["x.ts"]), claim("b", ["x.ts"]), claim("c", ["x.ts"], 10)];
    expect(group(claims)).toEqual([["a", "b", "c"]]);
  });

  it("keeps a lone short claim when no group comes before it", () => {
    expect(group([claim("a", [], 10)])).toEqual([["a"]]);
  });
});

describe("paragraphsHtml and listHtml", () => {
  it("joins the claims of a paragraph with a space, one <p> per group", () => {
    expect(paragraphsHtml([["<span>a</span>", "<span>b</span>"], ["<span>c</span>"]])).toBe(
      "<p><span>a</span> <span>b</span></p><p><span>c</span></p>",
    );
  });

  it("prints no paragraph for no groups", () => {
    expect(paragraphsHtml([])).toBe("");
  });

  it("makes one <li> per item in a claim-list", () => {
    expect(listHtml(["a", "b"])).toBe('<ul class="claim-list"><li>a</li><li>b</li></ul>');
  });
});
