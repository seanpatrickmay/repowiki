import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRepo, type TestRepo } from "@repowiki/engine/test-repo";
import { MAX_TOOL_RESULT_CHARS } from "@repowiki/query";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepoTools, MAX_GREP_MATCHES } from "./repo-tools.ts";
import { type SampleWiki, sampleWiki } from "./test-wiki.ts";

let sample: SampleWiki;
let big: TestRepo;
let bigSha: string;
beforeAll(() => {
  sample = sampleWiki();
  big = createTestRepo();
  for (let i = 0; i < 450; i++)
    big.write(`src/gen/m${String(i).padStart(3, "0")}.ts`, `export const v${i} = ${i};\n`);
  big.write(
    "src/long.py",
    Array.from({ length: 1000 }, (_, i) => `x_${i + 1} = ${i + 1}`).join("\n"),
  );
  big.write("assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  big.write("docs/a:b weird.md", "colon in the name\n");
  big.write("README.md", "top\n");
  bigSha = big.commit("init");
});
afterAll(() => {
  sample.repo.remove();
  big.remove();
});

/** Runs `body` on a blobless clone of a one-file repository, so its blob is missing locally. */
function withPartialClone(body: (clone: string, sha: string) => void): void {
  const source = createTestRepo();
  const scratch = mkdtempSync(join(tmpdir(), "repowiki-partial-"));
  try {
    source.write("a.txt", "hello\n");
    const at = source.commit("init");
    source.git("config", "uploadpack.allowFilter", "true");
    const clone = join(scratch, "clone");
    execFileSync(
      "git",
      ["clone", "-q", "--no-checkout", "--filter=blob:none", `file://${source.dir}`, clone],
      { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
    );
    body(clone, at);
  } finally {
    source.remove();
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("createRepoTools", () => {
  it("lists the files at the commit, under a directory or all of them", () => {
    const tools = createRepoTools(sample.repo.dir, sample.sha);
    expect(tools.definitions.map((d) => d.name)).toEqual(["list_files", "read_file", "grep"]);
    expect(tools.run("list_files", {}).text).toBe(
      [
        "4 files under the repository root:",
        "README.md",
        "src/deliverables/crud.py",
        "src/signals/ingest.py",
        "src/signals/store.py",
        "",
      ].join("\n"),
    );
    expect(tools.run("list_files", { path: "./src/signals/" }).text).toBe(
      '2 files under "src/signals":\nsrc/signals/ingest.py\nsrc/signals/store.py\n',
    );
    expect(tools.run("list_files", { path: "lib" })).toEqual({
      text: 'no files under "lib"',
      isError: true,
    });
  });

  it("reads the committed tree only, never the working tree", () => {
    const { repo, sha, commits } = sample;
    repo.write("src/signals/ingest.py", "rewritten in the working tree\n");
    repo.write("scratch.txt", "not committed\n");
    try {
      const tools = createRepoTools(repo.dir, sha);
      expect(tools.run("read_file", { path: "src/signals/ingest.py", end_line: 1 }).text).toBe(
        '"src/signals/ingest.py", lines 1-1 of 31:\n1\t"""Turns ingested chunks into signals."""\n… lines 2-31 not shown; call read_file with start_line 2 to read on\n',
      );
      expect(tools.run("list_files", {}).text).not.toContain("scratch.txt");
      expect(tools.run("grep", { pattern: "rewritten" }).text).toBe("No matches.\n");
      expect(createRepoTools(repo.dir, commits.signals).run("list_files", {}).text).not.toContain(
        "crud.py",
      );
    } finally {
      repo.git("checkout", "--", ".");
      repo.git("clean", "-fq");
    }
  });

  it("reads a numbered range and says how to read on", () => {
    const tools = createRepoTools(sample.repo.dir, sample.sha);
    expect(
      tools.run("read_file", { path: "src/signals/ingest.py", start_line: 19, end_line: 21 }).text,
    ).toBe(
      [
        '"src/signals/ingest.py", lines 19-21 of 31:',
        "19\t        if len(signals) >= MAX_SIGNALS:",
        "20\t            # TODO: page through long chunks instead of truncating",
        "21\t            break",
        "… lines 22-31 not shown; call read_file with start_line 22 to read on",
        "",
      ].join("\n"),
    );
    expect(tools.run("read_file", { path: "src/signals/ingest.py", start_line: 40 })).toEqual({
      text: '"src/signals/ingest.py" has 31 lines; start_line is past its end',
      isError: true,
    });
    expect(tools.run("read_file", { path: "../etc/passwd" })).toEqual({
      text: "paths are relative to the repository root and cannot use ..",
      isError: true,
    });
    expect(tools.run("read_file", { path: "src/nope.py" }).isError).toBe(true);
  });

  it("greps the commit's text and reports each match as path:line: text", () => {
    const tools = createRepoTools(sample.repo.dir, sample.sha);
    expect(tools.run("grep", { pattern: "def [a-z_]+\\(" }).text).toBe(
      [
        "3 matching lines:",
        "src/deliverables/crud.py:4: def create_deliverable(title, signals):",
        "src/signals/ingest.py:10: def ingest_chunk(chunk):",
        "src/signals/store.py:6: def save_signal(signal):",
        "",
      ].join("\n"),
    );
    expect(
      tools.run("grep", { pattern: "max_signals", ignore_case: true, path: "src/signals" }).text,
    ).toMatch(/^2 matching lines:\nsrc\/signals\/ingest.py:7: MAX_SIGNALS = 50\n/);
    // The regex library words the reason: "parentheses not balanced" (macOS), "Unmatched (" (glibc).
    const unbalanced = tools.run("grep", { pattern: "foo(" });
    expect(unbalanced.isError).toBe(true);
    expect(unbalanced.text).toMatch(/^grep failed: -e option, 'foo\(': \S/);
  });

  it("summarizes a directory too large to list, and pages a long file", () => {
    const tools = createRepoTools(big.dir, bigSha);
    expect(tools.run("list_files", {}).text).toBe(
      [
        "454 files under the repository root, too many to name; list one of these:",
        "README.md",
        "assets/ (1 file)",
        "docs/ (1 file)",
        "src/ (451 files)",
        "",
      ].join("\n"),
    );
    const first = tools.run("read_file", { path: "src/long.py" }).text;
    expect(first.split("\n")[0]).toBe('"src/long.py", lines 1-400 of 1000:');
    expect(first).toContain("… lines 401-1000 not shown; call read_file with start_line 401");
    expect(first.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(tools.run("read_file", { path: "assets/logo.png" }).text).toBe(
      '"assets/logo.png" is a binary file of 7 bytes\n',
    );
  });

  it("caps grep's matches, keeps a colon in a path, and skips binary files", () => {
    const tools = createRepoTools(big.dir, bigSha);
    const many = tools.run("grep", { pattern: "export const" }).text;
    expect(many.split("\n")[0]).toBe("450 matching lines:");
    expect(many).toContain(
      `… and ${450 - MAX_GREP_MATCHES} more matches; narrow the pattern or the path`,
    );
    expect(tools.run("grep", { pattern: "colon" }).text).toBe(
      "1 matching line:\ndocs/a:b weird.md:1: colon in the name\n",
    );
    expect(tools.run("grep", { pattern: "PNG" }).text).toBe("No matches.\n");
  });

  it("refuses a sha that is not a full commit id", () => {
    expect(() => createRepoTools(sample.repo.dir, "HEAD")).toThrow("not a 40-hex commit sha");
  });
});

describe("createRepoTools against hostile config and content", () => {
  let hostile: TestRepo;
  let sub: TestRepo;
  let sha: string;
  let scratch: string;
  let marker: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "repowiki-tools-"));
    marker = join(scratch, "fsmonitor-ran");
    writeFileSync(join(scratch, "hook.sh"), `touch ${marker}\n`);
    sub = createTestRepo();
    sub.write("s.txt", "subtext\n");
    sub.commit("sub");
    hostile = createTestRepo();
    hostile.write("docs/a.md", "hello secret\n");
    hostile.write("src/wide.txt", `${"w".repeat(30_000)}\n`.repeat(10));
    hostile.write("src/huge.txt", `${"z".repeat(2 * 1024 * 1024)}\n`);
    hostile.write("src/flood.txt", "a\n".repeat(1_000_000));
    hostile.write("src/many.txt", "hit\n".repeat(150));
    hostile.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "sm");
    sha = hostile.commit("init");
  });
  afterAll(() => {
    hostile.remove();
    sub.remove();
    rmSync(scratch, { recursive: true, force: true });
  });
  const withEnv = (env: Record<string, string>, fn: () => void) => {
    const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
    Object.assign(process.env, env);
    try {
      fn();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  it("does not recurse into a submodule or run an fsmonitor hook when the config asks to", () => {
    hostile.git("config", "submodule.recurse", "true");
    hostile.git("config", "core.fsmonitor", `sh ${join(scratch, "hook.sh")}`);
    try {
      const tools = createRepoTools(hostile.dir, sha);
      expect(tools.run("grep", { pattern: "subtext" }).text).toBe("No matches.\n");
      expect(tools.run("grep", { pattern: "hello" }).text).toBe(
        "1 matching line:\ndocs/a.md:1: hello secret\n",
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      hostile.git("config", "--unset", "submodule.recurse");
      hostile.git("config", "--unset", "core.fsmonitor");
    }
  });

  it("keeps grep's output shape when grep.column is set by config or by the environment", () => {
    const clean = "1 matching line:\ndocs/a.md:1: hello secret\n";
    hostile.git("config", "grep.column", "true");
    try {
      expect(createRepoTools(hostile.dir, sha).run("grep", { pattern: "hello" }).text).toBe(clean);
    } finally {
      hostile.git("config", "--unset", "grep.column");
    }
    const env = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "grep.column",
      GIT_CONFIG_VALUE_0: "true",
    };
    withEnv(env, () => {
      expect(createRepoTools(hostile.dir, sha).run("grep", { pattern: "hello" }).text).toBe(clean);
    });
    withEnv({ GIT_CONFIG_PARAMETERS: "'grep.column=true'" }, () => {
      expect(createRepoTools(hostile.dir, sha).run("grep", { pattern: "hello" }).text).toBe(clean);
    });
  });

  it("ignores config set through the environment, which the grep flags alone would not undo", () => {
    const repo = createTestRepo();
    try {
      repo.write(".gitattributes", "*.md diff=foo\n");
      repo.write("docs/a.md", "hello secret\n");
      repo.write("notes/b.txt", "hello note\n");
      const at = repo.commit("init");
      const found = "2 matching lines:\ndocs/a.md:1: hello secret\nnotes/b.txt:1: hello note\n";
      withEnv({ GIT_CONFIG_PARAMETERS: "'diff.foo.binary=true'" }, () => {
        expect(createRepoTools(repo.dir, at).run("grep", { pattern: "hello" }).text).toBe(found);
      });
      const env = {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "diff.foo.binary",
        GIT_CONFIG_VALUE_0: "true",
      };
      withEnv(env, () => {
        expect(createRepoTools(repo.dir, at).run("grep", { pattern: "hello" }).text).toBe(found);
      });
      // A core.attributesFile outside the commit does not decide what is binary either.
      writeFileSync(join(scratch, "attributes"), "*.txt binary\n");
      repo.git("config", "core.attributesFile", join(scratch, "attributes"));
      expect(createRepoTools(repo.dir, at).run("grep", { pattern: "hello" }).text).toBe(found);
    } finally {
      repo.remove();
    }
  });

  it("counts the matches past the cap by line, though a matching line holds a NUL", () => {
    const repo = createTestRepo();
    try {
      repo.write("data.txt", `${"x\n".repeat(4001)}${"hit\0tail\n".repeat(150)}`);
      const text = createRepoTools(repo.dir, repo.commit("init")).run("grep", {
        pattern: "^hit",
      }).text;
      expect(text.split("\n")[0]).toBe("150 matching lines:");
      expect(text).toContain("\u2026 and 50 more matches; narrow the pattern or the path");
    } finally {
      repo.remove();
    }
  });

  it("reads the whole repository when given a directory inside it", () => {
    const tools = createRepoTools(join(sample.repo.dir, "src"), sample.sha);
    expect(tools.run("grep", { pattern: "def ingest_chunk" }).text).toMatch(
      /^1 matching line:\nsrc\/signals\/ingest\.py:\d+: def ingest_chunk/,
    );
    expect(tools.run("read_file", { path: "README.md" }).isError).toBe(false);
  });

  it("takes a pattern or a path that looks like an option or pathspec magic as text", () => {
    const tools = createRepoTools(hostile.dir, sha);
    expect(tools.run("grep", { pattern: "-n" }).text).toBe("No matches.\n");
    expect(tools.run("grep", { pattern: "hello", path: ":(top)" }).text).toBe("No matches.\n");
    expect(tools.run("list_files", { path: "sm" })).toEqual({
      text: 'no files under "sm"',
      isError: true,
    });
  });

  it("ignores an uncommitted .gitattributes when deciding what is binary", () => {
    hostile.write(".gitattributes", "*.md binary\n");
    try {
      expect(createRepoTools(hostile.dir, sha).run("grep", { pattern: "hello" }).text).toBe(
        "1 matching line:\ndocs/a.md:1: hello secret\n",
      );
    } finally {
      rmSync(join(hostile.dir, ".gitattributes"));
    }
  });

  it("cuts an over-long line by code point and keeps the footer", () => {
    const text = createRepoTools(hostile.dir, sha).run("read_file", { path: "src/wide.txt" }).text;
    const lines = text.split("\n");
    expect(lines[0]).toBe('"src/wide.txt", lines 1-5 of 10:');
    expect(lines[1]?.startsWith(`1\t${"w".repeat(100)}`)).toBe(true);
    expect(lines[1]?.endsWith("w…")).toBe(true);
    expect(text.length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
    expect(lines.at(-2)).toBe(
      "… lines 6-10 not shown; call read_file with start_line 6 to read on",
    );
  });

  it("never splits an astral character where it cuts a line", () => {
    const repo = createTestRepo();
    try {
      repo.write("src/astral.txt", `${"w".repeat(1998)}\u{1F680}tail\n`);
      const text = createRepoTools(repo.dir, repo.commit("init")).run("read_file", {
        path: "src/astral.txt",
      }).text;
      expect(text.isWellFormed()).toBe(true);
      expect(text).toContain(`1\t${"w".repeat(1998)}\u{1F680}\u2026\n`);
    } finally {
      repo.remove();
    }
  });

  it("refuses to read a blob over 2 MB, by its size from the tree", () => {
    expect(createRepoTools(hostile.dir, sha).run("read_file", { path: "src/huge.txt" })).toEqual({
      text: '"src/huge.txt" is 2097153 bytes, over the 2097152-byte limit for read_file; grep it instead',
      isError: true,
    });
  });

  it("stops at the match cap, and reports a flood of output as too much output", () => {
    const tools = createRepoTools(hostile.dir, sha);
    const text = tools.run("grep", { pattern: "^hit$" }).text;
    expect(text.split("\n")[0]).toBe("150 matching lines:");
    expect(text).toContain("… and 50 more matches; narrow the pattern or the path");
    expect(tools.run("grep", { pattern: "^a$" })).toEqual({
      text: "grep produced too much output; narrow the pattern or the path",
      isError: true,
    });
  });

  it("refuses a grep that outlives its timeout, and keeps the default timeout generous", () => {
    // git cannot start, search and answer within a millisecond, so the kill is certain.
    const slow = createRepoTools(big.dir, bigSha, { grepTimeoutMs: 1 });
    expect(slow.run("grep", { pattern: "export const" })).toEqual({
      text: "grep took too long; narrow the pattern or the path",
      isError: true,
    });
    // The other tools do not use the grep timeout, and the default one lets an ordinary grep finish.
    expect(slow.run("list_files", { path: "docs" }).isError).toBe(false);
    expect(createRepoTools(big.dir, bigSha).run("grep", { pattern: "export const" }).isError).toBe(
      false,
    );
  });

  it("does not call a grep that could not read a file in a partial clone 'No matches.'", () => {
    withPartialClone((clone, at) => {
      const result = createRepoTools(clone, at).run("grep", { pattern: "hello" });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^grep failed: .*partial clone/);
      expect(result.text).toMatch(/git fetch --refetch/);
      expect(result.text).not.toBe("No matches.\n");
    });
  });

  it("does not take a bad pattern that mentions promisor for a partial clone's problem", () => {
    withPartialClone((clone, at) => {
      const result = createRepoTools(clone, at).run("grep", { pattern: "promisor(" });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^grep failed: -e option, 'promisor\(': /);
      expect(result.text).not.toMatch(/partial clone/);
    });
  });

  it("still says 'No matches.' when git exits 1 with nothing on stderr", () => {
    expect(createRepoTools(big.dir, bigSha).run("grep", { pattern: "zzz_not_here" }).text).toBe(
      "No matches.\n",
    );
  });
});
