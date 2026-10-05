import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamedBlob } from "./git.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

const seen = vi.hoisted(() => ({ holdLimits: [] as number[], blobs: [] as StreamedBlob[] }));
vi.mock("./git.ts", async (importOriginal) => {
  const real: typeof import("./git.ts") = await importOriginal();
  return {
    ...real,
    streamBlobs: async function* (repo: string, oids: readonly string[], holdLimit: number) {
      seen.holdLimits.push(holdLimit);
      for await (const blob of real.streamBlobs(repo, oids, holdLimit)) {
        seen.blobs.push(blob);
        yield blob;
      }
    },
  };
});

const { indexRepo } = await import("./build-index.ts");

const LINES = 400_000;
let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
  seen.holdLimits = [];
  seen.blobs = [];
});
afterEach(() => repo.remove());

describe("indexRepo reads blobs as a stream", () => {
  it("never holds an oversized blob, yet still reports its size and line count", async () => {
    repo.write("small.py", "x = 1\n");
    repo.write("huge.py", "y = 2\n".repeat(LINES));
    repo.write("huge.bin", Buffer.concat([Buffer.from("abc"), Buffer.alloc(2_000_000, 0)]));
    repo.commit("add files");
    const index = await indexRepo(repo.dir, "HEAD", { maxFileBytes: 1000 });
    const file = (path: string) => index.files.find((f) => f.path === path);
    expect(file("huge.py")).toMatchObject({
      bytes: 6 * LINES,
      loc: LINES,
      skipped: "too-large",
      symbols: [],
    });
    expect(file("huge.bin")).toMatchObject({ bytes: 2_000_003, loc: 0, skipped: "binary" });
    expect(file("small.py")).toMatchObject({ loc: 1, skipped: null });

    const oversized = seen.blobs.filter((blob) => blob.size > 1000);
    expect(oversized.map((blob) => blob.size).sort()).toEqual([2_000_003, 6 * LINES]);
    for (const blob of oversized) {
      expect(blob.content).toBeNull();
      expect(blob.head.length).toBeLessThanOrEqual(8000);
    }
    expect(seen.blobs.find((blob) => blob.size === 6)?.content?.toString("utf8")).toBe("x = 1\n");
  });

  it("holds at most maxFileBytes per blob when parsing, and reads manifests whole", async () => {
    repo.write("package.json", JSON.stringify({ name: "root" }));
    repo.write("a.py", "x = 1\n");
    repo.commit("add files");
    await indexRepo(repo.dir, "HEAD", { maxFileBytes: 50 });
    expect(seen.holdLimits).toEqual([Number.POSITIVE_INFINITY, 50]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects maxFileBytes %s before reading anything",
    async (maxFileBytes) => {
      repo.write("a.py", "x = 1\n");
      repo.commit("add a");
      await expect(indexRepo(repo.dir, "HEAD", { maxFileBytes })).rejects.toThrow(RangeError);
      expect(seen.holdLimits).toEqual([]);
    },
  );
});
