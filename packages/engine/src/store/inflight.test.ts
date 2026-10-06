import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLlmsTxt } from "@repowiki/core";
import {
  makeGitHubSnapshot,
  makeInFlight,
  makeInFlightPull,
  makeManifest,
  makeRevision,
  SHA_A,
  SHA_B,
} from "@repowiki/core/test-fixtures";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExport, writeExport } from "./export.ts";
import { MIGRATIONS, runMigrations } from "./migrations.ts";
import { openStore, type Store } from "./store.ts";

const KEY_1 = "1".repeat(64);
const KEY_2 = "2".repeat(64);
const AT = "2026-10-03T10:00:00Z";
const options = { repo: "demo", exportedAt: "2026-10-03T11:00:00Z" };
const summary = makeInFlightPull().summary;
if (summary === null) throw new Error("the fixture pull request has a summary");

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => store.close());

describe("migration 9 (spec v2 #9 §5.2, C2)", () => {
  it("is the ninth migration, so a later milestone's own appends nothing here", () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(9);
    expect(String(MIGRATIONS[8])).toMatch(/CREATE TABLE github_snapshot/);
  });

  it("gives a migrated store the same schema as a fresh one", () => {
    const schema = (db: Database.Database) =>
      db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const fresh = new Database(":memory:");
    runMigrations(fresh, MIGRATIONS.slice(0, 9));
    const migrated = new Database(":memory:");
    runMigrations(migrated, MIGRATIONS.slice(0, 8));
    runMigrations(migrated, MIGRATIONS.slice(0, 9));
    expect(schema(migrated)).toEqual(schema(fresh));
    fresh.close();
    migrated.close();
  });

  it("prunes the summary cache in one pass, keeping what a kept head cites", () => {
    store.putInFlightSummary(KEY_1, summary as NonNullable<typeof summary>, AT);
    store.putInFlightSummary(KEY_2, summary as NonNullable<typeof summary>, AT);
    const head = summary?.claims[0]?.citations[0]?.sha ?? "";
    expect(store.pruneInFlightSummaries([KEY_1], [head])).toBe(0);
    expect(store.pruneInFlightSummaries([KEY_1])).toBe(1);
    expect([store.getInFlightSummary(KEY_1), store.getInFlightSummary(KEY_2)]).toEqual([
      summary,
      null,
    ]);
  });

  it("adds the three tables to a store at schema 8 without touching what it holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-inflight-"));
    try {
      const path = join(dir, "wiki.db");
      const old = new Database(path);
      runMigrations(old, MIGRATIONS.slice(0, 8));
      old.prepare("INSERT INTO meta (key, value) VALUES ('head', ?)").run(SHA_A);
      old.close();

      const reopened = openStore(path);
      expect(reopened.getHead()).toBe(SHA_A);
      expect(reopened.getInFlight()).toBeNull();
      expect(reopened.getGitHubSnapshot()).toBeNull();
      reopened.putInFlight(makeInFlight());
      reopened.close();

      const after = new Database(path);
      expect(after.pragma("user_version", { simple: true })).toBe(9);
      const tables = after
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual(
        expect.arrayContaining(["github_snapshot", "inflight", "inflight_summaries"]),
      );
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the work-in-flight snapshots", () => {
  it("round-trips the GitHub snapshot and the derived one, each replaced whole", () => {
    store.putGitHubSnapshot(makeGitHubSnapshot());
    store.putInFlight(makeInFlight());
    expect(store.getGitHubSnapshot()).toEqual(makeGitHubSnapshot());
    expect(store.getInFlight()).toEqual(makeInFlight());
    store.putInFlight(makeInFlight({ pulls: [], issues: [] }));
    expect(store.getInFlight()?.pulls).toEqual([]);
  });

  it("refuses a body that fails its schema, and stores nothing", () => {
    const hostile = makeInFlight({ pulls: [makeInFlightPull({ title: "two\nlines" })] });
    expect(() => store.putInFlight(hostile)).toThrow();
    expect(store.getInFlight()).toBeNull();
  });

  it("clears both snapshots and keeps the summary cache", () => {
    store.putGitHubSnapshot(makeGitHubSnapshot());
    store.putInFlight(makeInFlight());
    store.putInFlightSummary(KEY_1, summary, AT);
    store.clearInFlight();
    expect(store.getGitHubSnapshot()).toBeNull();
    expect(store.getInFlight()).toBeNull();
    expect(store.getInFlightSummary(KEY_1)).toEqual(summary);
  });
});

describe("the summary cache", () => {
  it("returns a summary by its request key, and null for a key it never stored", () => {
    store.putInFlightSummary(KEY_1, summary, AT);
    expect(store.getInFlightSummary(KEY_1)).toEqual(summary);
    expect(store.getInFlightSummary(KEY_2)).toBeNull();
  });

  it("refuses a key that is not a SHA-256 digest, and a summary that fails its schema", () => {
    expect(() => store.putInFlightSummary("short", summary, AT)).toThrow();
    expect(() => store.putInFlightSummary(KEY_1, { ...summary, claims: [] }, AT)).toThrow();
    expect(store.getInFlightSummary(KEY_1)).toBeNull();
  });

  it("reads a row that no longer parses as a miss", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-inflight-"));
    try {
      const path = join(dir, "wiki.db");
      openStore(path).close();
      const db = new Database(path);
      db.prepare(
        "INSERT INTO inflight_summaries (request_key, body, created_at) VALUES (?, ?, ?)",
      ).run(KEY_1, "{not json", AT);
      db.prepare(
        "INSERT INTO inflight_summaries (request_key, body, created_at) VALUES (?, ?, ?)",
      ).run(KEY_2, JSON.stringify({ model: "m" }), AT);
      db.close();
      const reopened = openStore(path);
      expect(reopened.getInFlightSummary(KEY_1)).toBeNull();
      expect(reopened.getInFlightSummary(KEY_2)).toBeNull();
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes every key the snapshot no longer uses", () => {
    store.putInFlightSummary(KEY_1, summary, AT);
    store.putInFlightSummary(KEY_2, summary, AT);
    expect(store.pruneInFlightSummaries([KEY_2])).toBe(1);
    expect(store.getInFlightSummary(KEY_1)).toBeNull();
    expect(store.getInFlightSummary(KEY_2)).toEqual(summary);
    expect(store.pruneInFlightSummaries([])).toBe(1);
  });
});

describe("buildExport with work in flight", () => {
  beforeEach(() => {
    store.putManifest(makeManifest());
    store.putRevision(makeRevision());
    store.setHead(SHA_A);
  });

  it("exports null when no snapshot is stored", () => {
    expect(buildExport(store, options).inflight).toBeNull();
  });

  it("carries the stored snapshot", () => {
    store.putInFlight(makeInFlight());
    expect(buildExport(store, options).inflight).toEqual(makeInFlight());
  });

  it("keeps a snapshot derived against an older head, which the site shows as stale", () => {
    store.putInFlight(makeInFlight());
    store.putRevision(
      makeRevision({ id: "rev-2", parentId: "rev-1", reason: "update", sha: SHA_B }),
    );
    store.setHead(SHA_B);
    expect(buildExport(store, options).inflight?.wikiHead).toBe(SHA_A);
  });

  it("leaves out a snapshot that names a claim the current pages lack, instead of failing", () => {
    const pull = makeInFlightPull();
    const ghost = { ...pull.effects[0], claimId: "c-9" } as (typeof pull.effects)[number];
    store.putInFlight(makeInFlight({ pulls: [{ ...pull, effects: [ghost] }] }));
    expect(buildExport(store, options).inflight).toBeNull();
  });

  it("lists no in-flight data in llms.txt (C11)", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-inflight-"));
    try {
      store.putInFlight(makeInFlight());
      writeExport(store, join(dir, "export.json"), options);
      const wiki = buildExport(store, options);
      const llms = readFileSync(join(dir, "llms.txt"), "utf8");
      expect(llms).toBe(renderLlmsTxt(wiki));
      expect(llms).not.toContain("Page through long chunks");
      expect(
        JSON.parse(readFileSync(join(dir, "export.json"), "utf8")).inflight.pulls,
      ).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
