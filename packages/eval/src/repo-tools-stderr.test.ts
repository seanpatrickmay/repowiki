import type { SpawnSyncReturns } from "node:child_process";
import { createTestRepo } from "@repowiki/engine/test-repo";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/** What the next `git grep` returns; every other git call runs for real. */
const grepResult = vi.hoisted(() => ({ next: null as null | { status: number; stderr: string } }));
vi.mock("node:child_process", async (importOriginal) => {
  const real: typeof import("node:child_process") = await importOriginal();
  return {
    ...real,
    spawnSync: ((command: string, args: readonly string[], options: never) => {
      if (grepResult.next !== null && args.includes("grep") && args.includes("--no-color")) {
        const { status, stderr } = grepResult.next;
        return {
          status,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(stderr),
        } as unknown as SpawnSyncReturns<Buffer>;
      }
      return real.spawnSync(command, args, options);
    }) as typeof real.spawnSync,
  };
});

const { createRepoTools } = await import("./repo-tools.ts");

afterEach(() => {
  grepResult.next = null;
});

describe("grep's exit 1 with output on stderr", () => {
  const repo = createTestRepo();
  repo.write("a.txt", "hello\n");
  const sha = repo.commit("init");
  const tools = createRepoTools(repo.dir, sha);
  afterAll(() => repo.remove());

  it("is still 'No matches.' when stderr holds only warnings", () => {
    grepResult.next = {
      status: 1,
      stderr:
        "warning: unable to access '.git/info/attributes': Permission denied\nwarning: more\n",
    };
    expect(tools.run("grep", { pattern: "zzz" })).toEqual({
      text: "No matches.\n",
      isError: false,
    });
  });

  it("is an error as soon as a line is not a warning", () => {
    grepResult.next = { status: 1, stderr: "warning: x\nerror: could not read a thing\n" };
    const result = tools.run("grep", { pattern: "zzz" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("grep failed: warning: x error: could not read a thing");
  });

  it("is an error whatever git's wording, when the repository is a partial clone", () => {
    repo.git("config", "remote.origin.promisor", "true");
    grepResult.next = { status: 1, stderr: "error: some future wording for an unreadable blob\n" };
    const result = tools.run("grep", { pattern: "zzz" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^grep failed: .*partial clone/);
  });
});
