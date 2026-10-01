import type Database from "better-sqlite3";
import { UnsupportedSchemaError } from "./errors.ts";

/**
 * Ordered schema migrations. Entry i upgrades a database from user_version i to i + 1.
 * Never edit a shipped entry; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
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
];

export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.length) throw new UnsupportedSchemaError(current, MIGRATIONS.length);
  db.transaction(() => {
    for (const [index, sql] of MIGRATIONS.entries()) {
      if (index < current) continue;
      db.exec(sql);
      db.pragma(`user_version = ${index + 1}`);
    }
  })();
}
