import { describe, expect, it } from "vitest";
import { type PoolLike, poolDb } from "./pg.ts";

/** A pool that records each statement and fails the one named `failOn`. */
function fakePool(failOn?: string) {
  const log: string[] = [];
  const client = {
    query: async (sql: string) => {
      log.push(sql);
      if (sql === failOn) throw Object.assign(new Error(`failed ${sql}`), { code: "XX000" });
      return { rows: [{ sql }] };
    },
    release: () => log.push("release"),
  };
  const pool: PoolLike = {
    query: client.query,
    connect: async () => client,
    end: async () => {
      log.push("end");
    },
  };
  return { pool, log };
}

describe("poolDb (spec 2 S3)", () => {
  it("wraps a transaction in BEGIN and COMMIT on one client, then releases it", async () => {
    const { pool, log } = fakePool();
    const db = poolDb(pool);
    expect(await db.transaction(async (tx) => tx.query("SELECT 1"))).toEqual([{ sql: "SELECT 1" }]);
    expect(log).toEqual(["BEGIN", "SELECT 1", "COMMIT", "release"]);
  });

  it("rolls back and releases when the work throws", async () => {
    const { pool, log } = fakePool("SELECT 2");
    const db = poolDb(pool);
    await expect(db.transaction(async (tx) => tx.query("SELECT 2"))).rejects.toThrow("failed");
    expect(log).toEqual(["BEGIN", "SELECT 2", "ROLLBACK", "release"]);
  });

  it("queries the pool outside a transaction and ends it on close", async () => {
    const { pool, log } = fakePool();
    const db = poolDb(pool);
    await db.exec("CREATE TABLE t (id int)");
    await db.close();
    expect(log).toEqual(["CREATE TABLE t (id int)", "end"]);
  });
});
