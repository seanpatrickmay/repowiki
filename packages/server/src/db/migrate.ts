import { readdirSync, readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { Db } from "./db.ts";
import { openPg } from "./pg.ts";
import { openPglite } from "./pglite.ts";

const DIR = new URL("./migrations/", import.meta.url);
const FILE = /^(\d{4})-[a-z0-9-]+\.sql$/;
/** Held for the length of a migration run, so two servers starting at once take turns. */
const LOCK = 727_001;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Every migration file in order; versions must run 1, 2, 3, … with no gap. */
export function migrationFiles(): Migration[] {
  const files = readdirSync(DIR)
    .filter((name) => FILE.test(name))
    .sort()
    .map((name) => ({
      version: Number(FILE.exec(name)?.[1]),
      name,
      sql: readFileSync(new URL(name, DIR), "utf8"),
    }));
  files.forEach((file, i) => {
    if (file.version !== i + 1) throw new Error(`migration ${file.name} is out of sequence`);
  });
  return files;
}

/** Apply every migration not yet applied, in one transaction; returns the versions applied. */
export async function migrate(db: Db): Promise<number[]> {
  return db.transaction(async (tx) => {
    // Lock first: two servers racing CREATE TABLE IF NOT EXISTS can still collide in Postgres.
    await tx.query(`SELECT pg_advisory_xact_lock(${LOCK})`);
    await tx.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const rows = await tx.query<{ version: number }>("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((r) => r.version));
    const applied: number[] = [];
    for (const migration of migrationFiles()) {
      if (done.has(migration.version)) continue;
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
      applied.push(migration.version);
    }
    return applied;
  });
}

/** The configured database, migrated. */
export async function openDatabase(database: Config["database"]): Promise<Db> {
  const db =
    database.kind === "postgres" ? openPg(database.url) : await openPglite(database.dataDir);
  await migrate(db);
  return db;
}
