import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOutPath } from "./out-path.ts";

describe("resolveOutPath", () => {
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

  it("repo/i.json returns canonical path (inside)", () => {
    const result = resolveOutPath(repo, join(repo, "i.json"));
    expect(result).toBeNull();
  });

  it("repo-out/i.json returns canonical path (outside)", () => {
    const result = resolveOutPath(repo, join(repoOut, "i.json"));
    expect(result).not.toBeNull();
    expect(result).toBe(join(realpathSync.native(repoOut), "i.json"));
  });

  it("relative path: . with index.json returns null (inside)", () => {
    process.chdir(repo);
    expect(resolveOutPath(".", "index.json")).toBeNull();
  });

  it("relative path: . with sub/x.json (existing sub) returns null (inside)", () => {
    mkdirSync(join(repo, "sub"));
    process.chdir(repo);
    expect(resolveOutPath(".", "sub/x.json")).toBeNull();
  });

  it("relative path: . with sub/x.json (nonexistent sub) returns null (inside, fail closed)", () => {
    process.chdir(repo);
    expect(resolveOutPath(".", "sub/x.json")).toBeNull();
  });

  it("raw string ../repo/i.json returns null (inside)", () => {
    const out = `${elsewhere}/../${basename(repo)}/i.json`;
    expect(resolveOutPath(repo, out)).toBeNull();
  });

  it("symlink elsewhere/link -> repo with out = elsewhere/link/i.json returns null (inside)", () => {
    const link = join(elsewhere, "link");
    symlinkSync(repo, link);
    const out = join(link, "i.json");
    expect(resolveOutPath(repo, out)).toBeNull();
  });

  it("dangling symlink as out returns null (fail closed)", () => {
    const dangling = join(elsewhere, "dangling");
    symlinkSync(join(repo, "new.json"), dangling);
    // Remove the target to make it dangling
    rmSync(join(repo, "new.json"), { force: true });
    expect(resolveOutPath(repo, dangling)).toBeNull();
  });

  it("dangling symlink as ancestor returns null (fail closed)", () => {
    const dl = join(elsewhere, "dl");
    symlinkSync(join(repo, "missingdir"), dl);
    const out = join(dl, "x.json");
    expect(resolveOutPath(repo, out)).toBeNull();
  });

  it("repo given as symlink with out as real path returns null (inside)", () => {
    const repoLink = join(elsewhere, "repo-link");
    symlinkSync(repo, repoLink);
    const out = join(repo, "i.json");
    expect(resolveOutPath(repoLink, out)).toBeNull();
  });

  it("out === repo returns null (inside)", () => {
    expect(resolveOutPath(repo, repo)).toBeNull();
  });

  it("nonexistent nested path under repo returns null (inside)", () => {
    const out = join(repo, "a", "b", "c.json");
    expect(resolveOutPath(repo, out)).toBeNull();
  });

  it("nonexistent repo returns null (fail closed)", () => {
    const fakeRepo = join(tmpDir, "nonexistent-repo");
    expect(resolveOutPath(fakeRepo, join(fakeRepo, "i.json"))).toBeNull();
  });

  it("repo/..hidden.json returns null (inside, not outside)", () => {
    const out = join(repo, "..hidden.json");
    expect(resolveOutPath(repo, out)).toBeNull();
  });

  it("elsewhere/link/../x.json (link -> repo/sub) returns canonical path (outside)", () => {
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const link = join(elsewhere, "link");
    symlinkSync(sub, link);
    // Build path using string concatenation to avoid join() normalization
    const out = `${link}/../x.json`;
    const result = resolveOutPath(repo, out);
    // Path should be outside and equal to canonical elsewhere/x.json
    expect(result).not.toBeNull();
    expect(result).toBe(join(realpathSync.native(elsewhere), "x.json"));
  });

  it("pre-existing regular file inside repo returns null (refuse)", () => {
    const file = join(repo, "existing.json");
    writeFileSync(file, "{}");
    expect(resolveOutPath(repo, file)).toBeNull();
  });

  it("pre-existing regular file outside repo returns canonical path", () => {
    const file = join(repoOut, "existing.json");
    writeFileSync(file, "{}");
    const result = resolveOutPath(repo, file);
    expect(result).not.toBeNull();
    expect(result).toBe(realpathSync.native(file));
  });

  it("plain elsewhere/ok.json returns canonical path (outside)", () => {
    const out = join(elsewhere, "ok.json");
    const result = resolveOutPath(repo, out);
    expect(result).not.toBeNull();
    expect(result).toBe(join(realpathSync.native(elsewhere), "ok.json"));
  });

  it("case variant is inside (on case-insensitive filesystems)", () => {
    const repoParts = repo.split("/");
    const baseName = repoParts[repoParts.length - 1];
    if (!baseName) return;
    const variantName = baseName.toUpperCase();
    // Skip if filesystem is case-sensitive
    if (baseName === variantName || !existsSync(join(tmpDir, variantName))) {
      return;
    }
    const variant = join(tmpDir, variantName);
    expect(resolveOutPath(variant, join(repo, "i.json"))).toBeNull();
  });
});
