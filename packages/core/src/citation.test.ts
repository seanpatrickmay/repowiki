import { describe, expect, it } from "vitest";
import { Citation } from "./citation.ts";
import { codeCitation, commitCitation } from "./test-fixtures.ts";

describe("Citation", () => {
  it("accepts code and commit citations", () => {
    expect(Citation.parse(codeCitation())).toEqual(codeCitation());
    expect(Citation.parse(commitCitation())).toEqual(commitCitation());
  });

  it("rejects an end line before the start line", () => {
    expect(Citation.safeParse(codeCitation({ startLine: 20, endLine: 10 })).success).toBe(false);
  });

  it("rejects line 0", () => {
    expect(Citation.safeParse(codeCitation({ startLine: 0 })).success).toBe(false);
  });

  it("rejects abbreviated shas", () => {
    expect(Citation.safeParse(codeCitation({ sha: "abc1234" })).success).toBe(false);
  });

  it.each([
    "/etc/passwd",
    "../outside.py",
    "src/../../x.py",
    "src\\win.py",
    "src//double.py",
    "./src/a.py",
  ])("rejects path %s that is not repo-relative POSIX", (path) => {
    expect(Citation.safeParse(codeCitation({ path })).success).toBe(false);
  });

  it("rejects unknown citation kinds", () => {
    expect(Citation.safeParse({ ...commitCitation(), kind: "url" }).success).toBe(false);
  });
});
