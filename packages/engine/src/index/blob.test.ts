import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_BLOB_BYTES, readBlobAt } from "./blob.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
});
afterEach(() => repo.remove());

describe("readBlobAt (spec v2 #6 R4, §6.1)", () => {
  it("reads the file as committed at the sha, never the work tree", () => {
    repo.write(".mailmap", "Ada <ada@example.com>\n");
    repo.write("docs/notes.md", "nested\n");
    const sha = repo.commit("add mailmap");
    repo.write(".mailmap", "Changed in the work tree <x@example.com>\n");
    expect(readBlobAt(repo.dir, sha, ".mailmap")).toBe("Ada <ada@example.com>\n");
    expect(readBlobAt(repo.dir, sha, "docs/notes.md")).toBe("nested\n");
  });

  it("gives null for a missing path, a directory, a larger file and pathspec magic", () => {
    repo.write("docs/a.md", "a\n");
    repo.write("big.txt", "x".repeat(100));
    const sha = repo.commit("files");
    expect(readBlobAt(repo.dir, sha, ".mailmap")).toBeNull();
    expect(readBlobAt(repo.dir, sha, "docs")).toBeNull();
    expect(readBlobAt(repo.dir, sha, "big.txt", { maxBytes: 99 })).toBeNull();
    expect(readBlobAt(repo.dir, sha, ":(glob)*.md")).toBeNull();
    expect(readBlobAt(repo.dir, sha, "*.txt")).toBeNull();
  });

  it("reads up to MAX_BLOB_BYTES by default, and fails closed on a NaN or negative bound", () => {
    repo.write("edge.txt", "x".repeat(MAX_BLOB_BYTES));
    repo.write("over.txt", "x".repeat(MAX_BLOB_BYTES + 1));
    repo.write(`${"long-name-".repeat(20)}.txt`, "1\n");
    const sha = repo.commit("files");
    expect(readBlobAt(repo.dir, sha, "edge.txt")).toHaveLength(MAX_BLOB_BYTES);
    expect(readBlobAt(repo.dir, sha, "over.txt")).toBeNull();
    expect(readBlobAt(repo.dir, sha, "edge.txt", { maxBytes: Number.NaN })).toBeNull();
    expect(readBlobAt(repo.dir, sha, "edge.txt", { maxBytes: -1 })).toBeNull();
    // The bound is the blob's, not git's output's: a long listing line still reads.
    expect(readBlobAt(repo.dir, sha, `${"long-name-".repeat(20)}.txt`, { maxBytes: 2 })).toBe(
      "1\n",
    );
  });

  it("gives null for a symlink", () => {
    repo.write("target.txt", "t\n");
    symlinkSync("target.txt", join(repo.dir, "link.txt"));
    const sha = repo.commit("link");
    expect(readBlobAt(repo.dir, sha, "link.txt")).toBeNull();
  });

  it("refuses a rev that is not a 40-hex sha", () => {
    expect(() => readBlobAt(repo.dir, "HEAD", ".mailmap")).toThrow(/not a 40-hex commit sha/);
  });
});
