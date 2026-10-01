import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

const dropBlobs = vi.hoisted(() => ({ on: false }));
vi.mock("./git.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./git.ts")>();
  return {
    ...real,
    readBlobs: (repo: string, oids: readonly string[]) =>
      dropBlobs.on ? new Map<string, Buffer>() : real.readBlobs(repo, oids),
  };
});

const { indexRepo } = await import("./build-index.ts");
const { GitError } = await import("./git.ts");

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
  repo.write("a.py", "x = 1\n");
  repo.commit("add a");
});
afterEach(() => {
  dropBlobs.on = false;
  repo.remove();
});

describe("indexRepo with an incomplete blob read", () => {
  it("throws GitError for a listed blob whose content was not returned", async () => {
    dropBlobs.on = true;
    const attempt = indexRepo(repo.dir, "HEAD");
    await expect(attempt).rejects.toThrow(GitError);
    await expect(attempt).rejects.toThrow(/missing content for a\.py/);
  });
});
