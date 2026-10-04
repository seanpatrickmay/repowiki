import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOutDir } from "./out-dir.ts";

let root: string;
let repo: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "repowiki-outdir-")));
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveOutDir", () => {
  it("accepts a directory outside the repo, existing or not", () => {
    expect(resolveOutDir(repo, join(root, "wiki"))).toBe(join(root, "wiki"));
    expect(resolveOutDir(repo, join(root, "a", "b"))).toBe(join(root, "a", "b"));
  });

  it("accepts a sibling whose name starts with the repo's name", () => {
    expect(resolveOutDir(repo, join(root, "repo-wiki"))).toBe(join(root, "repo-wiki"));
  });

  it.each([
    ["the repo itself", () => repo],
    ["a directory inside it", () => join(repo, "src")],
    ["a new directory inside it", () => join(repo, "wiki", "data")],
    ["a path through ..", () => `${root}/x/../repo/wiki`],
  ])("refuses %s", (_name, out) => {
    expect(resolveOutDir(repo, out())).toBeNull();
  });

  it("refuses a symlink outside the repo that points into it", () => {
    symlinkSync(join(repo, "src"), join(root, "link"));
    expect(resolveOutDir(repo, join(root, "link", "wiki"))).toBeNull();
  });

  it("refuses a path under a file", () => {
    writeFileSync(join(root, "file.txt"), "x");
    expect(resolveOutDir(repo, join(root, "file.txt", "wiki"))).toBeNull();
  });

  it("refuses a dangling symlink, which mkdir would follow", () => {
    symlinkSync(join(repo, "gone"), join(root, "dangling"));
    expect(resolveOutDir(repo, join(root, "dangling"))).toBeNull();
  });

  it("refuses the rest of the git work tree when the repo is a subdirectory of it", () => {
    execFileSync("git", ["init", "--quiet", root]);
    expect(resolveOutDir(repo, join(root, "other"))).toBeNull();
    expect(resolveOutDir(repo, join(root, "..", `${basename(root)}-wiki`))).toBe(
      join(dirname(root), `${basename(root)}-wiki`),
    );
  });
});
