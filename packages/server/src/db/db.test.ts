import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./db.ts";
import { isUniqueViolation, withRetries } from "./db.ts";
import { openPglite } from "./pglite.ts";

let db: Db;
beforeAll(async () => {
  db = await openPglite(null);
  await db.exec("CREATE TABLE things (id int PRIMARY KEY, body jsonb NOT NULL)");
});
afterAll(async () => db.close());

describe("openPglite (spec 2 S3)", () => {
  it("runs parameterised SQL and returns jsonb parsed", async () => {
    await db.query("INSERT INTO things (id, body) VALUES ($1, $2::jsonb)", [1, '{"a":[1]}']);
    expect(await db.query("SELECT id, body FROM things WHERE id = $1", [1])).toEqual([
      { id: 1, body: { a: [1] } },
    ]);
  });

  it("reports a duplicate key as a unique violation", async () => {
    const error = await db
      .query("INSERT INTO things (id, body) VALUES (1, '{}'::jsonb)")
      .catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(new Error("other"))).toBe(false);
  });

  it("commits a transaction that returns and rolls back one that throws", async () => {
    expect(
      await db.transaction(async (tx) => {
        await tx.query("INSERT INTO things (id, body) VALUES (2, '{}'::jsonb)");
        return "kept";
      }),
    ).toBe("kept");
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO things (id, body) VALUES (3, '{}'::jsonb)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const ids = await db.query<{ id: number }>("SELECT id FROM things ORDER BY id");
    expect(ids.map((row) => row.id)).toEqual([1, 2]);
  });
});

describe("withRetries (spec 2 S5)", () => {
  it("retries a serialization failure or deadlock, and nothing else", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("conflict"), { code: "40001" });
      return "done";
    };
    expect(await withRetries(flaky)).toBe("done");
    expect(calls).toBe(3);
    calls = 0;
    const broken = async () => {
      calls++;
      throw Object.assign(new Error("bad"), { code: "23505" });
    };
    await expect(withRetries(broken)).rejects.toThrow("bad");
    expect(calls).toBe(1);
  });

  it("gives up after its attempts", async () => {
    let calls = 0;
    const deadlocked = async () => {
      calls++;
      throw Object.assign(new Error("deadlock"), { code: "40P01" });
    };
    await expect(withRetries(deadlocked, 2)).rejects.toThrow("deadlock");
    expect(calls).toBe(2);
  });
});
