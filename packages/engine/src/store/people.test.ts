import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RegistryRow, saltedKey } from "@repowiki/core";
import {
  makeManifest,
  makePeopleSnapshot,
  makePersonRevision,
  SHA_A,
  SHA_B,
} from "@repowiki/core/test-fixtures";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuplicateRevisionError, StalePersonParentError } from "./errors.ts";
import { MIGRATIONS, runMigrations } from "./migrations.ts";
import { openStore, type Store } from "./store.ts";

const KEY = (c: string) => c.repeat(64);
const row = (overrides: Partial<RegistryRow> = {}): RegistryRow => ({
  id: "ada-lovelace",
  order: 0,
  name: "Ada Lovelace",
  kind: "human",
  status: "active",
  to: null,
  keys: [KEY("1"), KEY("2")],
  ...overrides,
});

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => store.close());

describe("migration 10 (spec v2 #6 R29, C2)", () => {
  it("is the tenth migration", () => {
    // Not the count: a later milestone appends migrations (the Task 9 review's minor).
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(10);
    expect(String(MIGRATIONS[9])).toMatch(/CREATE TABLE people_registry/);
  });

  it("adds the four tables and a salt to a store at schema 9, keeping what it holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-people-"));
    try {
      const path = join(dir, "wiki.db");
      const old = new Database(path);
      runMigrations(old, MIGRATIONS.slice(0, 9));
      old.prepare("INSERT INTO meta (key, value) VALUES ('head', ?)").run(SHA_A);
      old.close();

      const reopened = openStore(path);
      expect(reopened.getHead()).toBe(SHA_A);
      expect(reopened.getPeopleSnapshot()).toBeNull();
      expect(reopened.listPeopleRegistry()).toEqual([]);
      const salt = reopened.getPeopleSalt();
      expect(salt).toMatch(/^[0-9a-f]{64}$/);
      reopened.close();

      const again = openStore(path);
      expect(again.getPeopleSalt()).toBe(salt);
      again.close();
      const after = new Database(path);
      expect(after.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      const tables = after
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "people_registry",
          "people_snapshot",
          "person_revisions",
          "blame_cache",
        ]),
      );
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives each store its own salt", () => {
    const other = openStore(":memory:");
    expect(other.getPeopleSalt()).not.toBe(store.getPeopleSalt());
    other.close();
  });
});

describe("the People snapshot and registry", () => {
  it("round-trips the snapshot, replaced whole, and clears it", () => {
    store.putPeopleSnapshot(makePeopleSnapshot());
    expect(store.getPeopleSnapshot()).toEqual(makePeopleSnapshot());
    store.putPeopleSnapshot(makePeopleSnapshot({ sha: SHA_B }));
    expect(store.getPeopleSnapshot()?.sha).toBe(SHA_B);
    store.clearPeopleSnapshot();
    expect(store.getPeopleSnapshot()).toBeNull();
  });

  it("refuses a snapshot that fails its schema, keeping the stored one", () => {
    store.putPeopleSnapshot(makePeopleSnapshot());
    expect(() => store.putPeopleSnapshot(makePeopleSnapshot({ totalLines: 1 }))).toThrow();
    expect(store.getPeopleSnapshot()).toEqual(makePeopleSnapshot());
  });

  it("replaces the registry whole, oldest row first", () => {
    store.putPeopleRegistry([row({ id: "b", order: 1 }), row({ id: "a", order: 0 })]);
    expect(store.listPeopleRegistry().map((r) => r.id)).toEqual(["a", "b"]);
    store.putPeopleRegistry([row({ id: "c", status: "redirect", to: "a", keys: [] })]);
    expect(store.listPeopleRegistry().map((r) => r.id)).toEqual(["c"]);
    expect(() => store.putPeopleRegistry([row(), row()])).toThrow(/share an id/);
    expect(() => store.putPeopleRegistry([row({ status: "redirect" })])).toThrow();
  });

  it("keeps People values in meta, but never replaces the salt", () => {
    expect(store.getPeopleMeta("blame-ignore")).toBeNull();
    store.setPeopleMeta("blame-ignore", "abc");
    expect(store.getPeopleMeta("blame-ignore")).toBe("abc");
    expect(() => store.setPeopleMeta("salt", "0")).toThrow(/never replaced/);
  });
});

describe("person revisions", () => {
  const first = makePersonRevision();
  const second = makePersonRevision({
    id: "person-ada-lovelace-bbbbbbbbbbbb-2",
    sha: SHA_B,
    parentId: first.id,
    reason: "update",
  });

  it("stores a chain, the newest current", () => {
    store.putPersonRevision(first);
    store.putPersonRevision(second);
    expect(store.getCurrentPersonRevision("ada-lovelace")).toEqual(second);
    expect(store.listPersonHistory("ada-lovelace")).toEqual([first, second]);
    expect(store.listCurrentPersonRevisions()).toEqual([second]);
    expect(store.getCurrentPersonRevision("grace-hopper")).toBeNull();
  });

  it("checks the parent the way the Architecture article's is checked", () => {
    expect(() => store.putPersonRevision(second)).toThrow(StalePersonParentError);
    store.putPersonRevision(first);
    expect(() => store.putPersonRevision(first)).toThrow(DuplicateRevisionError);
    expect(() =>
      store.putPersonRevision({ ...first, id: "person-ada-lovelace-aaaaaaaaaaaa-9" }),
    ).toThrow(StalePersonParentError);
  });

  it("lists each person's current revision by person id", () => {
    const grace = makePersonRevision({
      id: "person-grace-hopper-aaaaaaaaaaaa-1",
      personId: "grace-hopper",
    });
    store.putPersonRevision(grace);
    store.putPersonRevision(first);
    expect(store.listCurrentPersonRevisions().map((r) => r.personId)).toEqual([
      "ada-lovelace",
      "grace-hopper",
    ]);
  });

  it("forgets a person: every revision and the registry row", () => {
    store.putPersonRevision(first);
    store.putPersonRevision(second);
    store.putPeopleRegistry([row(), row({ id: "grace-hopper", order: 1, keys: [KEY("3")] })]);
    expect(store.forgetPerson("ada-lovelace")).toBe(2);
    expect(store.listPersonHistory("ada-lovelace")).toEqual([]);
    expect(store.listPeopleRegistry().map((r) => r.id)).toEqual(["grace-hopper"]);
  });

  it("forgets the redirects that point at a forgotten person, and keeps the others", () => {
    store.putPeopleRegistry([
      row(),
      row({ id: "ada-old", order: 1, status: "redirect", to: "ada-lovelace", keys: [] }),
      row({ id: "grace-hopper", order: 2, keys: [KEY("3")] }),
      row({ id: "grace-old", order: 3, status: "redirect", to: "grace-hopper", keys: [] }),
    ]);
    store.forgetPerson("ada-lovelace");
    expect(store.listPeopleRegistry().map((r) => r.id)).toEqual(["grace-hopper", "grace-old"]);
  });

  it("resolves a login, a name or an email through the salted keys (spec v2 #6 §6)", () => {
    const key = (k: string) => saltedKey(store.getPeopleSalt(), k);
    expect(store.resolvePerson({ login: "ada" })).toBeNull();
    store.putPeopleRegistry([
      row({ keys: [key("login:ada"), key("name:ada lovelace")].sort() }),
      row({
        id: "kim",
        order: 1,
        name: "Kim",
        status: "excluded",
        keys: [key("email:kim@example.com")],
      }),
      row({
        id: "dependabot-bot",
        order: 2,
        name: "dependabot[bot]",
        kind: "bot",
        keys: [key("login:dependabot[bot]")],
      }),
    ]);
    expect(store.resolvePerson({ login: "ADA" })).toEqual({ kind: "person", id: "ada-lovelace" });
    expect(store.resolvePerson({ name: "  Ada  LOVELACE " })).toEqual({
      kind: "person",
      id: "ada-lovelace",
    });
    expect(store.resolvePerson({ email: "Kim@Example.com" })).toEqual({ kind: "excluded" });
    expect(store.resolvePerson({ login: "dependabot[bot]" })).toEqual({ kind: "bot" });
    expect(store.resolvePerson({ login: "stranger" })).toBeNull();
  });

  it("resolves to the oldest row holding a key, whatever order the rows were stored in", () => {
    const key = saltedKey(store.getPeopleSalt(), "login:shared");
    store.putPeopleRegistry([
      row({ id: "newer", order: 5, name: "Newer", keys: [key] }),
      row({ id: "older", order: 1, name: "Older", keys: [key] }),
    ]);
    expect(store.resolvePerson({ login: "shared" })).toEqual({ kind: "person", id: "older" });
  });

  it("forgets a narrative and keeps the registry row (a withdrawn consent)", () => {
    store.putPersonRevision(first);
    store.putPeopleRegistry([row()]);
    // Another person's narrative survives it (the Task 21 review's minor).
    const grace = makePersonRevision({
      personId: "grace-hopper",
      id: first.id.replace("ada-lovelace", "grace-hopper"),
    });
    store.putPersonRevision(grace);
    expect(store.forgetPersonNarrative("ada-lovelace")).toBe(1);
    expect(store.getCurrentPersonRevision("ada-lovelace")).toBeNull();
    expect(store.getCurrentPersonRevision("grace-hopper")?.id).toBe(grace.id);
    expect(store.listPeopleRegistry().map((r) => r.id)).toEqual(["ada-lovelace"]);
  });
});

describe("the blame cache (spec v2 #6 R3)", () => {
  const oid = "d".repeat(40);

  it("round-trips runs by path and blob, and misses a damaged row", () => {
    store.putBlameRuns("src/a.py", oid, [
      [SHA_A, 3],
      [SHA_B, 2],
    ]);
    expect(store.getBlameRuns("src/a.py", oid)).toEqual([
      [SHA_A, 3],
      [SHA_B, 2],
    ]);
    expect(store.getBlameRuns("src/a.py", "e".repeat(40))).toBeNull();
    expect(() => store.putBlameRuns("../a.py", oid, [])).toThrow(/repository path/);
    expect(() => store.putBlameRuns("a.py", oid, [[SHA_A, 0]])).toThrow();
  });

  it("prunes rows whose path and blob are not kept, and clears", () => {
    store.putBlameRuns("a.py", oid, [[SHA_A, 1]]);
    store.putBlameRuns("b.py", oid, [[SHA_A, 1]]);
    expect(store.pruneBlameCache([{ path: "a.py", oid }])).toBe(1);
    expect(store.getBlameRuns("b.py", oid)).toBeNull();
    store.clearBlameCache();
    expect(store.getBlameRuns("a.py", oid)).toBeNull();
  });
});

describe("listManifests", () => {
  it("lists every stored manifest, newest first", () => {
    store.putManifest(makeManifest());
    store.putManifest(makeManifest({ sha: SHA_B }));
    expect(store.listManifests().map((m) => m.sha)).toEqual([SHA_B, SHA_A]);
  });
});

describe("People's store under real Node (M3 ruling)", () => {
  it("stores and reads a snapshot outside vitest", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-people-node-"));
    try {
      const index = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
      const fixtures = fileURLToPath(
        new URL("../../../core/src/test-fixtures.ts", import.meta.url),
      );
      const script = `
import { openStore } from ${JSON.stringify(index)};
import { makePeopleSnapshot } from ${JSON.stringify(fixtures)};
const store = openStore(${JSON.stringify(join(dir, "wiki.db"))});
store.putPeopleSnapshot(makePeopleSnapshot());
console.log(store.getPeopleSnapshot().people.length, store.getPeopleSalt().length);
store.close();
`;
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      }).trim();
      expect(out).toBe("3 64");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
