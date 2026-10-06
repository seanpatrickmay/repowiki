import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBlobAt } from "./blob.ts";
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

  it("refuses a rev that is not a 40-hex sha", () => {
    expect(() => readBlobAt(repo.dir, "HEAD", ".mailmap")).toThrow(/not a 40-hex commit sha/);
  });
});
