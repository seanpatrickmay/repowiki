import { Manifest } from "@repowiki/core";
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
  `
  CREATE TABLE ledger (
    seq INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX ledger_run ON ledger(run_id);
  `,
  "ALTER TABLE manifests ADD COLUMN llm_revised INTEGER NOT NULL DEFAULT 0",
  `
  CREATE TABLE batch_requests (
    request_key TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    custom_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE wikipedia_summaries (
    title TEXT PRIMARY KEY,
    body TEXT NOT NULL
  );
  `,
];

interface StoredFeature {
  aliases: string[];
  status: { kind: string; to?: string | string[] };
  lineage: {
    kind: string;
    sha?: string;
    fromTitle?: string;
    into?: string | string[];
  }[];
}

interface StoredManifest {
  sha: string;
  features: StoredFeature[];
  membership: Record<string, { featureId: string; weight: number }>;
}

/**
 * Migration 2: lineage and status became two-way (issue #53). STATUS IS AUTHORITATIVE.
 * For each feature, repair lineage and aliases to agree with the status:
 * - Keep first create, drop any later creates
 * - Add rename's fromTitle to aliases if missing
 * - Remove all ending events (merge, split, retire)
 * - Re-add the ONE ending that matches the status, using existing sha where possible
 * Works on raw JSON only and touches no core schema, so later schema changes cannot alter it.
 * Whether the repaired bodies match the current schema is checked by migrate(), after the
 * whole chain (including any later repair migration) has run.
 */
function repairLineageStatus(db: Database.Database): void {
  const rows = db.prepare("SELECT sha, body FROM manifests").all() as {
    sha: string;
    body: string;
  }[];
  const update = db.prepare("UPDATE manifests SET body = ? WHERE sha = ?");
  for (const row of rows) {
    const manifest = JSON.parse(row.body) as StoredManifest;
    let manifestChanged = false;
    for (const feature of manifest.features) {
      const original = JSON.stringify(feature);
      // Keep first create, drop any later creates
      let createIndex = -1;
      const toRemove: number[] = [];
      for (let i = 0; i < feature.lineage.length; i++) {
        const event = feature.lineage[i];
        if (event && event.kind === "create") {
          if (createIndex === -1) {
            createIndex = i;
          } else {
            toRemove.push(i);
          }
        }
      }
      // Remove creates (in reverse order to maintain indices)
      for (let i = toRemove.length - 1; i >= 0; i--) {
        const idx = toRemove[i];
        if (idx !== undefined) {
          feature.lineage.splice(idx, 1);
        }
      }
      // Add rename's fromTitle to aliases if missing
      for (const event of feature.lineage) {
        if (event.kind === "rename" && event.fromTitle !== undefined) {
          if (!feature.aliases.includes(event.fromTitle)) {
            feature.aliases.push(event.fromTitle);
          }
        }
      }
      // Find existing ending events to reuse sha
      const existingEndings = feature.lineage.filter((e) =>
        ["merge", "split", "retire"].includes(e.kind),
      );
      const existingRetire = existingEndings.find((e) => e.kind === "retire");
      const existingMerge = existingEndings.find((e) => e.kind === "merge");
      const existingSplit = existingEndings.find((e) => e.kind === "split");
      // Remove all endings
      feature.lineage = feature.lineage.filter(
        (e) => !["merge", "split", "retire"].includes(e.kind),
      );
      // Add the ending that matches status
      const status = feature.status;
      if (status.kind === "active") {
        // No ending needed
      } else if (status.kind === "retired") {
        const sha = existingRetire?.sha ?? row.sha;
        feature.lineage.push({ kind: "retire", sha });
      } else if (status.kind === "redirect") {
        const targetId = status.to as string;
        const sha = existingMerge?.into === targetId ? (existingMerge.sha as string) : row.sha;
        feature.lineage.push({ kind: "merge", sha, into: targetId });
      } else if (status.kind === "disambiguation") {
        const targets = status.to as string[];
        const sha = existingSplit ? (existingSplit.sha as string) : row.sha;
        feature.lineage.push({ kind: "split", sha, into: targets });
      }
      // Track if anything changed
      if (JSON.stringify(feature) !== original) {
        manifestChanged = true;
      }
    }
    if (manifestChanged) {
      update.run(JSON.stringify(manifest), row.sha);
    }
  }
}

export function migrate(db: Database.Database): void {
  runMigrations(db, MIGRATIONS, verifyStoredManifests);
}

/**
 * Throws if any stored manifest body does not parse with the current core schema, so a store
 * fails loudly at open rather than on read. It runs after the whole migration chain, never
 * inside a migration: a migration that validated against the live schema would block every
 * later migration that rewrites bodies for a schema change.
 */
export function verifyStoredManifests(db: Database.Database): void {
  const rows = db.prepare("SELECT sha, body FROM manifests").all() as {
    sha: string;
    body: string;
  }[];
  for (const row of rows) {
    const result = Manifest.safeParse(JSON.parse(row.body));
    if (!result.success) {
      throw new Error(
        `manifest ${row.sha} does not match the current schema after migrating: ${JSON.stringify(result.error.issues)}`,
      );
    }
  }
}

/**
 * Applies the migrations a database has not seen, all in one transaction. When any ran,
 * `verify` then checks the result inside the same transaction; a throw rolls everything back.
 */
export function runMigrations(
  db: Database.Database,
  migrations: readonly Migration[],
  verify?: (db: Database.Database) => void,
): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > migrations.length) throw new UnsupportedSchemaError(current, migrations.length);
  db.transaction(() => {
    for (const [index, migration] of migrations.entries()) {
      if (index < current) continue;
      if (typeof migration === "string") db.exec(migration);
      else migration(db);
      db.pragma(`user_version = ${index + 1}`);
    }
    if (current < migrations.length) verify?.(db);
  })();
}
