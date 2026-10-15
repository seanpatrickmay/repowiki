import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { openPglite } from "../db/pglite.ts";

/** Test-only: a migrated in-memory database. */
export async function freshDb(): Promise<Db> {
  const db = await openPglite(null);
  await migrate(db);
  return db;
}
