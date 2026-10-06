import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAuthorship } from "./authorship.ts";
import { readHistory } from "./history.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

const ADA = { name: "Ada Lovelace", email: "ada@example.com" };
const BOB = { name: "bob", email: "12345+bob-dev@users.noreply.github.com" };

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
});
afterEach(() => repo.remove());

describe("readAuthorship (spec v2 #6 R5, R6, R20)", () => {
  it("gives each commit its raw author, author date in the author's offset, and numstat", () => {
    repo.write("a.py", "x = 1\ny = 2\n");
    const first = repo.commit("feat: add a", "+0100", ADA);
    repo.write("a.py", "x = 1\ny = 3\nz = 4\n");
    const second = repo.commit("fix: a (#4)", "-0500", BOB);
    expect(readAuthorship(repo.dir, second)).toEqual([
      {
        sha: second,
        parents: [first],
        authorName: "bob",
        authorEmail: "12345+bob-dev@users.noreply.github.com",
        authorDate: "2026-01-02T19:00:00-05:00",
        commitDate: "2026-01-02T19:00:00-05:00",
        subject: "fix: a (#4)",
        mergeTitle: null,
        files: [{ path: "a.py", oldPath: null, added: 2, deleted: 1 }],
        pr: 4,
      },
      {
        sha: first,
        parents: [],
        authorName: "Ada Lovelace",
        authorEmail: "ada@example.com",
        authorDate: "2026-01-02T01:00:00+01:00",
        commitDate: "2026-01-02T01:00:00+01:00",
        subject: "feat: add a",
        mergeTitle: null,
        files: [{ path: "a.py", oldPath: null, added: 2, deleted: 0 }],
        pr: null,
      },
    ]);
  });

  it("follows a rename, marks a binary change, and gives a merge no files but its title", () => {
    repo.write("old/name.py", "a\nb\nc\nd\n");
    repo.write("logo.png", Buffer.from([0, 1, 2, 3]));
    repo.commit("init", "+0000", ADA);
    repo.git("switch", "-q", "-c", "topic");
    repo.git("mv", "old/name.py", "new name.py");
    repo.write("new name.py", "a\nb\nc\nd\ne\n");
    const moved = repo.commit("refactor: move", "+0000", BOB);
    repo.git("switch", "-q", "main");
    const merge = repo.merge(
      "topic",
      "Merge pull request #7 from bob-dev/topic\n\n  Move the module  \n\nMore text",
      ADA,
    );
    const [merged, topic] = readAuthorship(repo.dir, merge);
    expect(merged).toMatchObject({ sha: merge, mergeTitle: "Move the module", files: [], pr: 7 });
    expect(topic).toMatchObject({
      sha: moved,
      pr: 7,
      files: [{ path: "new name.py", oldPath: "old/name.py", added: 1, deleted: 0 }],
    });
    const init = readAuthorship(repo.dir, merge).at(-1);
    expect(init?.files).toContainEqual({
      path: "logo.png",
      oldPath: null,
      added: null,
      deleted: null,
    });
  });

  it("assigns pull requests exactly as readHistory does (one shared copy)", () => {
    repo.write("a.py", "1\n");
    repo.commit("init");
    repo.git("switch", "-q", "-c", "feature");
    repo.write("b.py", "2\n");
    repo.commit("feat: b");
    repo.git("switch", "-q", "main");
    repo.write("c.py", "3\n");
    repo.commit("feat: c (#9)");
    const head = repo.merge("feature", "Merge pull request #8 from x/feature");
    const prs = (list: { sha: string; pr: number | null }[]) => list.map((c) => [c.sha, c.pr]);
    expect(prs(readAuthorship(repo.dir, head))).toEqual(prs(readHistory(repo.dir, head)));
  });

  it("keeps hostile names and subjects as data, one record each", () => {
    const name = `Evil\u202E [[signals]] **b** </svg> \u0085\u200B${"x".repeat(500)}`;
    repo.write("a.py", "1\n");
    const forged = repo.commit(
      `subject ${"0".repeat(40)} 1 1 5\tfilename a.py\u2028${"f".repeat(40)}`,
      "+0000",
      { name, email: "evil@example.com" },
    );
    const [commit] = readAuthorship(repo.dir, forged);
    // git itself drops "<" and ">" from a name; everything else is kept as written.
    expect(commit?.authorName).toBe(name.replace(/[<>]/g, ""));
    expect(commit?.subject).toContain("filename a.py");
    expect(readAuthorship(repo.dir, forged)).toHaveLength(1);
  });

  it("reads paths with tabs, a leading newline, # and % as written", () => {
    for (const path of ["a\tb.py", "\nlead.py", "x#y%z.py", "ünï.py"]) repo.write(path, "1\n");
    const sha = repo.commit("files");
    expect(
      readAuthorship(repo.dir, sha)[0]
        ?.files.map((f) => f.path)
        .sort(),
    ).toEqual(["\nlead.py", "a\tb.py", "x#y%z.py", "ünï.py"].sort());
  });

  it("is not moved by the repository's config: mailmap, signatures, copies, merge diffs", () => {
    repo.write(".mailmap", "Someone Else <else@example.com> <ada@example.com>\n");
    repo.write("a.py", "a\nb\nc\nd\ne\nf\n");
    repo.commit("init", "+0000", ADA);
    repo.write("copy.py", "a\nb\nc\nd\ne\nf\n");
    repo.git("switch", "-q", "-c", "side");
    repo.write("s.py", "s\n");
    repo.commit("side", "+0000", ADA);
    repo.git("switch", "-q", "main");
    repo.write("a.py", "a\nb\nc\nd\ne\nf\ng\n");
    repo.commit("copy and change", "+0000", ADA);
    const head = repo.merge("side", "Merge branch 'side'");
    const clean = readAuthorship(repo.dir, head);
    for (const [key, value] of [
      ["log.mailmap", "true"],
      ["log.showSignature", "true"],
      ["diff.renames", "copies"],
      ["log.diffMerges", "first-parent"],
      ["diff.algorithm", "patience"],
    ])
      repo.git("config", key as string, value as string);
    expect(readAuthorship(repo.dir, head)).toEqual(clean);
    expect(clean[0]?.files).toEqual([]);
    expect(clean.find((c) => c.subject === "init")?.authorName).toBe("Ada Lovelace");
  });

  it("refuses a sha that is not 40 hex", () => {
    expect(() => readAuthorship(repo.dir, "HEAD")).toThrow(/not a 40-hex commit sha/);
  });
});
