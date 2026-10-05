import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

const seen = vi.hoisted(() => ({
  calls: [] as { oids: string[]; holdLimit: number }[],
  spawned: [] as string[][],
  mode: "real" as "real" | "short" | "wrongOid" | "held",
}));
vi.mock("node:child_process", async (importOriginal) => {
  const real: typeof import("node:child_process") = await importOriginal();
  return {
    ...real,
    spawn: ((command: string, args: readonly string[], ...rest: unknown[]) => {
      seen.spawned.push([command, ...args]);
      return (real.spawn as (...a: unknown[]) => unknown)(command, args, ...rest);
    }) as typeof real.spawn,
  };
});
vi.mock("./git.ts", async (importOriginal) => {
  const real: typeof import("./git.ts") = await importOriginal();
  return {
    ...real,
    streamBlobs: async function* (repo: string, oids: readonly string[], holdLimit: number) {
      seen.calls.push({ oids: [...oids], holdLimit });
      for await (const blob of real.streamBlobs(repo, oids, holdLimit)) {
        if (seen.mode === "short") return;
        if (seen.mode === "wrongOid") yield { ...blob, oid: "f".repeat(40) };
        else if (seen.mode === "held") yield { ...blob, content: null };
        else yield blob;
      }
    },
  };
});

const { readSources } = await import("./history.ts");
const { GitError } = await import("./git.ts");

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
  seen.calls = [];
  seen.spawned = [];
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
    expect(seen.spawned).toHaveLength(1);
    expect(seen.spawned[0]).toContain("cat-file");
  });

  it("does not start git for a tree with nothing to read", async () => {
    repo.write("big.txt", "z".repeat(500));
    const sha = repo.commit("files");
    expect([...(await readSources(repo.dir, sha, 100))]).toEqual([]);
    expect(seen.calls.every((call) => call.oids.length === 0)).toBe(true);
    expect(seen.spawned).toEqual([]);
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
