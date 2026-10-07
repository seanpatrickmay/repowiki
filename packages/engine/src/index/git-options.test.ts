import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRepo } from "./build-index.ts";
import { diffCommits, diffTrees, isAncestor } from "./diff.ts";
import { GitError, GitTimeoutError, git, resolveCommit, streamBlobs } from "./git.ts";
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

/** A directory holding an executable `git` with `body` as its script. */
function fakeGit(name: string, body: string): string {
  const bin = join(dir, name);
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "git"), 0o755);
  return bin;
}

const realGit = () => execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

describe("GitOptions.env", () => {
  it("reaches every git command each call site runs: a call that drops it is untagged", async () => {
    repo.write("src/a.py", "def a():\n    return 1\n");
    const first = repo.commit("first");
    repo.write("src/a.py", "def a():\n    return 2\n");
    const second = repo.commit("second");
    const log = join(dir, "calls.txt");
    // Every git started from here goes through this wrapper; only GitOptions.env carries a tag.
    const bin = fakeGit(
      "bin",
      `printf '%s %s\\n' "\${REPOWIKI_TEST_TAG:-untagged}" "$3" >> '${log}'\nexec '${realGit()}' "$@"`,
    );
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? ""}`;
    const tag = (name: string) => ({ env: { REPOWIKI_TEST_TAG: name } });
    try {
      expect(resolveCommit(repo.dir, "HEAD", tag("resolve"))).toBe(second);
      await indexRepo(repo.dir, second, { git: tag("index") });
      readHistory(repo.dir, second, tag("history"));
      await readSources(repo.dir, second, 1000, tag("sources"));
      diffCommits(repo.dir, first, second, undefined, tag("diff"));
      expect(isAncestor(repo.dir, first, second, tag("ancestor"))).toBe(true);
    } finally {
      process.env.PATH = saved;
    }
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.filter((line) => line.startsWith("untagged"))).toEqual([]);
    const ran = (name: string) =>
      [
        ...new Set(calls.filter((l) => l.startsWith(`${name} `)).map((l) => l.split(" ")[1])),
      ].sort();
    expect(ran("resolve")).toEqual(["rev-parse"]);
    expect(ran("index")).toEqual(["cat-file", "log", "ls-tree", "rev-parse"]);
    expect(ran("history")).toEqual(["log"]);
    expect(ran("sources")).toEqual(["cat-file", "ls-tree"]);
    expect(ran("diff")).toContain("diff");
    expect(ran("ancestor")).toEqual(["merge-base"]);
  });
});

describe("GitOptions.timeoutMs", () => {
  it("stops a resolveCommit and a cat-file stream that run too long, naming the timeout", async () => {
    repo.write("a.py", "a\n");
    repo.commit("first");
    const oid = git(repo.dir, ["rev-parse", "HEAD:a.py"]).toString().trim();
    const slow = { env: { PATH: fakeGit("slow", "exec /bin/sleep 30") }, timeoutMs: 300 };
    const started = Date.now();
    expect(() => resolveCommit(repo.dir, "HEAD", slow)).toThrow(GitTimeoutError);
    expect(() => resolveCommit(repo.dir, "HEAD", slow)).toThrow(
      /^git rev-parse timed out after 300 ms in /,
    );
    const read = async () => {
      for await (const _blob of streamBlobs(repo.dir, [oid], 1000, slow));
    };
    await expect(read()).rejects.toThrow(GitTimeoutError);
    await expect(read()).rejects.toThrow(/^git cat-file timed out after 300 ms in /);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
