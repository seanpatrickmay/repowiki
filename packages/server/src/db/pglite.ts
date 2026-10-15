import { mkdirSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { type Db, type Queryable, withRetries } from "./db.ts";

function queryable(target: PGlite | Transaction): Queryable {
  return {
    query: async <R extends object>(sql: string, params: readonly unknown[] = []) =>
      (await target.query<R>(sql, [...params])).rows,
    exec: async (sql: string) => {
      await target.exec(sql);
    },
  };
}

/** Postgres in WASM, in memory (`null`) or under `dataDir` (spec 2 S3). */
export async function openPglite(dataDir: string | null): Promise<Db> {
  // PGlite creates only the last directory of the path; a first `hosted:dev` run has none of it.
  if (dataDir !== null) mkdirSync(dataDir, { recursive: true });
  const pg = dataDir === null ? new PGlite() : new PGlite(dataDir);
  await pg.waitReady;
  return {
    ...queryable(pg),
    transaction: (fn) => withRetries(() => pg.transaction((tx) => fn(queryable(tx)))),
    close: () => pg.close(),
  };
}
