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
    ["feat: big (#123456789)", 123456789],
    ["feat: huge (#1234567890)", null],
    ["Merge pull request #99999999999999999999999 from org/x", null],
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

  it("refuses anything but a 40-hex sha before it reaches git", async () => {
    repo.write("a.py", "x = 1\n");
    repo.commit("init");
    for (const bad of ["HEAD", "main", "--all", "-n1", "abc123", "A".repeat(40)]) {
      expect(() => readHistory(repo.dir, bad)).toThrow(GitError);
    }
  });

  it("keeps a subject that forges a whole record as data", () => {
    repo.write("a.py", "x = 1\n");
    const base = repo.commit("init");
    repo.write("b.py", "y = 2\n");
    const forged = `feat: b\x1e${"a".repeat(40)}\x1f${base}\x1f2026-01-01T00:00:00Z\x1fMerge pull request #99 from evil/x`;
    const real = repo.commit(forged);
    const history = readHistory(repo.dir, real);
    expect(history.map((c) => c.sha)).toEqual([real, base]);
    expect(history[0]).toMatchObject({ subject: forged, files: ["b.py"], pr: null });
  });

  it("keeps a path that forges a record as data", () => {
    repo.write("a.py", "x = 1\n");
    const base = repo.commit("init");
    const forgedPath = `x\x1e${"a".repeat(40)}\x1f${base}\x1f2026-01-01T00:00:00Z\x1fMerge pull request #99`;
    repo.write(forgedPath, "y = 2\n");
    const real = repo.commit("feat: b");
    const history = readHistory(repo.dir, real);
    expect(history.map((c) => c.sha)).toEqual([real, base]);
    expect(history[0]).toMatchObject({ files: [forgedPath], pr: null });
  });

  it("reads the committer's own offset, an empty subject and a root commit with no files", () => {
    const empty = repo.commit("", "+0530");
    repo.write("a.py", "x = 1\n");
    const next = repo.commit("feat: a", "-0800");
    expect(readHistory(repo.dir, next)).toEqual([
      {
        sha: next,
        parents: [empty],
        date: "2026-01-02T16:00:00-08:00",
        subject: "feat: a",
        files: ["a.py"],
        pr: null,
      },
      {
        sha: empty,
        parents: [],
        date: "2026-01-02T05:30:00+05:30",
        subject: "",
        files: [],
        pr: null,
      },
    ]);
  });

  it("gives a nested merge's own commits the inner pull request's number", () => {
    repo.write("a.py", "x = 1\n");
    const base = repo.commit("init");
    repo.git("switch", "-q", "-c", "outer");
    repo.write("o.py", "o = 1\n");
    const outerWork = repo.commit("feat: outer work");
    repo.git("switch", "-q", "-c", "inner");
    repo.write("i.py", "i = 1\n");
    const innerWork = repo.commit("feat: inner work");
    repo.git("switch", "-q", "outer");
    repo.write("o2.py", "o = 2\n");
    const outerMore = repo.commit("feat: more outer work");
    repo.git("merge", "-q", "--no-ff", "-m", "Merge pull request #2 from me/inner", "inner");
    const innerMerge = repo.git("rev-parse", "HEAD");
    repo.git("switch", "-q", "main");
    repo.git("merge", "-q", "--no-ff", "-m", "Merge pull request #1 from me/outer", "outer");
    const outerMerge = repo.git("rev-parse", "HEAD");
    const prs = Object.fromEntries(readHistory(repo.dir, outerMerge).map((c) => [c.sha, c.pr]));
    expect(prs).toEqual({
      [outerMerge]: 1,
      [innerMerge]: 2,
      [innerWork]: 2,
      [outerMore]: 1,
      [outerWork]: 1,
      [base]: null,
    });
  });

  it("gives an octopus merge's number to everything every branch brought in", () => {
    repo.write("a.py", "x = 1\n");
    const base = repo.commit("init");
    repo.git("switch", "-q", "-c", "one");
    repo.write("one.py", "1\n");
    const one = repo.commit("feat: one");
    repo.git("switch", "-q", "main");
    repo.git("switch", "-q", "-c", "two");
    repo.write("two.py", "2\n");
    const two = repo.commit("feat: two");
    repo.git("switch", "-q", "main");
    repo.git("merge", "-q", "--no-ff", "-m", "Merge pull request #5 from me/both", "one", "two");
    const merge = repo.git("rev-parse", "HEAD");
    expect(repo.git("rev-list", "--parents", "-n1", merge).split(" ")).toHaveLength(4);
    const prs = Object.fromEntries(readHistory(repo.dir, merge).map((c) => [c.sha, c.pr]));
    expect(prs).toEqual({ [merge]: 5, [one]: 5, [two]: 5, [base]: null });
  });

  it("relabels nothing when a merge's second parent is already reachable from its first", () => {
    repo.write("a.py", "x = 1\n");
    const base = repo.commit("init");
    repo.write("b.py", "y = 2\n");
    const second = repo.commit("feat: b");
    const tree = repo.git("rev-parse", "HEAD^{tree}");
    const merge = repo.git(
      "commit-tree",
      tree,
      "-p",
      second,
      "-p",
      base,
      "-m",
      "Merge pull request #3 from me/old",
    );
    const prs = Object.fromEntries(readHistory(repo.dir, merge).map((c) => [c.sha, c.pr]));
    expect(prs).toEqual({ [merge]: 3, [second]: null, [base]: null });
  });
});

describe("readSources", () => {
  it("reads text files at the sha, never the working tree, and skips binary and large ones", async () => {
    repo.write("a.py", "x = 1\n");
    repo.write("logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
    repo.write("big.txt", "z".repeat(500));
    const sha = repo.commit("files");
    repo.write("a.py", "uncommitted\n");
    expect([...(await readSources(repo.dir, sha, 100))]).toEqual([["a.py", "x = 1\n"]]);
  });

  it("refuses anything but a 40-hex sha before it reaches git", async () => {
    repo.write("a.py", "x = 1\n");
    repo.commit("init");
    for (const bad of ["HEAD", "--help", "abc123"]) {
      await expect(readSources(repo.dir, bad, 100)).rejects.toThrow(GitError);
    }
  });
});
