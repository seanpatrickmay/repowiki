import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeFeature, makeManifest, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { UnsupportedSchemaError } from "./errors.ts";
import { MIGRATIONS, type Migration, runMigrations, verifyStoredManifests } from "./migrations.ts";
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

    it("verifies once, after the whole chain, so a later migration repairs a body first", () => {
      const db = new Database(":memory:");
      const seen: string[] = [];
      const migrations: Migration[] = [
        "CREATE TABLE notes (body TEXT NOT NULL)",
        (handle) => {
          handle.prepare("INSERT INTO notes (body) VALUES (?)").run("broken");
        },
        (handle) => {
          handle.prepare("UPDATE notes SET body = ?").run("repaired");
        },
      ];
      runMigrations(db, migrations, (handle) => {
        const row = handle.prepare("SELECT body FROM notes").get() as { body: string };
        seen.push(row.body);
      });
      expect(seen).toEqual(["repaired"]);
      db.close();
    });

    it("skips verification when the database is already up to date", () => {
      const db = new Database(":memory:");
      const migrations: Migration[] = ["CREATE TABLE notes (body TEXT NOT NULL)"];
      runMigrations(db, migrations);
      let calls = 0;
      runMigrations(db, migrations, () => {
        calls++;
      });
      expect(calls).toBe(0);
      db.close();
    });

    it("rolls back every migration and the version when verification throws", () => {
      const db = new Database(":memory:");
      const migrations: Migration[] = ["CREATE TABLE notes (body TEXT NOT NULL)"];
      expect(() =>
        runMigrations(db, migrations, () => {
          throw new Error("verify failed");
        }),
      ).toThrow("verify failed");
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
    const db = new Database(path);
    runMigrations(db, MIGRATIONS.slice(0, 1));
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
    db.prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)").run(
      stored.sha,
      JSON.stringify(stored),
    );

    // First pass: migration 2 only (migration 1 already ran above)
    runMigrations(db, MIGRATIONS.slice(0, 2));
    const after1 = db.prepare("SELECT body FROM manifests WHERE sha = ?").get(stored.sha) as {
      body: string;
    };
    // The first pass must have repaired something (the rename's fromTitle joins the aliases),
    // or the idempotency check below compares two untouched bodies.
    expect(after1.body).not.toBe(JSON.stringify(stored));

    // Reset user_version and rerun migration 2 to test idempotency
    db.pragma("user_version = 1");
    runMigrations(db, MIGRATIONS.slice(0, 2));
    const after2 = db.prepare("SELECT body FROM manifests WHERE sha = ?").get(stored.sha) as {
      body: string;
    };

    db.close();

    // First and second repair should produce identical results
    expect(after1.body).toBe(after2.body);
  });

  it("(g) an already-consistent manifest is byte-identical after the migration", () => {
    const path = tempDbPath();
    const db = new Database(path);
    runMigrations(db, MIGRATIONS.slice(0, 1));
    const consistent = makeManifest({
      features: [
        // active with renames (consistent: rename in lineage, fromTitle in aliases)
        makeFeature({
          id: "active-feature",
          aliases: ["signal pipeline", "Signals"],
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "rename", sha: SHA_B, fromTitle: "Signals" },
          ],
          status: { kind: "active" },
        }),
        // redirect with merge event
        makeFeature({
          id: "redirect-feature",
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "merge", sha: SHA_B, into: "target-feature" },
          ],
          status: { kind: "redirect", to: "target-feature" },
        }),
        // the target feature that redirect-feature merges into
        makeFeature({
          id: "target-feature",
          lineage: [{ kind: "create", sha: SHA_A }],
          status: { kind: "active" },
        }),
        // disambiguation with split event
        makeFeature({
          id: "disambiguation-feature",
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "split", sha: SHA_B, into: ["target-a", "target-b"] },
          ],
          status: { kind: "disambiguation", to: ["target-a", "target-b"] },
        }),
        // the target features that disambiguation-feature splits into
        makeFeature({
          id: "target-a",
          lineage: [{ kind: "create", sha: SHA_A }],
          status: { kind: "active" },
        }),
        makeFeature({
          id: "target-b",
          lineage: [{ kind: "create", sha: SHA_A }],
          status: { kind: "active" },
        }),
        // retired with retire event
        makeFeature({
          id: "retired-feature",
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "retire", sha: SHA_B },
          ],
          status: { kind: "retired" },
        }),
      ],
      membership: {},
    });
    const originalBody = JSON.stringify(consistent);
    db.prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)").run(
      consistent.sha,
      originalBody,
    );

    // Read raw body before migration
    const beforeRaw = db
      .prepare("SELECT body FROM manifests WHERE sha = ?")
      .get(consistent.sha) as {
      body: string;
    };

    db.close();

    // Run full migration (which includes migration 2 repair)
    const store = openStore(path);
    store.close();

    const db2 = new Database(path);
    // Read raw body after migration
    const afterRaw = db2
      .prepare("SELECT body FROM manifests WHERE sha = ?")
      .get(consistent.sha) as {
      body: string;
    };
    db2.close();

    // Raw bytes should be identical (no changes were needed)
    expect(afterRaw.body).toBe(beforeRaw.body);
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

  it("(i) unrepairable manifest causes openStore to throw, user_version stays 1, raw row unchanged", () => {
    const path = tempDbPath();
    const db = new Database(path);
    runMigrations(db, MIGRATIONS.slice(0, 1));
    // Store a manifest with a redirect to a feature that doesn't exist in the features array
    // This cannot be repaired because the target doesn't exist, violating the core schema
    const unrepairable = {
      sha: "3".repeat(40),
      seq: 1,
      features: [
        {
          id: "broken",
          title: "Broken",
          aliases: [],
          status: { kind: "redirect", to: "nonexistent-feature" },
          lineage: [{ kind: "create", sha: SHA_A }],
        },
      ],
      membership: {},
    };
    const unrepairableBody = JSON.stringify(unrepairable);
    db.prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)").run(
      unrepairable.sha,
      unrepairableBody,
    );

    // Read raw body before attempt
    const beforeRaw = db
      .prepare("SELECT body FROM manifests WHERE sha = ?")
      .get(unrepairable.sha) as {
      body: string;
    };
    const versionBefore = db.pragma("user_version", { simple: true }) as number;
    db.close();

    // Opening the store fails the post-chain check, after every migration has run
    expect(() => openStore(path)).toThrow(
      /manifest 3{40} does not match the current schema after migrating/,
    );

    // Verify that user_version is still 1 (rollback happened)
    const db2 = new Database(path);
    const versionAfter = db2.pragma("user_version", { simple: true }) as number;
    expect(versionAfter).toBe(versionBefore);

    // Verify that the raw row is unchanged (rollback happened)
    const afterRaw = db2
      .prepare("SELECT body FROM manifests WHERE sha = ?")
      .get(unrepairable.sha) as {
      body: string;
    };
    expect(afterRaw.body).toBe(beforeRaw.body);
    db2.close();
  });

  it("(j) migration 2 touches no core schema: alone, it leaves an invalid body in place", () => {
    const db = new Database(":memory:");
    runMigrations(db, MIGRATIONS.slice(0, 1));
    const invalid = brokenRedirect();
    db.prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)").run(
      invalid.sha,
      JSON.stringify(invalid),
    );
    expect(() => runMigrations(db, MIGRATIONS.slice(0, 2))).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();
  });

  it("(k) a later repair migration runs before the current-schema check", () => {
    const db = new Database(":memory:");
    runMigrations(db, MIGRATIONS.slice(0, 1));
    const invalid = brokenRedirect();
    db.prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)").run(
      invalid.sha,
      JSON.stringify(invalid),
    );
    // A future migration that rewrites bodies the current schema would otherwise reject.
    const addTarget: Migration = (handle) => {
      const row = handle.prepare("SELECT body FROM manifests").get() as { body: string };
      const body = JSON.parse(row.body) as { features: unknown[] };
      body.features.push(makeFeature({ id: "nonexistent-feature", aliases: [] }));
      handle.prepare("UPDATE manifests SET body = ?").run(JSON.stringify(body));
    };
    runMigrations(db, [...MIGRATIONS, addTarget], verifyStoredManifests);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length + 1);
    db.close();
  });
});

/** A manifest whose redirect target does not exist: no migration can repair it today. */
function brokenRedirect() {
  return {
    sha: "3".repeat(40),
    features: [
      {
        id: "broken",
        title: "Broken",
        aliases: [],
        status: { kind: "redirect", to: "nonexistent-feature" },
        lineage: [{ kind: "create", sha: SHA_A }],
      },
    ],
    membership: {},
  };
}
