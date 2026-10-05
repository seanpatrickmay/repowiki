import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const real: typeof import("node:child_process") = await importOriginal();
  return { ...real, spawnSync: spawn };
});

const { GitError, listBlobs, resolveCommit } = await import("./git.ts");

function failing(error: Error & { code?: string }): SpawnSyncReturns<Buffer> {
  return { error, status: null, signal: null, stdout: null, stderr: null } as never;
}

afterEach(() => spawn.mockReset());

describe("git failures", () => {
  it("reports a spawn failure in resolveCommit as git not running, not as a bad revision", () => {
    spawn.mockReturnValue(failing(new Error("spawnSync git ENOENT")));
    const attempt = () => resolveCommit("/repo", "HEAD");
    expect(attempt).toThrow(GitError);
    expect(attempt).toThrow(/could not run git/);
    expect(attempt).not.toThrow(/does not name a commit/);
  });

  it("still reports an unknown revision as not naming a commit", () => {
    spawn.mockReturnValue({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    expect(() => resolveCommit("/repo", "nope")).toThrow(/"nope" does not name a commit/);
  });

  it.each([
    ["ENOBUFS", Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS" })],
    ["maxBuffer exceeded", new Error("spawnSync git maxBuffer length exceeded")],
  ])("explains %s as too much tracked content", (_name, error) => {
    spawn.mockReturnValue(failing(error));
    const attempt = () => listBlobs("/repo", "a".repeat(40));
    expect(attempt).toThrow(GitError);
    expect(attempt).toThrow(/tracked content is too large to index in one pass/);
  });

  it("keeps the plain message for other spawn failures", () => {
    spawn.mockReturnValue(failing(new Error("spawnSync git ENOENT")));
    expect(() => listBlobs("/repo", "a".repeat(40))).toThrow(/could not run git: .*ENOENT/);
  });
});
