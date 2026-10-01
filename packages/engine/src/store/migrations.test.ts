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
  it("(a) retired with no retire event gains a retire event that carries the manifest sha", () => {
    const path = tempDbPath();
    const old = new Database(path);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    const stored = makeManifest({
      features: [
        makeFeature({
          lineage: [{ kind: "create", sha: SHA_A }],
          status: { kind: "retired" },
        }),
      ],
      membership: {},
    });
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)")
      .run(stored.sha, JSON.stringify(stored));
    old.close();

    const store = openStore(path);
    const feature = store.getManifest(stored.sha)?.features[0];
    expect(feature?.lineage).toContainEqual({ kind: "retire", sha: stored.sha });
    expect(feature?.status).toEqual({ kind: "retired" });
    store.close();
  });

  it("(b) multiple endings are reduced to the one matching the status", () => {
    const path = tempDbPath();
    const old = new Database(path);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    const stored = makeManifest({
      features: [
        makeFeature({
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "retire", sha: SHA_B },
            { kind: "retire", sha: SHA_B },
          ],
          status: { kind: "retired" },
        }),
      ],
      membership: {},
    });
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)")
      .run(stored.sha, JSON.stringify(stored));
    old.close();

    const store = openStore(path);
    const feature = store.getManifest(stored.sha)?.features[0];
    const endings = feature?.lineage.filter((e) => ["merge", "split", "retire"].includes(e.kind));
    expect(endings?.length).toBe(1);
    expect(endings?.[0]?.kind).toBe("retire");
    store.close();
  });

  it("(c) duplicate creates are dropped", () => {
    const path = tempDbPath();
    const old = new Database(path);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    const stored = makeManifest({
      features: [
        makeFeature({
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "create", sha: SHA_B },
          ],
        }),
      ],
      membership: {},
    });
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)")
      .run(stored.sha, JSON.stringify(stored));
    old.close();

    const store = openStore(path);
    const feature = store.getManifest(stored.sha)?.features[0];
    const creates = feature?.lineage.filter((e) => e.kind === "create");
    expect(creates?.length).toBe(1);
    expect(creates?.[0]?.sha).toBe(SHA_A);
    store.close();
  });

  it("(d) an active feature with members and an ending stays active and keeps its members", () => {
    const path = tempDbPath();
    const old = new Database(path);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    const stored = makeManifest({
      features: [
        makeFeature({
          id: "signals",
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "merge", sha: SHA_B, into: "deliverables" },
          ],
          status: { kind: "active" },
        }),
      ],
      membership: { "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 } },
    });
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)")
      .run(stored.sha, JSON.stringify(stored));
    old.close();

    const store = openStore(path);
    const manifest = store.getManifest(stored.sha);
    const feature = manifest?.features[0];
    expect(feature?.status).toEqual({ kind: "active" });
    expect(manifest?.membership["src/signals/ingest.py#ingest_chunk"]).toEqual({
      featureId: "signals",
      weight: 0.9,
    });
    const endings = feature?.lineage.filter((e) => ["merge", "split", "retire"].includes(e.kind));
    expect(endings?.length).toBe(0);
    store.close();
  });

  it("(e) mutual merges, both features active, stay active with no cycle", () => {
    const path = tempDbPath();
    const old = new Database(path);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    const stored = makeManifest({
      features: [
        makeFeature({
          id: "feature-a",
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "merge", sha: SHA_B, into: "feature-b" },
          ],
          status: { kind: "active" },
        }),
        makeFeature({
          id: "feature-b",
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "merge", sha: SHA_B, into: "feature-a" },
          ],
          status: { kind: "active" },
        }),
      ],
      membership: {},
    });
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)")
      .run(stored.sha, JSON.stringify(stored));
    old.close();

    const store = openStore(path);
    const manifest = store.getManifest(stored.sha);
    const featureA = manifest?.features[0];
    const featureB = manifest?.features[1];
    expect(featureA?.status).toEqual({ kind: "active" });
    expect(featureB?.status).toEqual({ kind: "active" });
    const endingsA = featureA?.lineage.filter((e) => ["merge", "split", "retire"].includes(e.kind));
    const endingsB = featureB?.lineage.filter((e) => ["merge", "split", "retire"].includes(e.kind));
    expect(endingsA?.length).toBe(0);
    expect(endingsB?.length).toBe(0);
    store.close();
  });

  it("(f) idempotency: running the repair twice gives the same bodies", () => {
    const path = tempDbPath();
    const old = new Database(path);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    const stored = makeManifest({
      features: [
        makeFeature({
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "rename", sha: SHA_B, fromTitle: "Signals" },
            { kind: "retire", sha: SHA_B },
          ],
          status: { kind: "retired" },
        }),
      ],
      membership: {},
    });
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)")
      .run(stored.sha, JSON.stringify(stored));
    old.close();

    const store1 = openStore(path);
    const body1 = JSON.stringify(store1.getManifest(stored.sha));
    store1.close();

    const store2 = openStore(path);
    const body2 = JSON.stringify(store2.getManifest(stored.sha));
    store2.close();

    expect(body1).toBe(body2);
  });

  it("(g) an already-consistent manifest is byte-identical after the migration", () => {
    const path = tempDbPath();
    const old = new Database(path);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    const consistent = makeManifest({
      features: [
        makeFeature({
          aliases: ["signal pipeline", "Signals"],
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "rename", sha: SHA_B, fromTitle: "Signals" },
          ],
          status: { kind: "active" },
        }),
      ],
      membership: {},
    });
    const originalBody = JSON.stringify(consistent);
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)")
      .run(consistent.sha, originalBody);
    old.close();

    const store = openStore(path);
    const readBody = JSON.stringify(store.getManifest(consistent.sha));
    store.close();

    expect(readBody).toBe(originalBody);
  });

  it("(h) two stored manifests are both repaired", () => {
    const path = tempDbPath();
    const old = new Database(path);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    const sha1 = "1".repeat(40);
    const sha2 = "2".repeat(40);
    const manifest1 = makeManifest({
      sha: sha1,
      features: [
        makeFeature({
          lineage: [{ kind: "create", sha: SHA_A }],
          status: { kind: "retired" },
        }),
      ],
      membership: {},
    });
    const manifest2 = makeManifest({
      sha: sha2,
      features: [
        makeFeature({
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "create", sha: SHA_B },
          ],
        }),
      ],
      membership: {},
    });
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, ?, ?)")
      .run(manifest1.sha, 1, JSON.stringify(manifest1));
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, ?, ?)")
      .run(manifest2.sha, 2, JSON.stringify(manifest2));
    old.close();

    const store = openStore(path);
    const feature1 = store.getManifest(manifest1.sha)?.features[0];
    const feature2 = store.getManifest(manifest2.sha)?.features[0];
    expect(feature1?.lineage.filter((e) => e.kind === "retire").length).toBe(1);
    expect(feature2?.lineage.filter((e) => e.kind === "create").length).toBe(1);
    store.close();
  });

  it("(i) all repaired manifests parse successfully via store methods", () => {
    const path = tempDbPath();
    const old = new Database(path);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    const problematic = makeManifest({
      features: [
        makeFeature({
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "retire", sha: SHA_B },
          ],
          status: { kind: "active" },
        }),
      ],
      membership: {},
    });
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)")
      .run(problematic.sha, JSON.stringify(problematic));
    old.close();

    const store = openStore(path);
    const manifest = store.getManifest(problematic.sha);
    expect(manifest).toBeDefined();
    expect(manifest?.features[0]?.status).toEqual({ kind: "active" });
    store.close();
  });
});
