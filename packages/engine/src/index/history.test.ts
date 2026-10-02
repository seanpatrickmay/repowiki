import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError } from "./git.ts";
import { pullRequestOf, readHistory, readSources } from "./history.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
});
afterEach(() => repo.remove());

describe("pullRequestOf", () => {
  it.each([
    ["Merge pull request #117 from org/branch", 117],
    ["feat: add signals (#45)", 45],
    ["Merge branch 'dev' into feature", null],
    ["fix #12 in the parser", null],
  ])("reads %j as %j", (subject, pr) => {
    expect(pullRequestOf(subject)).toBe(pr);
  });
});

describe("readHistory", () => {
  it("lists every commit newest first with parents, dates, subjects and files", () => {
    repo.write("a.py", "x = 1\n");
    const first = repo.commit("feat: add a");
    repo.write("b.py", "y = 2\n");
    repo.write("a.py", "x = 3\n");
    const second = repo.commit("feat: add b (#4)");
    expect(readHistory(repo.dir, second)).toEqual([
      {
        sha: second,
        parents: [first],
        date: "2026-01-03T00:00:00Z",
        subject: "feat: add b (#4)",
        files: ["a.py", "b.py"],
        pr: 4,
      },
      {
        sha: first,
        parents: [],
        date: "2026-01-02T00:00:00Z",
        subject: "feat: add a",
        files: ["a.py"],
        pr: null,
      },
    ]);
  });

  it("gives a merged pull request's number to the commits it brought in", () => {
    repo.write("a.py", "x = 1\n");
    const base = repo.commit("init");
    repo.git("switch", "-q", "-c", "topic");
    repo.write("b.py", "y = 2\n");
    const topic = repo.commit("feat: b");
    repo.git("switch", "-q", "main");
    repo.write("c.py", "z = 3\n");
    const direct = repo.commit("chore: c");
    repo.git("merge", "-q", "--no-ff", "-m", "Merge pull request #9 from me/topic", "topic");
    const merge = repo.git("rev-parse", "HEAD");
    const prs = Object.fromEntries(readHistory(repo.dir, merge).map((c) => [c.sha, c.pr]));
    expect(prs).toEqual({ [merge]: 9, [topic]: 9, [direct]: null, [base]: null });
  });

  it("refuses anything but a 40-hex sha before it reaches git", () => {
    repo.write("a.py", "x = 1\n");
    repo.commit("init");
    for (const bad of ["HEAD", "main", "--all", "-n1", "abc123", "A".repeat(40)]) {
      expect(() => readHistory(repo.dir, bad)).toThrow(GitError);
    }
  });

  it("fails closed on a subject that forges the log's record separator", () => {
    repo.write("a.py", "x = 1\n");
    const sha = repo.commit("feat: a\x1e(#7)");
    expect(() => readHistory(repo.dir, sha)).toThrow(GitError);
  });
});

describe("readSources", () => {
  it("reads text files at the sha, never the working tree, and skips binary and large ones", () => {
    repo.write("a.py", "x = 1\n");
    repo.write("logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
    repo.write("big.txt", "z".repeat(500));
    const sha = repo.commit("files");
    repo.write("a.py", "uncommitted\n");
    expect([...readSources(repo.dir, sha, 100)]).toEqual([["a.py", "x = 1\n"]]);
  });

  it("refuses anything but a 40-hex sha before it reaches git", () => {
    repo.write("a.py", "x = 1\n");
    repo.commit("init");
    for (const bad of ["HEAD", "--help", "abc123"]) {
      expect(() => readSources(repo.dir, bad, 100)).toThrow(GitError);
    }
  });
});
