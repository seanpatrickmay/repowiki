import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const real: typeof import("node:child_process") = await importOriginal();
  return { ...real, spawnSync: spawn };
});

const { GitError, GitTimeoutError, git, listBlobs, resolveCommit } = await import("./git.ts");
const { diffCommits, isAncestor } = await import("./diff.ts");

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

describe("git timeouts", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const timedOut = () =>
    ({
      error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
      status: null,
      signal: "SIGTERM",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }) as never;
  const timeouts = () =>
    spawn.mock.calls.map((call) => (call[2] as { timeout?: number } | undefined)?.timeout);

  it("gives git no timeout unless the caller asks for one", () => {
    spawn.mockReturnValue({ status: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) });
    git("/repo", ["status"]);
    git("/repo", ["status"], { timeoutMs: 250 });
    expect(timeouts()).toEqual([undefined, 250]);
  });

  it("names the timeout when git runs past it", () => {
    spawn.mockReturnValue(timedOut());
    const attempt = () => git("/repo", ["diff"], { timeoutMs: 250 });
    expect(attempt).toThrow(GitTimeoutError);
    expect(attempt).toThrow(GitError);
    expect(attempt).toThrow("git diff timed out after 250 ms in /repo");
  });

  it("threads the timeout through diffCommits and isAncestor", () => {
    spawn.mockReturnValue(timedOut());
    expect(() => diffCommits("/repo", A, B, undefined, { timeoutMs: 250 })).toThrow(
      GitTimeoutError,
    );
    expect(() => isAncestor("/repo", A, B, { timeoutMs: 250 })).toThrow(
      "git merge-base timed out after 250 ms in /repo",
    );
    expect(timeouts()).toEqual([250, 250]);
    spawn.mockReset();
    spawn.mockReturnValue({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    expect(isAncestor("/repo", A, B)).toBe(false);
    expect(timeouts()).toEqual([undefined]);
  });

  it("diffs each changed file within the same timeout", () => {
    const raw = `:100644 100644 ${A} ${B} M\0a.py\0`;
    spawn
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from(raw), stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    diffCommits("/repo", A, B, undefined, { timeoutMs: 250 });
    expect(timeouts()).toEqual([250, 250]);
  });
});
