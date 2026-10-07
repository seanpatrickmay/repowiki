import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRepo } from "./build-index.ts";
import { diffCommits, diffTrees, isAncestor } from "./diff.ts";
import { GitError, git, resolveCommit } from "./git.ts";
import { readHistory, readSources } from "./history.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let repo: TestRepo;
let dir: string;
beforeEach(() => {
  repo = createTestRepo();
  dir = mkdtempSync(join(tmpdir(), "repowiki-git-options-"));
});
afterEach(() => {
  repo.remove();
  rmSync(dir, { recursive: true, force: true });
});

const tree = (sha: string) =>
  git(repo.dir, ["rev-parse", `${sha}^{tree}`])
    .toString()
    .trim();

describe("diffTrees (spec v2 #9 §4)", () => {
  it("diffs a commit against a tree exactly as diffCommits diffs the two commits", () => {
    repo.write("a.py", "one\ntwo\nthree\n");
    repo.write("b.py", "b\n");
    const first = repo.commit("first");
    repo.write("a.py", "one\nTWO\nthree\nfour\n");
    repo.git("mv", "b.py", "c.py");
    const second = repo.commit("second");
    const expected = diffCommits(repo.dir, first, second);
    expect(expected.map((c) => c.status).sort()).toEqual(["modified", "renamed"]);
    expect(diffTrees(repo.dir, first, tree(second))).toEqual(expected);
    expect(diffTrees(repo.dir, tree(first), tree(second))).toEqual(expected);
    expect(diffTrees(repo.dir, first, tree(second), new Set(["a.py"]))).toEqual(
      expected.filter((c) => c.oldPath === "a.py"),
    );
  });

  it("refuses anything but a full object id, so no ref or option reaches git", () => {
    repo.write("a.py", "a\n");
    const sha = repo.commit("first");
    for (const bad of ["HEAD", "--output=/tmp/x", `${sha.slice(0, 39)}`, `${sha}^{tree}`])
      expect(() => diffTrees(repo.dir, sha, bad), bad).toThrow(GitError);
  });
});

describe("readSources with only", () => {
  it("reads just the paths asked for, at a commit or a tree", async () => {
    repo.write("a.py", "a\n");
    repo.write("b/c.py", "c\n");
    repo.write("d.py", "d\n");
    const sha = repo.commit("first");
    const only = new Set(["b/c.py", "d.py", "missing.py"]);
    const expected = new Map([
      ["b/c.py", "c\n"],
      ["d.py", "d\n"],
    ]);
    expect(await readSources(repo.dir, sha, 1000, { only })).toEqual(expected);
    expect(await readSources(repo.dir, tree(sha), 1000, { only })).toEqual(expected);
    expect((await readSources(repo.dir, sha, 1000)).size).toBe(3);
  });
});

describe("GitOptions.env", () => {
  it("reaches every git command an index, a history, sources and a diff run", async () => {
    repo.write("src/a.py", "def a():\n    return 1\n");
    const first = repo.commit("first");
    repo.write("src/a.py", "def a():\n    return 2\n");
    const second = repo.commit("second");
    const trace = join(dir, "trace.txt");
    const options = { env: { GIT_TRACE: trace } };
    expect(resolveCommit(repo.dir, "HEAD", options)).toBe(second);
    await indexRepo(repo.dir, second, { git: options });
    readHistory(repo.dir, second, options);
    await readSources(repo.dir, second, 1000, options);
    diffCommits(repo.dir, first, second, undefined, options);
    expect(isAncestor(repo.dir, first, second, options)).toBe(true);
    expect(existsSync(trace)).toBe(true);
    const commands = readFileSync(trace, "utf8");
    for (const command of ["rev-parse", "ls-tree", "cat-file", "log", "diff", "merge-base"])
      expect(commands, command).toContain(`git ${command}`);
  });
});
