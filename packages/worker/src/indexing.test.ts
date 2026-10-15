import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRepo, type TestRepo } from "@repowiki/engine/test-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { runCli } from "./engine.ts";
import { INDEX_CHILD, INDEX_HEAP_MB, indexInChild } from "./indexing.ts";

let repo: TestRepo;
let sha: string;
let home: string;
beforeEach(() => {
  repo = createTestRepo();
  repo.write("src/a.py", "def a():\n    return 1\n");
  repo.write("web/b.ts", "export const b = 1;\n");
  repo.write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]));
  sha = repo.commit("three files");
  home = mkdtempSync(join(tmpdir(), "home-"));
});
afterEach(() => repo.remove());

describe("the index child (spec 2 S9)", () => {
  it("indexes in a child process and returns each file's language, lines and skip reason", async () => {
    const { files } = await indexInChild({ repo: repo.dir, sha, home });
    expect(files).toEqual([
      { language: null, loc: 0, skipped: "binary" },
      { language: "python", loc: 2, skipped: null },
      { language: "typescript", loc: 1, skipped: null },
    ]);
  }, 60_000);

  it("runs under a heap limit with only the isolated git environment", async () => {
    const seen: Parameters<typeof runCli>[0][] = [];
    const run: typeof runCli = async (input) => {
      seen.push(input);
      return {
        status: 0,
        stderrTail: "",
        timedOut: false,
        costCapped: false,
        stdout: '{"indexed":0,"files":[]}',
      };
    };
    expect(await indexInChild({ repo: repo.dir, sha, home, run })).toEqual({ files: [] });
    expect(seen[0]?.script).toBe(INDEX_CHILD);
    expect(seen[0]?.args).toEqual([repo.dir, sha]);
    expect(seen[0]?.nodeArgs).toEqual([`--max-old-space-size=${INDEX_HEAP_MB}`]);
    expect(seen[0]?.env).toMatchObject({
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(
      Object.keys(seen[0]?.env ?? {}).filter((k) => /TOKEN|ANTHROPIC|REPOWIKI/.test(k)),
    ).toEqual([]);
  });

  it("throws when the child crashes, times out, or prints something else", async () => {
    await expect(indexInChild({ repo: repo.dir, sha: "b".repeat(40), home })).rejects.toThrow(
      /exited/,
    );
    await expect(indexInChild({ repo: repo.dir, sha, home, timeoutMs: 1 })).rejects.toThrow(
      /timed out/,
    );
    const junk: typeof runCli = async () => ({
      status: 0,
      stderrTail: "",
      timedOut: false,
      costCapped: false,
      stdout: '{"files":"no"}',
    });
    await expect(indexInChild({ repo: repo.dir, sha, home, run: junk })).rejects.toThrow();
  }, 60_000);
});
