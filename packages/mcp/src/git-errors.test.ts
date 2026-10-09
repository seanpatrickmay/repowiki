import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const real: typeof import("node:child_process") = await importOriginal();
  return { ...real, spawnSync: spawn };
});

const { gitOutput } = await import("./git.ts");

/** What spawnSync returns when it stopped git: Node sets SIGTERM for an overflow and a timeout alike. */
function stopped(code: string): SpawnSyncReturns<Buffer> {
  const error = Object.assign(new Error(`spawnSync git ${code}`), { code });
  return { error, status: null, signal: "SIGTERM", stdout: Buffer.alloc(0) } as never;
}

afterEach(() => spawn.mockReset());

describe("gitOutput's failures", () => {
  it("names an output overflow as too much output, though git was killed", () => {
    spawn.mockReturnValue(stopped("ENOBUFS"));
    expect(() => gitOutput("/repo", ["cat-file", "blob", "a".repeat(40)])).toThrow(
      "git cat-file wrote too much in /repo",
    );
  });

  it("names a timeout as taking too long", () => {
    spawn.mockReturnValue(stopped("ETIMEDOUT"));
    expect(() => gitOutput("/repo", ["rev-list"])).toThrow("git rev-list took too long in /repo");
  });
});
