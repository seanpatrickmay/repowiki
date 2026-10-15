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
  const pg = dataDir === null ? new PGlite() : new PGlite(dataDir);
  await pg.waitReady;
  return {
    ...queryable(pg),
    transaction: (fn) => withRetries(() => pg.transaction((tx) => fn(queryable(tx)))),
    close: () => pg.close(),
  };
}
