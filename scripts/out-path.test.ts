import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInsideRepo } from "./out-path.ts";

describe("isInsideRepo", () => {
  let tmpDir: string;
  let repo: string;
  let repoOut: string;
  let elsewhere: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "out-path-test-"));
    repo = join(tmpDir, "repo");
    repoOut = join(tmpDir, "repo-out");
    elsewhere = join(tmpDir, "elsewhere");

    // Create directories
    mkdirSync(repo, { recursive: true });
    mkdirSync(repoOut, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("repo/i.json is inside", () => {
    expect(isInsideRepo(repo, join(repo, "i.json"))).toBe(true);
  });

  it("repo-out/i.json (sibling sharing a prefix) is outside", () => {
    expect(isInsideRepo(repo, join(repoOut, "i.json"))).toBe(false);
  });

  it("elsewhere/../repo/i.json is inside", () => {
    const repoParts = repo.split("/");
    const baseName = repoParts[repoParts.length - 1] ?? "repo";
    const out = join(elsewhere, "..", baseName, "i.json");
    expect(isInsideRepo(repo, out)).toBe(true);
  });

  it("symlink elsewhere/link -> repo with out = elsewhere/link/i.json is inside", () => {
    const link = join(elsewhere, "link");
    symlinkSync(repo, link);
    const out = join(link, "i.json");
    expect(isInsideRepo(repo, out)).toBe(true);
  });

  it("repo given as symlink path with out given as real path is inside", () => {
    const repoLink = join(elsewhere, "repo-link");
    symlinkSync(repo, repoLink);
    const out = join(repo, "i.json");
    expect(isInsideRepo(repoLink, out)).toBe(true);
  });

  it("out === repo is inside", () => {
    expect(isInsideRepo(repo, repo)).toBe(true);
  });

  it("nonexistent nested path under repo is inside", () => {
    const out = join(repo, "a", "b", "c.json");
    expect(isInsideRepo(repo, out)).toBe(true);
  });

  it("case variant is inside (on case-insensitive filesystems)", () => {
    const repoParts = repo.split("/");
    const baseName = repoParts[repoParts.length - 1];
    if (!baseName) return; // Guard against empty array

    const variantName = baseName.toUpperCase();

    // Only test if filesystem is case-insensitive
    if (baseName !== variantName && existsSync(join(tmpDir, variantName))) {
      const variant = join(tmpDir, variantName);
      expect(isInsideRepo(variant, join(repo, "i.json"))).toBe(true);
    }
  });
});
