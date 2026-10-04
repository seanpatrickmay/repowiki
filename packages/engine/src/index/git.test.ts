import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitFiles,
  GitError,
  listBlobs,
  readBlobs,
  resolveCommit,
  scrubbedGitEnv,
} from "./git.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
});
afterEach(() => repo.remove());

describe("resolveCommit", () => {
  it("resolves HEAD, a short sha, and a branch to the full sha", () => {
    repo.write("a.py", "x = 1\n");
    const sha = repo.commit("add a");
    expect(resolveCommit(repo.dir, "HEAD")).toBe(sha);
    expect(resolveCommit(repo.dir, sha.slice(0, 7))).toBe(sha);
    expect(resolveCommit(repo.dir, "main")).toBe(sha);
  });

  it.each(["no-such-branch", "-n1", "HEAD~5"])("rejects %j with GitError", (rev) => {
    repo.write("a.py", "x = 1\n");
    repo.commit("add a");
    expect(() => resolveCommit(repo.dir, rev)).toThrow(GitError);
  });
});

describe("inherited git environment", () => {
  const VARS = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
  ] as const;

  it.each(VARS)("ignores an inherited %s", (name) => {
    const saved = process.env[name];
    try {
      process.env[name] = join(tmpdir(), "repowiki-bogus-git-env", name);
      repo.write("a.py", "x = 1\n");
      const sha = repo.commit("add a");
      expect(resolveCommit(repo.dir, "HEAD")).toBe(sha);
      const blobs = listBlobs(repo.dir, sha);
      expect(blobs.map((b) => b.path)).toEqual(["a.py"]);
      expect(
        readBlobs(
          repo.dir,
          blobs.map((b) => b.oid),
        ).size,
      ).toBe(1);
      expect(commitFiles(repo.dir, sha)).toEqual([["a.py"]]);
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });
});

describe("scrubbedGitEnv", () => {
  const INJECTED = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "touch /tmp/x",
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor=touch /tmp/x'",
    GIT_GLOB_PATHSPECS: "1",
    GIT_NOGLOB_PATHSPECS: "1",
    GIT_ICASE_PATHSPECS: "1",
    GIT_LITERAL_PATHSPECS: "1",
  };

  it("drops config and pathspec rules set through the environment, and forbids lazy fetches", () => {
    const saved = Object.fromEntries(Object.keys(INJECTED).map((n) => [n, process.env[n]]));
    try {
      Object.assign(process.env, INJECTED, { GIT_NO_LAZY_FETCH: "0" });
      const env = scrubbedGitEnv();
      for (const name of Object.keys(INJECTED)) expect(env[name], name).toBeUndefined();
      expect(env.GIT_NO_LAZY_FETCH).toBe("1");
      expect(scrubbedGitEnv({ GIT_CONFIG_GLOBAL: "/dev/null" }).GIT_CONFIG_GLOBAL).toBe(
        "/dev/null",
      );
      repo.write("a.py", "x = 1\n");
      const sha = repo.commit("add a");
      expect(listBlobs(repo.dir, sha).map((b) => b.path)).toEqual(["a.py"]);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      delete process.env.GIT_NO_LAZY_FETCH;
    }
  });
});

describe("listBlobs", () => {
  it("lists regular files with awkward names, sorted by path", () => {
    repo.write("src/my file.py", "a = 1\n");
    repo.write("docs/C#.md", "# C#\n");
    repo.write("docs/100%.md", "done\n");
    repo.write("src/naïve.py", "b = 2\n");
    const sha = repo.commit("add files");
    expect(listBlobs(repo.dir, sha).map((blob) => blob.path)).toEqual([
      "docs/100%.md",
      "docs/C#.md",
      "src/my file.py",
      "src/naïve.py",
    ]);
  });

  it("skips symlinks and submodules", () => {
    repo.write("real.py", "x = 1\n");
    symlinkSync("real.py", join(repo.dir, "link.py"));
    const first = repo.commit("add real and link");
    repo.git("update-index", "--add", "--cacheinfo", `160000,${first},vendor/lib`);
    const sha = repo.commit("add submodule");
    expect(listBlobs(repo.dir, sha).map((blob) => blob.path)).toEqual(["real.py"]);
  });

  it("reports byte sizes", () => {
    repo.write("a.txt", "hello\n");
    const sha = repo.commit("add a");
    expect(listBlobs(repo.dir, sha)).toEqual([expect.objectContaining({ path: "a.txt", size: 6 })]);
  });
});

describe("readBlobs", () => {
  it("returns exact bytes, including binary and empty files", () => {
    const binary = Buffer.from([0x89, 0x50, 0x00, 0x0a, 0xff]);
    repo.write("img.png", binary);
    repo.write("empty.py", "");
    repo.write("a.py", "x = 1\n");
    const sha = repo.commit("add files");
    const blobs = listBlobs(repo.dir, sha);
    const contents = readBlobs(
      repo.dir,
      blobs.map((blob) => blob.oid),
    );
    const byPath = (path: string) => contents.get(blobs.find((b) => b.path === path)?.oid ?? "");
    expect(byPath("img.png")).toEqual(binary);
    expect(byPath("empty.py")).toEqual(Buffer.alloc(0));
    expect(byPath("a.py")?.toString("utf8")).toBe("x = 1\n");
  });

  it("returns an empty map for no oids", () => {
    expect(readBlobs(repo.dir, []).size).toBe(0);
  });

  it("throws GitError for an object that does not exist", () => {
    repo.write("a.py", "x = 1\n");
    repo.commit("add a");
    expect(() => readBlobs(repo.dir, ["0".repeat(40)])).toThrow(GitError);
  });
});

describe("commitFiles", () => {
  it("lists files per non-merge commit, newest first, with renames as delete + add", () => {
    repo.write("a.py", "a = 1\n");
    repo.write("b.py", "b = 1\n");
    repo.commit("add a and b");
    repo.git("checkout", "-q", "-b", "feature");
    repo.git("mv", "a.py", "renamed.py");
    repo.commit("rename a");
    repo.git("checkout", "-q", "main");
    repo.write("b.py", "b = 2\n");
    repo.commit("edit b");
    repo.git("merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    repo.commit("empty");
    const sha = repo.git("rev-parse", "HEAD");
    expect(commitFiles(repo.dir, sha)).toEqual([
      [],
      ["b.py"],
      ["a.py", "renamed.py"],
      ["a.py", "b.py"],
    ]);
  });

  it("lists files per non-merge commit with awkward names", () => {
    repo.write("with space.py", "a = 1\n");
    repo.write("ünï.py", "b = 2\n");
    repo.write("C#.md", "# C#\n");
    repo.write("100%.md", "done\n");
    repo.write("\nlead.py", "c = 3\n");
    repo.write("a\x1eb.py", "d = 4\n");
    const sha = repo.commit("add files");
    expect(commitFiles(repo.dir, sha)).toEqual([
      ["\nlead.py", "100%.md", "C#.md", "a\x1eb.py", "with space.py", "ünï.py"],
    ]);
  });
});
