import { createTestRepo, type TestRepo } from "@repowiki/engine/test-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexReport, MAX_LISTED_PATHS } from "./index-report.ts";

let repo: TestRepo;
let sha: string;
beforeEach(() => {
  repo = createTestRepo();
  repo.write("src/a.py", "import numpy\n");
  sha = repo.commit("one file");
});
afterEach(() => repo.remove());

describe("the index child's report (review I1, I3)", () => {
  it("still reports the index when detection throws, with one warning", async () => {
    const warnings: string[] = [];
    const report = await indexReport({
      repo: repo.dir,
      sha,
      detect: async () => {
        throw new RangeError("Maximum call stack size exceeded");
      },
      warn: (line) => warnings.push(line),
    });
    expect(report.files).toEqual([{ language: "python", loc: 1, skipped: null }]);
    expect(report.indexed).toBe(1);
    expect(report).toMatchObject({ technologies: [], unparsed: [], tooLarge: [] });
    expect(warnings).toEqual(["technology detection failed: RangeError"]);
  }, 30_000);

  it("lists at most 100 unread paths of each kind, none over 1,000 characters", async () => {
    const oversized = Array.from({ length: 1100 }, (_, i) => `p${i}/package.json`);
    const report = await indexReport({
      repo: repo.dir,
      sha,
      detect: async () => ({
        technologies: [],
        unparsed: [`${"a/".repeat(500)}Cargo.toml`, "Cargo.toml"],
        tooLarge: oversized,
      }),
    });
    expect(report.unparsed).toEqual(["Cargo.toml"]);
    expect(report.tooLarge).toHaveLength(MAX_LISTED_PATHS);
    expect(MAX_LISTED_PATHS).toBe(100);
  }, 30_000);
});
