import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo, GitError, type TestRepo } from "../index/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { blameTree, ignoreRevsFrom, isLockfile } from "./ownership.ts";

const ADA = { name: "Ada", email: "ada@example.com" };
const BOB = { name: "Bob", email: "bob@example.com" };

let repo: TestRepo;
let store: Store;
beforeEach(() => {
  repo = createTestRepo();
  store = openStore(":memory:");
});
afterEach(() => {
  store.close();
  repo.remove();
});

/** a.py by Ada, b.py by Bob, plus a lockfile, a binary and a large file. */
function tree(): { head: string; ada: string; bob: string } {
  repo.write("a.py", "a = 1\nb = 2\n");
  const ada = repo.commit("feat: a", "+0000", ADA);
  repo.write("b.py", "c = 3\n");
  repo.write("pnpm-lock.yaml", "lock: 1\n");
  repo.write("logo.png", Buffer.from([0x89, 0x50, 0, 1]));
  repo.write("big.txt", "x\n".repeat(600));
  const bob = repo.commit("feat: b", "+0000", BOB);
  return { head: bob, ada, bob };
}

describe("ignoreRevsFrom (spec v2 #6 R4)", () => {
  it("keeps full shas of known commits, in order, once, and skips everything else", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const text = `# sweeps\n${a}\n${"c".repeat(40)}\n${b.toUpperCase()}\nabc1234\n${a}\n`;
    expect(ignoreRevsFrom(text, new Set([a, b]))).toEqual([a, b]);
  });
});

describe("isLockfile", () => {
  it("knows the lockfiles of R20 by name, in any directory", () => {
    expect(isLockfile("web/package-lock.json")).toBe(true);
    expect(isLockfile("go.sum")).toBe(true);
    expect(isLockfile("lock.py")).toBe(false);
  });
});

describe("blameTree (spec v2 #6 R1, R3, R20)", () => {
  it("blames each text file, skipping lockfiles, binaries and large files", async () => {
    const { head, ada, bob } = tree();
    const owned = await blameTree(repo.dir, head, store, { ignoreRevs: [], maxFileBytes: 1000 });
    expect([...owned.files]).toEqual([
      ["a.py", [[ada, 2]]],
      ["b.py", [[bob, 1]]],
    ]);
    expect([owned.skipped, owned.blamed, owned.cached, owned.timedOut, owned.unattributed]).toEqual(
      [3, 2, 0, [], []],
    );
  });

  it("answers an unchanged blob from the cache and blames only what changed", async () => {
    const { head } = tree();
    await blameTree(repo.dir, head, store, { ignoreRevs: [], maxFileBytes: 1000 });
    repo.write("b.py", "c = 3\nd = 4\n");
    const next = repo.commit("feat: d", "+0000", ADA);
    const owned = await blameTree(repo.dir, next, store, { ignoreRevs: [], maxFileBytes: 1000 });
    expect([owned.blamed, owned.cached]).toEqual([1, 1]);
    expect(owned.files.get("b.py")).toEqual([
      [head, 1],
      [next, 1],
    ]);
  });

  it("prunes the cache to the head's blobs, and rebuilds it on request", async () => {
    const { head } = tree();
    await blameTree(repo.dir, head, store, { ignoreRevs: [], maxFileBytes: 1000 });
    repo.write("b.py", "changed\n");
    const next = repo.commit("feat: change", "+0000", ADA);
    await blameTree(repo.dir, next, store, { ignoreRevs: [], maxFileBytes: 1000 });
    const old = await blameTree(repo.dir, head, store, { ignoreRevs: [], maxFileBytes: 1000 });
    expect([old.blamed, old.cached]).toEqual([1, 1]);
    const rebuilt = await blameTree(repo.dir, head, store, {
      ignoreRevs: [],
      maxFileBytes: 1000,
      rebuild: true,
    });
    expect([rebuilt.blamed, rebuilt.cached]).toEqual([2, 0]);
  });

  it("drops the cache when the ignore list changes", async () => {
    const { head, ada } = tree();
    await blameTree(repo.dir, head, store, { ignoreRevs: [], maxFileBytes: 1000 });
    const owned = await blameTree(repo.dir, head, store, { ignoreRevs: [ada], maxFileBytes: 1000 });
    expect(owned.cached).toBe(0);
  });

  it("reports a file whose blame timed out, with its lines, and caches nothing for it", async () => {
    const { head } = tree();
    const owned = await blameTree(repo.dir, head, store, {
      ignoreRevs: [],
      maxFileBytes: 1000,
      timeoutMs: 1,
      concurrency: 1,
    });
    expect(owned.timedOut).toEqual([
      { path: "a.py", lines: 2 },
      { path: "b.py", lines: 1 },
    ]);
    expect(owned.files.size).toBe(0);
    const again = await blameTree(repo.dir, head, store, { ignoreRevs: [], maxFileBytes: 1000 });
    expect(again.cached).toBe(0);
  });

  it("leaves every file unattributed, never aborting, when the repository's config breaks blame", async () => {
    const { head } = tree();
    repo.git("config", "blame.ignoreRevsFile", "no-such-file");
    const owned = await blameTree(repo.dir, head, store, { ignoreRevs: [], maxFileBytes: 1000 });
    expect(owned.files.size).toBe(0);
    expect(owned.unattributed.map(({ path, lines }) => [path, lines])).toEqual([
      ["a.py", 2],
      ["b.py", 1],
    ]);
    for (const { cause } of owned.unattributed) expect(cause).toMatch(/blame\.ignoreRevsFile/);
    repo.git("config", "--unset", "blame.ignoreRevsFile");
    const again = await blameTree(repo.dir, head, store, { ignoreRevs: [], maxFileBytes: 1000 });
    expect([again.cached, again.blamed, again.unattributed]).toEqual([0, 2, []]);
  });

  it("gives the same answer whatever the concurrency", async () => {
    const { head } = tree();
    const one = await blameTree(repo.dir, head, store, {
      ignoreRevs: [],
      concurrency: 1,
      rebuild: true,
    });
    const four = await blameTree(repo.dir, head, store, {
      ignoreRevs: [],
      concurrency: 4,
      rebuild: true,
    });
    expect([...four.files]).toEqual([...one.files]);
  });

  it("skips and counts a tracked path that is not a valid repository path", async () => {
    const { head } = tree();
    repo.write("a\\b.py", "x = 1\n");
    const next = repo.commit("feat: odd path", "+0000", ADA);
    const owned = await blameTree(repo.dir, next, store, { ignoreRevs: [], maxFileBytes: 1000 });
    expect([...owned.files.keys()]).toEqual(["a.py", "b.py"]);
    expect(owned.skipped).toBe(4);
    expect(head).not.toBe(next);
  });

  it("stops the pool at the first failure that is not a timeout", async () => {
    for (let i = 0; i < 10; i++) repo.write(`f${i}.py`, `${i}\n`);
    const head = repo.commit("feat: many", "+0000", ADA);
    let calls = 0;
    const failing = async () => {
      calls++;
      await new Promise((done) => setTimeout(done, 20));
      throw new GitError("git blame failed: boom");
    };
    await expect(
      blameTree(repo.dir, head, store, { ignoreRevs: [], concurrency: 2, blame: failing }),
    ).rejects.toThrow(/boom/);
    await new Promise((done) => setTimeout(done, 100));
    expect(calls).toBe(2);
  });

  it("refuses a concurrency that is not a whole number of at least 1", async () => {
    const { head } = tree();
    for (const concurrency of [0, -1, 1.5, Number.NaN])
      await expect(
        blameTree(repo.dir, head, store, { ignoreRevs: [], concurrency }),
        String(concurrency),
      ).rejects.toThrow(/concurrency/);
  });
});
