import { PeopleConfig } from "@repowiki/core";
import { makeFeature } from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configuredEmail, createTestRepo, type TestRepo } from "../index/index.ts";
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

  it("warns of a malformed mailmap line and an unmatched key, naming no email", () => {
    const read = readPeople(input({ exclude: ["email:nobody@example.com"] }));
    expect(read.warnings).toEqual(["people file: an email: key matches no author"]);
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
    } finally {
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved.global;
      if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = saved.system;
    }
  });
});
