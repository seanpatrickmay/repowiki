import pg from "pg";
import { type Db, type Queryable, withRetries } from "./db.ts";

interface ClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The part of `pg.Pool` the seam uses, so its transaction handling is testable without a server. */
export interface PoolLike extends ClientLike {
  connect(): Promise<ClientLike & { release(): void }>;
  end(): Promise<void>;
}

function queryable(client: ClientLike): Queryable {
  return {
    query: async <R extends object>(sql: string, params: readonly unknown[] = []) =>
      (await client.query(sql, [...params])).rows as R[],
    exec: async (sql: string) => {
      await client.query(sql);
    },
  };
}

/** A `Db` over a pool: each transaction holds one client from BEGIN to COMMIT or ROLLBACK. */
export function poolDb(pool: PoolLike): Db {
  return {
    ...queryable(pool),
    transaction: (fn) =>
      withRetries(async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const value = await fn(queryable(client));
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }),
    close: () => pool.end(),
  };
}

/** Postgres over the network (Neon in production, spec 2 S3). */
export function openPg(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client the server drops emits "error" on the pool; unheard, it would end the process.
  // The next query reconnects, so the event is noted by name only (S17: no secrets in logs).
  pool.on("error", (error) =>
    console.error(JSON.stringify({ db: "idle-client", error: error.name })),
  );
  return poolDb(pool);
}
