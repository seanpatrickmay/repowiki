import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffCommits, isAncestor, parseHunks, reachableCommits } from "./diff.ts";
import { GitError } from "./git.ts";
import { readHistory } from "./history.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
});
afterEach(() => repo.remove());

const lines = (...xs: string[]) => `${xs.join("\n")}\n`;

describe("parseHunks", () => {
  it("reads git's hunk headers, a missing count meaning one line", () => {
    const diff = [
      "diff --git a/x b/x",
      "@@ -3 +3 @@",
      "-a",
      "+b",
      "@@ -0,0 +1,2 @@",
      "@@ -7,2 +8,0 @@ def f():",
    ].join("\n");
    expect(parseHunks(diff)).toEqual({
      hunks: [
        { oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 },
        { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
        { oldStart: 7, oldCount: 2, newStart: 8, newCount: 0 },
      ],
      binary: false,
    });
    expect(parseHunks("Binary files a/x and b/x differ\n")).toEqual({ hunks: [], binary: true });
  });
});

describe("diffCommits", () => {
  it("gives a modified file's hunks, and an added and a deleted file", () => {
    repo.write("a.py", lines("one", "two", "three", "four"));
    repo.write("gone.py", "x = 1\n");
    const from = repo.commit("first");
    repo.write("a.py", lines("zero", "one", "two", "THREE", "four"));
    repo.git("rm", "-q", "gone.py");
    repo.write("new.py", "y = 2\n");
    const to = repo.commit("second");
    expect(diffCommits(repo.dir, from, to)).toEqual([
      {
        status: "modified",
        oldPath: "a.py",
        newPath: "a.py",
        hunks: [
          { oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 },
          { oldStart: 3, oldCount: 1, newStart: 4, newCount: 1 },
        ],
        binary: false,
      },
      { status: "deleted", oldPath: "gone.py", newPath: null, hunks: [], binary: false },
      { status: "added", oldPath: null, newPath: "new.py", hunks: [], binary: false },
    ]);
  });

  it("follows a rename with an edit, and keeps a path with spaces and a newline whole", () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    repo.write("old name.py", lines(...body));
    const from = repo.commit("first");
    repo.git("rm", "-q", "old name.py");
    repo.write("src/new\nname.py", lines(...body, "line 21"));
    const to = repo.commit("rename");
    expect(diffCommits(repo.dir, from, to)).toEqual([
      {
        status: "renamed",
        oldPath: "old name.py",
        newPath: "src/new\nname.py",
        hunks: [{ oldStart: 20, oldCount: 0, newStart: 21, newCount: 1 }],
        binary: false,
      },
    ]);
  });

  it("marks a changed binary file, which has no hunks", () => {
    repo.write("logo.png", Buffer.from([0, 1, 2, 3]));
    const from = repo.commit("first");
    repo.write("logo.png", Buffer.from([0, 9, 9, 3]));
    const to = repo.commit("second");
    expect(diffCommits(repo.dir, from, to)).toEqual([
      { status: "modified", oldPath: "logo.png", newPath: "logo.png", hunks: [], binary: true },
    ]);
  });

  it("is empty between a commit and itself, or across an empty commit", () => {
    repo.write("a.py", "x = 1\n");
    const from = repo.commit("first");
    const to = repo.commit("empty");
    expect(diffCommits(repo.dir, from, from)).toEqual([]);
    expect(diffCommits(repo.dir, from, to)).toEqual([]);
  });

  it("refuses anything but a full sha", () => {
    repo.write("a.py", "x = 1\n");
    const sha = repo.commit("first");
    expect(() => diffCommits(repo.dir, "HEAD", sha)).toThrow(GitError);
    expect(() => diffCommits(repo.dir, sha, "--output=x")).toThrow(GitError);
  });
});

describe("ancestry", () => {
  it("knows which commits come before which, and what a commit reaches", () => {
    repo.write("a.py", "x = 1\n");
    const base = repo.commit("base");
    repo.git("switch", "-q", "-c", "topic");
    repo.write("b.py", "y = 1\n");
    const topic = repo.commit("topic");
    repo.git("switch", "-q", "main");
    const merge = repo.merge("topic", "Merge pull request #5 from me/topic");
    expect(isAncestor(repo.dir, base, merge)).toBe(true);
    expect(isAncestor(repo.dir, merge, base)).toBe(false);
    expect(isAncestor(repo.dir, base, base)).toBe(true);
    expect(reachableCommits(repo.dir, topic)).toEqual(new Set([base, topic]));
    const history = readHistory(repo.dir, merge);
    expect(history[0]).toMatchObject({ sha: merge, parents: [base, topic], pr: 5 });
    expect(history[0]?.date).toBe("2026-01-04T00:00:00Z");
  });
});
