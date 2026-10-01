import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeFeature, makeManifest, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { UnsupportedSchemaError } from "./errors.ts";
import { MIGRATIONS, type Migration, runMigrations } from "./migrations.ts";
import { openStore } from "./store.ts";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-store-"));
  dirs.push(dir);
  return join(dir, "wiki.db");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("brings a new database to the latest schema version", () => {
    const path = tempDbPath();
    openStore(path).close();
    const db = new Database(path);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });

  it("keeps data across reopen without re-running migrations", () => {
    const path = tempDbPath();
    const first = openStore(path);
    first.putManifest(makeManifest());
    first.close();
    const second = openStore(path);
    expect(second.getManifest(makeManifest().sha)).toEqual(makeManifest());
    second.close();
  });

  it("refuses a database written by a newer RepoWiki and leaves it untouched", () => {
    const path = tempDbPath();
    const db = new Database(path);
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    const bytesBefore = readFileSync(path);
    const filesBefore = readdirSync(dirname(path));
    expect(() => openStore(path)).toThrow(UnsupportedSchemaError);
    expect(readFileSync(path).equals(bytesBefore)).toBe(true);
    expect(readdirSync(dirname(path))).toEqual(filesBefore);
    const after = new Database(path);
    expect(after.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length + 1);
    after.close();
  });

  describe("runMigrations", () => {
    const tableExists = (db: Database.Database, name: string): boolean =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
      undefined;

    it("runs SQL and function migrations in order and records the version", () => {
      const db = new Database(":memory:");
      const migrations: Migration[] = [
        "CREATE TABLE notes (body TEXT NOT NULL)",
        (handle) => {
          handle.prepare("INSERT INTO notes (body) VALUES (?)").run("rewritten");
        },
      ];
      runMigrations(db, migrations);
      expect(db.prepare("SELECT body FROM notes").all()).toEqual([{ body: "rewritten" }]);
      expect(db.pragma("user_version", { simple: true })).toBe(2);
      db.close();
    });

    it("only runs the migrations a database has not seen", () => {
      const db = new Database(":memory:");
      const calls: number[] = [];
      const migrations: Migration[] = [
        () => {
          calls.push(1);
        },
        () => {
          calls.push(2);
        },
      ];
      runMigrations(db, migrations.slice(0, 1));
      runMigrations(db, migrations);
      expect(calls).toEqual([1, 2]);
      expect(db.pragma("user_version", { simple: true })).toBe(2);
      db.close();
    });

    it("rolls back the schema change and the version when a function migration throws", () => {
      const db = new Database(":memory:");
      const migrations: Migration[] = [
        "CREATE TABLE notes (body TEXT NOT NULL)",
        () => {
          throw new Error("rewrite failed");
        },
      ];
      expect(() => runMigrations(db, migrations)).toThrow("rewrite failed");
      expect(tableExists(db, "notes")).toBe(false);
      expect(db.pragma("user_version", { simple: true })).toBe(0);
      db.close();
    });
  });
});

describe("migration 2: two-way lineage and status", () => {
  it("repairs manifests stored under the one-way rules", () => {
    const path = tempDbPath();
    const old = new Database(path);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    const stored = makeManifest({
      features: [
        makeFeature({
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "rename", sha: SHA_B, fromTitle: "Signals" },
          ],
        }),
        makeFeature({
          id: "deliverables",
          title: "Deliverables",
          aliases: [],
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "retire", sha: SHA_B },
          ],
        }),
      ],
      membership: { "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 } },
    });
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)")
      .run(stored.sha, JSON.stringify(stored));
    old.close();

    const store = openStore(path);
    const [signals, deliverables] = store.getManifest(stored.sha)?.features ?? [];
    expect(signals?.aliases).toEqual(["signal pipeline", "Signals"]);
    expect(deliverables?.status).toEqual({ kind: "retired" });
    store.close();
  });
});
