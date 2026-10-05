import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError, git, resolveCommit, type StreamedBlob, streamBlobs } from "./git.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

const PLAIN_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

let source: TestRepo;
let sha: string;
let scratch: string;
beforeEach(() => {
  source = createTestRepo();
  source.write("a.py", "x = 1\n");
  sha = source.commit("add a");
  scratch = mkdtempSync(join(tmpdir(), "repowiki-causes-"));
});
afterEach(() => {
  source.remove();
  rmSync(scratch, { recursive: true, force: true });
});

/** A blobless clone of `source`: its trees and commits are local, its blobs live on the promisor. */
function partialClone(): string {
  source.git("config", "uploadpack.allowFilter", "true");
  const dir = join(scratch, "clone");
  execFileSync(
    "git",
    ["clone", "-q", "--no-checkout", "--filter=blob:none", `file://${source.dir}`, dir],
    { env: PLAIN_ENV },
  );
  return dir;
}

/**
 * Runs `attempt` as if the repository belonged to another user, as git's own tests do. The system
 * and global config are left out: a CI runner's `safe.directory = *` would trust every repository.
 */
function asAnotherOwner<T>(attempt: () => T, env: Record<string, string> = {}): T {
  const set = {
    GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...env,
  };
  const before = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
  Object.assign(process.env, set);
  try {
    return attempt();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function messageOf(attempt: () => unknown): string {
  try {
    attempt();
  } catch (error) {
    expect(error).toBeInstanceOf(GitError);
    return (error as Error).message;
  }
  throw new Error("expected a GitError");
}

/** Drains `streamBlobs` and returns the message of the GitError it ends with. */
async function streamMessageOf(repo: string, oids: string[]): Promise<string> {
  const seen: StreamedBlob[] = [];
  try {
    for await (const blob of streamBlobs(repo, oids, 1024)) seen.push(blob);
  } catch (error) {
    expect(error).toBeInstanceOf(GitError);
    return (error as Error).message;
  }
  throw new Error(`expected a GitError, got ${seen.length} blobs`);
}

describe("a git refusal that names its cause", () => {
  it("says a partial clone's missing object is the problem, in one printable line", () => {
    const clone = partialClone();
    const message = messageOf(() => git(clone, ["diff-tree", "-p", "--root", sha]));
    expect(message).toMatch(/partial clone/);
    expect(message).toMatch(/git fetch --refetch/);
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("says a partial clone's missing blob is the problem when cat-file reports it as missing", async () => {
    const clone = partialClone();
    const oid = source.git("rev-parse", `${sha}:a.py`);
    const message = await streamMessageOf(clone, [oid]);
    expect(message).toContain(oid);
    expect(message).toMatch(/partial clone/);
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("keeps the plain message for a missing object in a full clone", async () => {
    const message = await streamMessageOf(source.dir, ["0".repeat(40)]);
    expect(message).toBe(`unexpected cat-file header: ${"0".repeat(40)} missing`);
  });

  it("says an unsafe repository is the problem, in one printable line", () => {
    const message = asAnotherOwner(() => messageOf(() => git(source.dir, ["rev-list", sha])));
    expect(message).toMatch(/unsafe/);
    expect(message).toMatch(/safe\.directory/);
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("does not call an unsafe repository an unknown revision", () => {
    const message = asAnotherOwner(() => messageOf(() => resolveCommit(source.dir, "HEAD")));
    expect(message).toMatch(/safe\.directory/);
    expect(message).not.toMatch(/does not name a commit/);
  });

  it("names the cause when safe.directory arrives only through the environment, which is ignored", () => {
    const env = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    };
    // Plain git trusts the environment's setting...
    asAnotherOwner(() => {
      expect(
        execFileSync("git", ["-C", source.dir, "rev-parse", "HEAD"], { env: process.env })
          .toString("utf8")
          .trim(),
      ).toBe(sha);
    }, env);
    // ...the engine does not, and says why it refuses.
    const message = asAnotherOwner(() => messageOf(() => git(source.dir, ["rev-list", sha])), env);
    expect(message).toMatch(/unsafe/);
    expect(message).toMatch(/safe\.directory/);
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("quotes the path in the suggested safe.directory command", () => {
    const message = asAnotherOwner(() => messageOf(() => git(source.dir, ["rev-list", sha])));
    expect(message).toContain(`safe.directory '${source.dir}'`);
  });

  it("does not take a word git echoes from the caller for a cause", () => {
    for (const word of [
      "promisor",
      "safe.directory",
      "lazy fetching disabled",
      "dubious ownership",
    ]) {
      const message = messageOf(() => git(source.dir, ["rev-list", word]));
      expect(message).toMatch(/^git rev-list failed in .*: fatal: .*ambiguous argument/);
      expect(message).not.toMatch(/partial clone|unsafe/);
    }
    const clone = partialClone();
    const message = messageOf(() => git(clone, ["grep", "-E", "-e", "promisor(", sha]));
    expect(message).toMatch(/promisor\(/);
    expect(message).not.toMatch(/partial clone/);
  });

  it("keeps git's own words for every other failure", () => {
    expect(messageOf(() => git(source.dir, ["rev-list", "no-such-ref"]))).toMatch(
      /^git rev-list failed in .*: fatal: .*no-such-ref/,
    );
  });
});
