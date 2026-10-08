import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTHORSHIP_TIMEOUT_MS,
  attrSourceSupported,
  gitReadsAttributesAtSha,
  readAuthorship,
} from "./authorship.ts";
import { GitError, GitTimeoutError } from "./git.ts";
import { readHistory } from "./history.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

const ADA = { name: "Ada Lovelace", email: "ada@example.com" };
const BOB = { name: "bob", email: "12345+bob-dev@users.noreply.github.com" };

let repo: TestRepo;
/** Setting and unsetting one key of the repository's own config. */
const configured = (key: string, value: string): [() => void, () => void] => [
  () => repo.git("config", key, value),
  () => repo.git("config", "--unset", key),
];
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

  it("is not moved by the repository's config, attributes, replace refs or signatures", () => {
    repo.write(".mailmap", "Someone Else <else@example.com> <ada@example.com>\n");
    repo.write("a.py", "a\nU\nb\nb\nU\n");
    repo.write("r1.py", "1\n2\n3\n4\n5\n6\n7\n8\n");
    repo.write("r2.py", "a\nb\nc\nd\ne\nf\ng\nh\n");
    repo.commit("init", "+0000", ADA);
    repo.git("switch", "-q", "-c", "side");
    repo.write("s.py", "s\n");
    repo.commit("side", "+0000", ADA);
    repo.git("switch", "-q", "main");
    // myers counts this edit +4 -3, patience +5 -4; copy.py copies a.py in the commit that
    // changes it, so copy detection would see it; both renames change a line, so they are
    // inexact and a rename limit of 1 would drop them.
    repo.write("a.py", "b\nU\nU\nb\na\nV\n");
    repo.write("copy.py", "a\nU\nb\nb\nU\n");
    repo.git("mv", "r1.py", "s1.py");
    repo.git("mv", "r2.py", "s2.py");
    repo.write("s1.py", "1\n2\n3\n4\n5\n6\n7\n9\n");
    repo.write("s2.py", "a\nb\nc\nd\ne\nf\ng\ni\n");
    repo.commit("copy and change", "+0000", ADA);
    repo.merge("side", "Merge branch 'side'");
    // The head is a signed commit (a crafted gpgsig header): only showing signatures runs gpg.
    const signed = repo
      .git("cat-file", "commit", "HEAD")
      .replace(
        /^(committer .*)$/m,
        "$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----",
      );
    repo.write(".git/signed-commit", `${signed}\n`);
    const head = repo.git("hash-object", "-t", "commit", "-w", ".git/signed-commit");
    repo.git("update-ref", "refs/heads/main", head);
    const ran = join(repo.dir, ".git", "gpg-ran");
    repo.write(".git/gpg-canary.sh", `#!/bin/sh\ntouch '${ran}'\nexit 1\n`);
    chmodSync(join(repo.dir, ".git", "gpg-canary.sh"), 0o755);
    repo.write(".git/hostile-attributes", "*.py -diff\n");
    repo.git("config", "gpg.program", join(repo.dir, ".git", "gpg-canary.sh"));
    // A replacement commit with another author, and an uncommitted .gitattributes.
    const init = repo.git("rev-list", "--max-parents=0", "HEAD");
    const other = repo
      .git("cat-file", "commit", init)
      .replace(/^author .*$/m, "author Someone Else <else@example.com> 1767312000 +0000");
    repo.write(".git/other-commit", `${other}\n`);
    const replacement = repo.git("hash-object", "-t", "commit", "-w", ".git/other-commit");

    // What plain git log shows: each case below must change it, so each pin can fail.
    const plain = () => repo.git("log", "-z", "--numstat", "--format=%x00%H%x00%an%x00%s", head);
    const clean = readAuthorship(repo.dir, head);
    const before = plain();
    const cases: [string, () => void, () => void][] = [
      ["diff.renames", ...configured("diff.renames", "copies")],
      ["diff.algorithm", ...configured("diff.algorithm", "patience")],
      ["diff.renameLimit", ...configured("diff.renameLimit", "1")],
      ["log.showRoot", ...configured("log.showRoot", "false")],
      ["core.bigFileThreshold", ...configured("core.bigFileThreshold", "1")],
      [
        "core.attributesFile",
        ...configured("core.attributesFile", join(repo.dir, ".git", "hostile-attributes")),
      ],
      ["i18n.logOutputEncoding", ...configured("i18n.logOutputEncoding", "UTF-16")],
      [
        "refs/replace",
        () => repo.git("replace", init, replacement),
        () => repo.git("replace", "-d", init),
      ],
    ];
    if (gitReadsAttributesAtSha())
      cases.push([
        "work-tree .gitattributes",
        () => repo.write(".gitattributes", "*.py -diff\n"),
        () => rmSync(join(repo.dir, ".gitattributes")),
      ]);
    for (const [name, set, unset] of cases) {
      set();
      expect(plain(), name).not.toBe(before);
      expect(readAuthorship(repo.dir, head), name).toEqual(clean);
      unset();
    }
    const [setSignatures] = configured("log.showSignature", "true");
    setSignatures();
    // These two change no plain `git log` (log.diffMerges applies only with -m); set for good measure.
    repo.git("config", "log.mailmap", "true");
    repo.git("config", "log.diffMerges", "first-parent");
    plain();
    expect(existsSync(ran), "the canary shows plain git log runs gpg").toBe(true);
    rmSync(ran);
    expect(readAuthorship(repo.dir, head)).toEqual(clean);
    expect(existsSync(ran)).toBe(false);

    expect(clean.find((c) => c.subject === "init")?.authorName).toBe("Ada Lovelace");
    expect(clean.find((c) => c.subject === "init")?.files).toHaveLength(4);
    expect(clean.find((c) => c.subject.startsWith("Merge"))?.files).toEqual([]);
    expect(clean.find((c) => c.subject === "copy and change")?.files).toEqual([
      { path: "a.py", oldPath: null, added: 4, deleted: 3 },
      { path: "copy.py", oldPath: null, added: 5, deleted: 0 },
      { path: "s1.py", oldPath: "r1.py", added: 1, deleted: 1 },
      { path: "s2.py", oldPath: "r2.py", added: 1, deleted: 1 },
    ]);
  });

  it("stops at its output cap and its time limit with a GitError", () => {
    repo.write("a.py", "1\n");
    const sha = repo.commit("init", "+0000", ADA);
    expect(() => readAuthorship(repo.dir, sha, { maxBytes: 16 })).toThrow(GitError);
    expect(() => readAuthorship(repo.dir, sha, { maxBytes: 16 })).toThrow(/16-byte limit/);
    expect(() => readAuthorship(repo.dir, sha, { timeoutMs: 1 })).toThrow(GitTimeoutError);
    expect(AUTHORSHIP_TIMEOUT_MS).toBe(600_000);
  });

  it("reads attributes at the sha only on git 2.40 or later", () => {
    expect(attrSourceSupported("git version 2.39.3 (Apple Git-146)")).toBe(false);
    expect(attrSourceSupported("git version 2.40.0")).toBe(true);
    expect(attrSourceSupported("git version 2.47.1")).toBe(true);
    expect(attrSourceSupported("git version 3.0.0")).toBe(true);
    expect(attrSourceSupported("not git")).toBe(false);
  });

  it("reads the author date, not the committer's (the Task 6 review's minor)", () => {
    repo.write("a.py", "1\n");
    const sha = repo.commit("init", "+0100", ADA);
    const body = repo
      .git("cat-file", "commit", sha)
      .replace(/^(committer .*>) \d+ [+-]\d{4}$/m, "$1 1800000000 -0700");
    repo.write(".git/recommitted", `${body}\n`);
    const later = repo.git("hash-object", "-t", "commit", "-w", ".git/recommitted");
    const [c] = readAuthorship(repo.dir, later);
    expect(c?.authorDate).toMatch(/\+01:00$/);
    expect(c?.commitDate).toBe("2027-01-15T01:00:00-07:00");
    expect(c?.authorDate).not.toBe(c?.commitDate);
  });

  it("never throws on an author date git prints but People cannot use (the I3 ruling)", () => {
    repo.write("a.py", "1\n");
    const first = repo.commit("init", "+0000", ADA);
    // Crafted author lines: a year-10000 timestamp, then a +99:59 offset.
    const crafted = (parent: string, stamp: string) => {
      const body = repo
        .git("cat-file", "commit", parent)
        .replace(/^(author .*>) \d+ [+-]\d{4}$/m, `$1 ${stamp}`)
        .replace(/^parent .*\n/m, "")
        .replace(/^(tree .*)$/m, `$1\nparent ${parent}`);
      repo.write(".git/crafted", `${body}\n`);
      return repo.git("hash-object", "--literally", "-t", "commit", "-w", ".git/crafted");
    };
    const late = crafted(first, "253402300800 +0000");
    const offset = crafted(late, "1767225600 +9959");
    const [o, l, f] = readAuthorship(repo.dir, offset);
    // An invalid offset is read as +00:00, the clock time kept.
    expect(o?.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(o?.undated).toBeUndefined();
    // A year outside 1970-9999 leaves the commit undated, its commit date standing in.
    expect(l?.undated).toBe(true);
    expect(l?.authorDate).toBe(l?.commitDate);
    expect(f?.undated).toBeUndefined();
  });

  it("refuses a sha that is not 40 hex", () => {
    expect(() => readAuthorship(repo.dir, "HEAD")).toThrow(/not a 40-hex commit sha/);
  });
});
