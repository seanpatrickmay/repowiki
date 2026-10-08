import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PeopleConfig } from "@repowiki/core";
import { makeFeature } from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredEmail,
  createTestRepo,
  GitError,
  GitTimeoutError,
  type TestRepo,
} from "../index/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { readPeople, refreshPeople } from "./refresh.ts";

const ADA = { name: "Ada Lovelace", email: "ada@example.com" };
const BOB = { name: "bob", email: "bob@example.com" };

let repo: TestRepo;
let store: Store;
let head: string;
beforeEach(() => {
  repo = createTestRepo();
  store = openStore(":memory:");
  repo.write(".mailmap", "Robert Jones <bob@example.com>\n");
  repo.write("src/a.py", "a = 1\nb = 2\n");
  const first = repo.commit("feat: a", "+0000", ADA);
  repo.write("src/a.py", "a = 1\nb = 3\n");
  head = repo.commit("fix: b", "+0000", BOB);
  repo.write(".git-blame-ignore-revs", `${head}\n`);
  head = repo.commit("chore: ignore the fix", "+0000", ADA);
  store.putManifest({
    sha: head,
    features: [
      makeFeature({
        id: "core",
        title: "Core",
        aliases: [],
        lineage: [{ kind: "create", sha: first }],
      }),
    ],
    membership: { "src/a.py": { featureId: "core", weight: 1 } },
  });
  store.setHead(head);
  // The work tree's mailmap is not the committed one.
  repo.write(".mailmap", "Someone Else <bob@example.com>\n");
});
afterEach(() => {
  store.close();
  repo.remove();
});

const input = (file: unknown = {}) => ({
  repo: repo.dir,
  sha: head,
  store,
  config: PeopleConfig.parse(file),
  ownerEmail: null,
  lock: null,
});

describe("readPeople (spec v2 #6 §4 steps 1-3)", () => {
  it("reads the committed mailmap and ignore-revs, and writes nothing", () => {
    const read = readPeople(input());
    expect(read.identities.groups.map((g) => g.name)).toEqual(["Ada Lovelace", "Robert Jones"]);
    expect(read.assigned.ids).toEqual(["ada-lovelace", "robert-jones"]);
    expect(read.ignoreRevs).toHaveLength(1);
    expect(readPeople(input({ ignoreRevs: false })).ignoreRevs).toEqual([]);
    expect(store.listPeopleRegistry()).toEqual([]);
    expect(store.getPeopleSnapshot()).toBeNull();
  });

  it("stops every git read at its time limit", () => {
    expect(() => readPeople({ ...input(), timeouts: { logMs: 1 } })).toThrow(GitTimeoutError);
    expect(() => readPeople({ ...input(), timeouts: { readMs: 1 } })).toThrow(GitTimeoutError);
  });

  it("warns of a malformed mailmap line and an unmatched key, naming no email", () => {
    const read = readPeople(input({ exclude: ["email:nobody@example.com"] }));
    expect(read.warnings).toEqual(["people file: an email: key matches no author"]);
  });
});

describe("readPeople and unusable author dates (the I3 ruling)", () => {
  it("counts the commits whose author date it could not use, in one warning", () => {
    const body = repo
      .git("cat-file", "commit", head)
      .replace(/^(author .*>) \d+ [+-]\d{4}$/m, "$1 253402300800 +0000");
    repo.write(".git/crafted", `${body}\n`);
    head = repo.git("hash-object", "--literally", "-t", "commit", "-w", ".git/crafted");
    expect(readPeople(input()).warnings).toEqual([
      "1 commit with an unreadable author date: counted, but left out of activity and first and last dates",
    ]);
  });
});

describe("refreshPeople (spec v2 #6 §4 steps 4-5)", () => {
  it("stores the snapshot and the registry together, honouring the ignore list", async () => {
    const refreshed = await refreshPeople(input());
    expect(store.getPeopleSnapshot()).toEqual(refreshed.snapshot);
    expect(store.listPeopleRegistry().map((r) => r.id)).toEqual(["ada-lovelace", "robert-jones"]);
    const lines = Object.fromEntries(refreshed.snapshot.people.map((p) => [p.id, p.currentLines]));
    // Bob's fix is listed in .git-blame-ignore-revs, so its line goes back to Ada (who also
    // wrote .mailmap and the ignore list: 4 lines in all).
    expect(lines).toEqual({ "ada-lovelace": 4, "robert-jones": 0 });
  });

  it("gives the same snapshot on a second run, from the blame cache", async () => {
    const first = await refreshPeople(input());
    const second = await refreshPeople(input());
    expect(JSON.stringify(second.snapshot)).toBe(JSON.stringify(first.snapshot));
    expect([second.ownership.blamed, second.ownership.cached]).toEqual([0, 3]);
  });

  it("counts lines unattributed, with one warning naming the cause, when config breaks blame", async () => {
    repo.git("config", "blame.ignoreRevsFile", "no-such-file");
    const refreshed = await refreshPeople(input());
    expect(refreshed.snapshot.unattributedLines).toBe(refreshed.snapshot.totalLines);
    expect(refreshed.snapshot.totalLines).toBeGreaterThan(0);
    const warnings = refreshed.warnings.filter((w) => w.includes("blame"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^blame could not run for 3 files, whose lines are unattributed: /);
    expect(warnings[0]).toMatch(/blame\.ignoreRevsFile/);
  });

  it("keeps the stored registry and snapshot byte for byte on a second run", async () => {
    await refreshPeople(input());
    const registry = JSON.stringify(store.listPeopleRegistry());
    const snapshot = JSON.stringify(store.getPeopleSnapshot());
    await refreshPeople(input());
    expect(JSON.stringify(store.listPeopleRegistry())).toBe(registry);
    expect(JSON.stringify(store.getPeopleSnapshot())).toBe(snapshot);
  });

  it("stores the registry and the snapshot together, or neither", async () => {
    vi.spyOn(store, "putPeopleSnapshot").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(refreshPeople(input())).rejects.toThrow(/disk full/);
    expect(store.listPeopleRegistry()).toEqual([]);
  });

  it("asserts the caller holds the out dir's build lock", async () => {
    const lock = join(repo.dir, "..", `lock-${process.pid}-${Date.now()}`);
    try {
      await expect(refreshPeople({ ...input(), lock })).rejects.toThrow(/build lock/);
      writeFileSync(lock, "pid 1 since 2026-01-01T00:00:00.000Z id x\n");
      await expect(refreshPeople({ ...input(), lock })).rejects.toThrow(/build lock/);
      writeFileSync(lock, `pid ${process.pid} since 2026-01-01T00:00:00.000Z id x\n`);
      await expect(refreshPeople({ ...input(), lock })).resolves.toBeDefined();
    } finally {
      rmSync(lock, { force: true });
    }
    expect(existsSync(lock)).toBe(false);
  });

  it("refuses a store with no manifest", async () => {
    const empty = openStore(":memory:");
    try {
      await expect(refreshPeople({ ...input(), store: empty })).rejects.toThrow(/wiki:build/);
    } finally {
      empty.close();
    }
  });
});

describe("configuredEmail (planner ruling R3)", () => {
  it("reads the repository's user.email, and null when none is set", () => {
    const saved = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_NOSYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      expect(configuredEmail(repo.dir)).toBeNull();
      repo.git("config", "user.email", "Owner@Example.com");
      expect(configuredEmail(repo.dir)).toBe("Owner@Example.com");
      // Any other failure is an error, never a silent "no owner".
      expect(() => configuredEmail(repo.dir, { timeoutMs: 1 })).toThrow(GitTimeoutError);
      expect(() => configuredEmail(join(repo.dir, "no-such-dir"))).toThrow(GitError);
    } finally {
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved.global;
      if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = saved.system;
    }
  });
});
