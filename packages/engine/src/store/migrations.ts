import type Database from "better-sqlite3";
import { UnsupportedSchemaError } from "./errors.ts";

/** SQL to exec, or a function for changes SQL cannot express, such as rewriting JSON bodies. */
export type Migration = string | ((db: Database.Database) => void);

/**
 * Ordered schema migrations. Entry i upgrades a database from user_version i to i + 1.
 * Never edit a shipped entry; append a new one.
 */
export const MIGRATIONS: readonly Migration[] = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE manifests (
    sha TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    body TEXT NOT NULL
  );
  CREATE TABLE revisions (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    parent_id TEXT REFERENCES revisions(id),
    body TEXT NOT NULL
  );
  CREATE INDEX revisions_feature ON revisions(feature_id);
  CREATE TABLE current_revisions (
    feature_id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES revisions(id)
  );
  CREATE TABLE citation_ranges (
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    claim_id TEXT NOT NULL,
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL
  );
  CREATE INDEX citation_ranges_lookup ON citation_ranges(path, start_line, end_line);
  `,
  repairLineageStatus,
];

interface StoredFeature {
  aliases: string[];
  status: { kind: string; to?: string | string[] };
  lineage: { kind: string; fromTitle?: string; into?: string | string[] }[];
}

/**
 * Migration 2: lineage and status became two-way (issue #53). In every stored manifest, a rename's
 * old title joins the aliases, and an active feature with one merge, split, or retire event takes
 * the status that event implies. Works on raw JSON so later schema changes cannot alter it.
 */
function repairLineageStatus(db: Database.Database): void {
  const rows = db.prepare("SELECT sha, body FROM manifests").all() as {
    sha: string;
    body: string;
  }[];
  const update = db.prepare("UPDATE manifests SET body = ? WHERE sha = ?");
  for (const row of rows) {
    const manifest = JSON.parse(row.body) as { features: StoredFeature[] };
    for (const feature of manifest.features) {
      for (const event of feature.lineage) {
        if (event.kind === "rename" && event.fromTitle !== undefined) {
          if (!feature.aliases.includes(event.fromTitle)) feature.aliases.push(event.fromTitle);
        }
      }
      const endings = feature.lineage.filter((e) => ["merge", "split", "retire"].includes(e.kind));
      const ending = endings[0];
      if (feature.status.kind !== "active" || endings.length !== 1 || ending === undefined) {
        continue;
      }
      if (ending.kind === "retire") feature.status = { kind: "retired" };
      else if (ending.kind === "merge") feature.status = { kind: "redirect", to: ending.into };
      else feature.status = { kind: "disambiguation", to: ending.into };
    }
    update.run(JSON.stringify(manifest), row.sha);
  }
}

export function migrate(db: Database.Database): void {
  runMigrations(db, MIGRATIONS);
}

/** Applies the migrations a database has not seen, all in one transaction. */
export function runMigrations(db: Database.Database, migrations: readonly Migration[]): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > migrations.length) throw new UnsupportedSchemaError(current, migrations.length);
  db.transaction(() => {
    for (const [index, migration] of migrations.entries()) {
      if (index < current) continue;
      if (typeof migration === "string") db.exec(migration);
      else migration(db);
      db.pragma(`user_version = ${index + 1}`);
    }
  })();
}
