import { describe, expect, it } from "vitest";
import { computeCoChange } from "./cochange.ts";

const present = new Set(["a.py", "b.py", "c.py"]);

describe("computeCoChange", () => {
  it("counts files changed together, as sorted unordered pairs", () => {
    const result = computeCoChange([["b.py", "a.py"], ["a.py", "b.py", "c.py"], ["c.py"]], present);
    expect(result.pairs).toEqual([
      { a: "a.py", b: "b.py", count: 2 },
      { a: "a.py", b: "c.py", count: 1 },
      { a: "b.py", b: "c.py", count: 1 },
    ]);
    expect(result.fileCommits).toEqual({ "a.py": 2, "b.py": 2, "c.py": 2 });
    expect(result.commitsConsidered).toBe(3);
  });

  it("ignores files that no longer exist at the indexed commit", () => {
    const result = computeCoChange([["a.py", "deleted.py"]], present);
    expect(result.pairs).toEqual([]);
    expect(result.fileCommits).toEqual({ "a.py": 1 });
  });

  it("skips commits that touch more files than the limit", () => {
    const sweep = ["a.py", "b.py", "c.py"];
    const result = computeCoChange([sweep, ["a.py", "b.py"]], present, 2);
    expect(result.commitsSkipped).toBe(1);
    expect(result.commitsConsidered).toBe(1);
    expect(result.pairs).toEqual([{ a: "a.py", b: "b.py", count: 1 }]);
  });

  it("counts a file listed twice in one commit once", () => {
    const result = computeCoChange([["a.py", "a.py", "b.py"]], present);
    expect(result.fileCommits).toEqual({ "a.py": 1, "b.py": 1 });
    expect(result.pairs).toEqual([{ a: "a.py", b: "b.py", count: 1 }]);
  });
});
