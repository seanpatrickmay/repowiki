import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInsideRepo } from "./out-path.ts";

describe("isInsideRepo", () => {
  let tmpDir: string;
  let repo: string;
  let repoOut: string;
  let elsewhere: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "out-path-test-"));
    repo = join(tmpDir, "repo");
    repoOut = join(tmpDir, "repo-out");
    elsewhere = join(tmpDir, "elsewhere");
    originalCwd = process.cwd();

    // Create directories
    mkdirSync(repo, { recursive: true });
    mkdirSync(repoOut, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("repo/i.json is inside", () => {
    expect(isInsideRepo(repo, join(repo, "i.json"))).toBe(true);
  });

  it("repo-out/i.json (sibling) is outside", () => {
    expect(isInsideRepo(repo, join(repoOut, "i.json"))).toBe(false);
  });

  it("relative path: . with index.json in repo is inside", () => {
    process.chdir(repo);
    expect(isInsideRepo(".", "index.json")).toBe(true);
  });

  it("relative path: . with sub/x.json (existing sub) is inside", () => {
    mkdirSync(join(repo, "sub"));
    process.chdir(repo);
    expect(isInsideRepo(".", "sub/x.json")).toBe(true);
  });

  it("relative path: . with sub/x.json (nonexistent sub) is inside (fail closed)", () => {
    process.chdir(repo);
    expect(isInsideRepo(".", "sub/x.json")).toBe(true);
  });

  it("raw string ../repo/i.json is inside", () => {
    const out = `${elsewhere}/../${basename(repo)}/i.json`;
    expect(isInsideRepo(repo, out)).toBe(true);
  });

  it("symlink elsewhere/link -> repo with out = elsewhere/link/i.json is inside", () => {
    const link = join(elsewhere, "link");
    symlinkSync(repo, link);
    const out = join(link, "i.json");
    expect(isInsideRepo(repo, out)).toBe(true);
  });

  it("dangling symlink as out is inside (fail closed)", () => {
    const dangling = join(elsewhere, "dangling");
    symlinkSync(join(repo, "new.json"), dangling);
    // Remove the target to make it dangling
    rmSync(join(repo, "new.json"), { force: true });
    expect(isInsideRepo(repo, dangling)).toBe(true);
  });

  it("dangling symlink as ancestor is inside (fail closed)", () => {
    const dl = join(elsewhere, "dl");
    symlinkSync(join(repo, "missingdir"), dl);
    const out = join(dl, "x.json");
    expect(isInsideRepo(repo, out)).toBe(true);
  });

  it("repo given as symlink with out as real path is inside", () => {
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

  it("nonexistent repo is inside (fail closed)", () => {
    const fakeRepo = join(tmpDir, "nonexistent-repo");
    expect(isInsideRepo(fakeRepo, join(fakeRepo, "i.json"))).toBe(true);
  });

  it("case variant is inside (on case-insensitive filesystems)", () => {
    const repoParts = repo.split("/");
    const baseName = repoParts[repoParts.length - 1];
    if (!baseName) return;
    const variantName = baseName.toUpperCase();
    // Only test if filesystem is case-insensitive
    if (baseName === variantName || !existsSync(join(tmpDir, variantName))) {
      return; // Filesystem is case-sensitive, skip
    }
    const variant = join(tmpDir, variantName);
    expect(isInsideRepo(variant, join(repo, "i.json"))).toBe(true);
  });
});
