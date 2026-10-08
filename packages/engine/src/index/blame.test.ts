import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlameSkippedError, blameFile, parseIncrementalBlame } from "./blame.ts";
import { GitTimeoutError } from "./git.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

const ADA = { name: "Ada", email: "ada@example.com" };
const BOB = { name: "Bob", email: "bob@example.com" };
const BOT = { name: "Formatter", email: "fmt@example.com" };
const A = "a".repeat(40);
const B = "b".repeat(40);

describe("parseIncrementalBlame", () => {
  it("reads only each group's header, merging adjacent runs of one commit in line order", () => {
    const text = [
      `${B} 3 3 2`,
      "author Bob",
      `summary ${A} 1 1 9`,
      "filename a.py",
      `${A} 1 1 2`,
      "author Ada",
      "previous x a.py",
      "boundary",
      "filename a.py",
      `${A} 5 5 1`,
      "filename a.py",
      "",
    ].join("\n");
    expect(parseIncrementalBlame(text)).toEqual([
      [A, 2],
      [B, 2],
      [A, 1],
    ]);
  });

  it("refuses output that leaves a gap, ends inside a group, or is not blame's", () => {
    expect(() => parseIncrementalBlame(`${A} 1 2 1\nfilename a\n`)).toThrow(/in order/);
    expect(() => parseIncrementalBlame(`${A} 1 1 1\nauthor x\n`)).toThrow(/inside a group/);
    expect(() => parseIncrementalBlame("fatal: nope\n")).toThrow(/unparseable/);
    expect(parseIncrementalBlame("")).toEqual([]);
  });
});

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
});
afterEach(() => repo.remove());

/** a.py by Ada; Bob moves its function into b.py; a formatter then rewrites one line. */
function history(): { head: string; ada: string; bob: string; sweep: string } {
  const fn = [
    "def score_signal(signal, weights):",
    "    weighted_total = signal.value * weights.primary",
    "    weighted_total += signal.bonus * weights.secondary",
    "    return weighted_total",
  ];
  repo.write("a.py", `${["import os", "", ...fn].join("\n")}\n`);
  const ada = repo.commit("feat: score", "+0000", ADA);
  repo.write("a.py", "import os\n");
  repo.write("b.py", `${["# scoring", ...fn].join("\n")}\n`);
  const bob = repo.commit("refactor: move score", "+0000", BOB);
  const formatted = ["# scoring", ...fn]
    .join("\n")
    .replace(" * weights.primary", "*weights.primary");
  repo.write("b.py", `${formatted}\n`);
  const sweep = repo.commit("style: format", "+0000", BOT);
  return { head: sweep, ada, bob, sweep };
}

/** The commit of each line, from runs. */
const perLine = (runs: readonly (readonly [string, number])[]): string[] =>
  runs.flatMap(([sha, n]) => Array<string>(n).fill(sha));

describe("blameFile (spec v2 #6 R1, R2, R4)", () => {
  it("follows moved lines to the commit that wrote them (-C -C -M)", async () => {
    const { head, ada, bob, sweep } = history();
    const lines = perLine(await blameFile(repo.dir, head, "b.py"));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(bob);
    expect(lines[2]).toBe(sweep);
    expect(lines.slice(3)).toEqual([ada, ada]);
  });

  it("gives an ignored revision's lines to an earlier commit", async () => {
    const { head, ada, sweep } = history();
    const lines = perLine(await blameFile(repo.dir, head, "b.py", [sweep]));
    expect(lines).not.toContain(sweep);
    expect(lines.slice(3)).toEqual([ada, ada]);
  });

  it("is the same whatever the repository's config and the environment say", async () => {
    const { head: base, sweep } = history();
    // c.py: the indent heuristic decides which copy of `a "" b` is new.
    repo.write("c.py", "1\n2\na\n\nb\n3\n4\n");
    repo.commit("feat: c", "+0000", ADA);
    repo.write("c.py", "1\n2\na\n\nb\na\n\nb\n3\n4\n");
    const head = repo.commit("feat: grow c", "+0000", BOB);
    expect(base).not.toBe(head);
    const paths = ["b.py", "c.py"];
    const ours = () => Promise.all(paths.map((path) => blameFile(repo.dir, head, path)));
    const plain = () =>
      paths.map((path) => repo.git("blame", "--incremental", head, "--", path)).join("\n");
    const clean = await ours();
    const before = plain();
    const canary = join(repo.dir, ".git", "textconv-ran");
    const textconv = join(repo.dir, ".git", "textconv.sh");
    writeFileSync(textconv, `#!/bin/sh\ntouch '${canary}'\ncat "$1"\n`);
    chmodSync(textconv, 0o755);
    repo.write(".git-blame-ignore-revs", `${sweep}\n`);
    // Each of these changes plain git blame, so each pin can fail. (Blame gave myers' answer
    // under patience and histogram on every fixture tried, so diff.algorithm is set below only.)
    const cases: [string, string][] = [
      ["diff.indentHeuristic", "false"],
      ["blame.ignoreRevsFile", ".git-blame-ignore-revs"],
    ];
    for (const [key, value] of cases) {
      repo.git("config", key, value);
      expect(plain(), key).not.toBe(before);
      expect(await ours(), key).toEqual(clean);
      repo.git("config", "--unset", key);
    }
    // A textconv driver: plain blame runs it, ours never does.
    repo.write(".gitattributes", "*.py diff=evil\n");
    repo.git("config", "diff.evil.textconv", textconv);
    plain();
    expect(existsSync(canary), "the canary shows plain git blame runs textconv").toBe(true);
    rmSync(canary);
    expect(await ours()).toEqual(clean);
    expect(existsSync(canary)).toBe(false);
    // Everything at once, and the environment too.
    repo.write(".mailmap", "Someone Else <ada@example.com>\n");
    for (const [key, value] of [
      ["diff.algorithm", "patience"],
      ["diff.indentHeuristic", "false"],
      ["blame.ignoreRevsFile", ".git-blame-ignore-revs"],
      ["blame.markIgnoredLines", "true"],
      ["blame.markUnblamableLines", "true"],
    ])
      repo.git("config", key as string, value as string);
    const injected = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "blame.ignoreRevsFile",
      GIT_CONFIG_VALUE_0: ".git-blame-ignore-revs",
      GIT_CONFIG_PARAMETERS: "'diff.algorithm'='histogram'",
      GIT_DIR: "/nonexistent",
      GIT_DIFF_OPTS: "--unified=9",
    };
    const saved = Object.fromEntries(Object.keys(injected).map((k) => [k, process.env[k]]));
    Object.assign(process.env, injected);
    try {
      expect(await ours()).toEqual(clean);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(existsSync(canary)).toBe(false);
  });

  it("names the cause when the repository's config names an ignore file git cannot read", async () => {
    const { head } = history();
    repo.git("config", "blame.ignoreRevsFile", "no-such-file");
    const missing = blameFile(repo.dir, head, "b.py");
    await expect(missing).rejects.toBeInstanceOf(BlameSkippedError);
    await expect(missing).rejects.toThrow(/blame\.ignoreRevsFile .* cannot read/);
    repo.write("bad-revs", "not a sha\n");
    repo.git("config", "blame.ignoreRevsFile", "bad-revs");
    await expect(blameFile(repo.dir, head, "b.py")).rejects.toBeInstanceOf(BlameSkippedError);
  });

  it("skips a file whose blame writes more than its output cap", async () => {
    const { head } = history();
    const capped = blameFile(repo.dir, head, "b.py", [], { maxBytes: 10 });
    await expect(capped).rejects.toBeInstanceOf(BlameSkippedError);
    await expect(capped).rejects.toThrow(/more than 10 bytes/);
  });

  it("reads a path with spaces, # and pathspec magic literally, and one starting with -", async () => {
    for (const path of [":(glob)*.py", "a b#c.py", "-x.py", "--help"]) repo.write(path, "x = 1\n");
    repo.write("z.py", "1\n2\n");
    const sha = repo.commit("odd names", "+0000", ADA);
    for (const path of [":(glob)*.py", "a b#c.py", "-x.py", "--help"])
      expect(await blameFile(repo.dir, sha, path), path).toEqual([[sha, 1]]);
  });

  it("stops a blame that runs past its timeout", async () => {
    const { head } = history();
    await expect(blameFile(repo.dir, head, "b.py", [], { timeoutMs: 1 })).rejects.toBeInstanceOf(
      GitTimeoutError,
    );
  });

  it("refuses a sha or an ignore-rev that is not 40 hex", async () => {
    const { head } = history();
    await expect(blameFile(repo.dir, "HEAD", "b.py")).rejects.toThrow(/40-hex/);
    await expect(blameFile(repo.dir, head, "b.py", ["--root"])).rejects.toThrow(/40-hex/);
  });
});
