import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeCitation, CommitCitation } from "@repowiki/core";
import { createTestRepo, type TestRepo } from "@repowiki/engine/test-repo";
import { type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { citedCode, commitDetails, fileAt, MAX_CHANGED_PATHS, MAX_CODE_BYTES } from "./code.ts";
import { commitOf } from "./git.ts";

let sample: SampleWiki;
let odd: TestRepo;
let oddSha: string;
beforeAll(() => {
  sample = sampleWiki();
  odd = createTestRepo();
  odd.write("odd/a#b c.txt", "one\ntwo\n");
  odd.write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  odd.write("big.txt", "x".repeat(MAX_CODE_BYTES + 1));
  for (let i = 0; i < MAX_CHANGED_PATHS + 3; i++) odd.write(`many/f${i}.txt`, `${i}\n`);
  oddSha = odd.commit("feat: odd files");
});
afterAll(() => {
  sample.repo.remove();
  odd.remove();
});

const codeOf = (featureId: string, n: number): CodeCitation => {
  const page = sample.wiki.pages.find((p) => p.featureId === featureId);
  const citations = page?.sections.flatMap((s) => s.claims.flatMap((c) => c.citations)) ?? [];
  const found = citations.filter((c) => c.kind === "code")[n];
  if (found === undefined) throw new Error("no such citation");
  return found;
};

describe("fileAt", () => {
  it("reads a file at a commit from git objects, never the working tree", () => {
    sample.repo.write("src/signals/store.py", "rewritten in the working tree\n");
    try {
      const file = fileAt(sample.repo.dir, sample.sha, "src/signals/store.py");
      expect("text" in file && file.text.startsWith('"""Keeps signals in memory."""')).toBe(true);
    } finally {
      sample.repo.git("checkout", "--", "src/signals/store.py");
    }
  });

  it("says why a file cannot be read: no commit, no file, binary, too large", () => {
    expect(fileAt(sample.repo.dir, "f".repeat(40), "README.md")).toEqual({ missing: "no-commit" });
    expect(fileAt(sample.repo.dir, sample.sha, "src")).toEqual({ missing: "no-file" });
    expect(fileAt(sample.repo.dir, sample.sha, "*.py")).toEqual({ missing: "no-file" });
    expect(fileAt(odd.dir, oddSha, "logo.png")).toEqual({ missing: "binary" });
    expect(fileAt(odd.dir, oddSha, "big.txt")).toEqual({
      missing: "too-large",
      size: MAX_CODE_BYTES + 1,
    });
    expect(fileAt(odd.dir, oddSha, "odd/a#b c.txt")).toEqual({ text: "one\ntwo\n" });
  });

  it("refuses a sha that is not 40 hex before running git", () => {
    expect(() => fileAt(sample.repo.dir, "HEAD", "README.md")).toThrow(/not a 40-hex commit sha/);
  });
});

describe("citedCode", () => {
  it("numbers the cited lines at their commit, marks them, and shows context around them", () => {
    expect(citedCode(sample.repo.dir, codeOf("signals", 1), 2)).toBe(
      [
        "src/signals/ingest.py at commit 6767d44, lines 5-9 of 31 (cited: 7-7):",
        "  5\tfrom .store import save_signal",
        "  6\t",
        "> 7\tMAX_SIGNALS = 50",
        "  8\t",
        "  9\t",
        "",
      ].join("\n"),
    );
    expect(citedCode(sample.repo.dir, codeOf("deliverables", 0), 0)).toBe(
      [
        "src/deliverables/crud.py at commit 6767d44, lines 4-6 of 6 (cited: 4-6, create_deliverable):",
        "> 4\tdef create_deliverable(title, signals):",
        '> 5\t    """A deliverable is a title and the signals it is built from."""',
        '> 6\t    return {"title": title, "signals": list(signals)}',
        "",
      ].join("\n"),
    );
  });

  it("says when the repository lacks the cited commit", () => {
    const gone = { ...codeOf("signals", 0), sha: "f".repeat(40) };
    expect(citedCode(sample.repo.dir, gone, 5)).toBe(
      "The repository does not hold commit fffffff, so the cited code cannot be shown; fetch it, or read src/signals/ingest.py in the working tree.\n",
    );
  });
});

describe("commitDetails", () => {
  const commit = (sha: string, subject: string, pr: number | null): CommitCitation => ({
    kind: "commit",
    sha,
    subject,
    pr,
  });

  it("shows a commit's date, subject, pull request and changed files with line counts", () => {
    const { sha, commits } = sample;
    expect(commitDetails(sample.repo.dir, commit(sha, "feat: add deliverables (#7)", 7))).toBe(
      [
        `commit ${sha}, 2026-01-03`,
        "Subject: feat: add deliverables (#7)",
        "Pull request: #7",
        "1 changed file:",
        "- src/deliverables/crud.py: +6 -0",
        "",
      ].join("\n"),
    );
    // The repository's first commit is diffed against the empty tree.
    expect(
      commitDetails(sample.repo.dir, commit(commits.signals, "feat: add signal ingestion", null)),
    ).toContain("3 changed files:\n- README.md: +3 -0\n- src/signals/ingest.py: +31 -0\n");
  });

  it("lists at most MAX_CHANGED_PATHS files, a binary one by name, and no author", () => {
    const text = commitDetails(odd.dir, commit(oddSha, "feat: odd files", null));
    expect(text).toContain(`${MAX_CHANGED_PATHS + 6} changed files:`);
    expect(text).toContain("- logo.png: binary");
    expect(text).toContain("- and 6 more");
    expect(text.split("\n").filter((l) => l.startsWith("- ") && l !== "- and 6 more")).toHaveLength(
      MAX_CHANGED_PATHS,
    );
    expect(text).not.toMatch(/Fixture|example\.com/);
  });

  it("shows a commit the repository lacks from the citation alone", () => {
    expect(commitDetails(sample.repo.dir, commit("e".repeat(40), "fix: gone\nline", 3))).toBe(
      [
        `commit ${"e".repeat(40)}`,
        "Subject: fix: gone line",
        "Pull request: #3",
        "The repository does not hold this commit, so its changes cannot be listed.",
        "",
      ].join("\n"),
    );
  });
});

describe("commitDetails, whatever the user's config and the repository's attributes say", () => {
  let repo: TestRepo;
  let home: string;
  let saved: string | undefined;
  const commit = (sha: string, subject: string, pr: number | null): CommitCitation => ({
    kind: "commit",
    sha,
    subject,
    pr,
  });
  beforeAll(() => {
    repo = createTestRepo();
    home = mkdtempSync(join(tmpdir(), "repowiki-config-"));
    saved = process.env.GIT_CONFIG_GLOBAL;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
    repo.remove();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists every change in path order, with no signature check and no attribute hiding a diff", () => {
    // The repository's own attributes call its Python files binary; the user's call text files so,
    // and the user's core.bigFileThreshold calls any file over 1 KiB binary.
    repo.write(".gitattributes", "*.py -diff\n");
    repo.write("a.py", "x = 1\n");
    repo.write("b.txt", "one\n");
    repo.write("c.md", "line\n".repeat(1000));
    repo.commit("feat: start");
    repo.write("a.py", "x = 2\n");
    repo.write("b.txt", "two\n");
    repo.write("c.md", `${"line\n".repeat(999)}last\n`);
    const changed = repo.commit("feat: change both");
    // A commit carrying a signature: showing it with log.showSignature would run gpg.program.
    const tree = repo.git("rev-parse", `${changed}^{tree}`);
    const raw = join(home, "commit.txt");
    writeFileSync(
      raw,
      [
        `tree ${tree}`,
        `parent ${changed}`,
        "author A <a@example.com> 1767484800 +0000",
        "committer A <a@example.com> 1767484800 +0000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " ",
        " iQEzBAABCAAdFiEE",
        " -----END PGP SIGNATURE-----",
        "",
        "feat: signed",
        "",
      ].join("\n"),
    );
    const signed = repo.git("hash-object", "-t", "commit", "-w", raw);
    const ran = join(home, "gpg-ran");
    const gpg = join(home, "gpg.sh");
    writeFileSync(gpg, `#!/bin/sh\ntouch '${ran}'\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(home, "order"), "b.txt\na.py\n");
    writeFileSync(join(home, "attributes"), "*.txt -diff\n");
    writeFileSync(
      join(home, "config"),
      [
        "[log]\n\tshowSignature = true",
        `[gpg]\n\tprogram = ${gpg}`,
        `[diff]\n\torderFile = ${join(home, "order")}\n\trelative = true`,
        `[core]\n\tattributesFile = ${join(home, "attributes")}\n\tbigFileThreshold = 1k`,
        "",
      ].join("\n"),
    );
    process.env.GIT_CONFIG_GLOBAL = join(home, "config");

    expect(commitDetails(repo.dir, commit(changed, "feat: change both", null))).toContain(
      "3 changed files:\n- a.py: +1 -1\n- b.txt: +1 -1\n- c.md: +1 -1\n",
    );
    expect(commitDetails(repo.dir, commit(signed, "feat: signed", null))).toBe(
      [`commit ${signed}, 2026-01-04`, "Subject: feat: signed", "0 changed files:", ""].join("\n"),
    );
    expect(existsSync(ran)).toBe(false);
  });
});

describe("commitOf", () => {
  it("resolves a short or full sha to the full one, and refuses an unknown or ambiguous one", () => {
    expect(commitOf(sample.repo.dir, sample.sha.slice(0, 7))).toBe(sample.sha);
    expect(commitOf(sample.repo.dir, sample.sha)).toBe(sample.sha);
    expect(commitOf(sample.repo.dir, "f".repeat(40))).toBeNull();
    expect(commitOf(sample.repo.dir, "--output=/tmp/x")).toBeNull();
  });
});
