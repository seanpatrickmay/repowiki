import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

const dropBlobs = vi.hoisted(() => ({ on: false, wrongOid: false }));
vi.mock("./git.ts", async (importOriginal) => {
  const real: typeof import("./git.ts") = await importOriginal();
  return {
    ...real,
    streamBlobs: (repo: string, oids: readonly string[], holdLimit: number) =>
      dropBlobs.on
        ? (async function* () {})()
        : dropBlobs.wrongOid
          ? (async function* () {
              for await (const blob of real.streamBlobs(repo, oids, holdLimit)) {
                yield { ...blob, oid: "f".repeat(40) };
              }
            })()
          : real.streamBlobs(repo, oids, holdLimit),
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
  dropBlobs.wrongOid = false;
  repo.remove();
});

describe("indexRepo with an incomplete blob read", () => {
  it("throws GitError for a listed blob whose content was not returned", async () => {
    dropBlobs.on = true;
    const attempt = indexRepo(repo.dir, "HEAD");
    await expect(attempt).rejects.toThrow(GitError);
    await expect(attempt).rejects.toThrow(/missing content for a\.py/);
  });

  it("throws GitError for a blob whose returned oid is not the one requested", async () => {
    dropBlobs.wrongOid = true;
    const attempt = indexRepo(repo.dir, "HEAD");
    await expect(attempt).rejects.toThrow(GitError);
    await expect(attempt).rejects.toThrow(/cat-file returned f{40} for a\.py/);
  });
});
