import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

const seen = vi.hoisted(() => ({
  calls: [] as { oids: string[]; holdLimit: number }[],
  mode: "real" as "real" | "short" | "wrongOid" | "held",
}));
vi.mock("./git.ts", async (importOriginal) => {
  const real: typeof import("./git.ts") = await importOriginal();
  return {
    ...real,
    streamBlobs: async function* (repo: string, oids: readonly string[], holdLimit: number) {
      seen.calls.push({ oids: [...oids], holdLimit });
      let count = 0;
      for await (const blob of real.streamBlobs(repo, oids, holdLimit)) {
        if (seen.mode === "short") return;
        count++;
        if (seen.mode === "wrongOid") yield { ...blob, oid: "f".repeat(40) };
        else if (seen.mode === "held") yield { ...blob, content: null };
        else yield blob;
      }
      return count;
    },
  };
});

const { readSources } = await import("./history.ts");
const { GitError } = await import("./git.ts");

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
  seen.calls = [];
  seen.mode = "real";
});
afterEach(() => repo.remove());

describe("readSources reads blobs as a stream", () => {
  it("streams each distinct oid once, holding at most maxBytes, and keeps path order", async () => {
    repo.write("b.py", "x = 1\n");
    repo.write("a.py", "x = 1\n");
    repo.write("c.txt", "caf\u00e9\n");
    repo.write("logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
    repo.write("big.txt", "z".repeat(500));
    const sha = repo.commit("files");
    const sources = await readSources(repo.dir, sha, 100);
    expect([...sources]).toEqual([
      ["a.py", "x = 1\n"],
      ["b.py", "x = 1\n"],
      ["c.txt", "caf\u00e9\n"],
    ]);
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0]?.holdLimit).toBe(100);
    expect(seen.calls[0]?.oids).toHaveLength(new Set(seen.calls[0]?.oids).size);
    expect(seen.calls[0]?.oids).toHaveLength(3);
  });

  it("does not start git for a tree with nothing to read", async () => {
    repo.write("big.txt", "z".repeat(500));
    const sha = repo.commit("files");
    expect([...(await readSources(repo.dir, sha, 100))]).toEqual([]);
  });

  it("throws GitError when git returns fewer blobs than were requested", async () => {
    repo.write("a.py", "x = 1\n");
    const sha = repo.commit("files");
    seen.mode = "short";
    await expect(readSources(repo.dir, sha, 100)).rejects.toThrow(GitError);
    await expect(readSources(repo.dir, sha, 100)).rejects.toThrow(/missing content for/);
  });

  it("throws GitError when a returned oid is not the one requested", async () => {
    repo.write("a.py", "x = 1\n");
    const sha = repo.commit("files");
    seen.mode = "wrongOid";
    await expect(readSources(repo.dir, sha, 100)).rejects.toThrow(/cat-file returned f{40}/);
  });

  it("throws GitError when a blob within the limit comes back without its content", async () => {
    repo.write("a.py", "x = 1\n");
    const sha = repo.commit("files");
    seen.mode = "held";
    await expect(readSources(repo.dir, sha, 100)).rejects.toThrow(GitError);
  });
});
