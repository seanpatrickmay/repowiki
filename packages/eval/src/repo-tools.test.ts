import { createTestRepo, type TestRepo } from "@repowiki/engine/test-repo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepoTools, MAX_GREP_MATCHES } from "./repo-tools.ts";
import { type SampleWiki, sampleWiki } from "./test-wiki.ts";
import { MAX_TOOL_RESULT_CHARS } from "./tools.ts";

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
    expect(tools.run("grep", { pattern: "foo(" })).toEqual({
      text: "grep failed: -e option, 'foo(': parentheses not balanced",
      isError: true,
    });
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
