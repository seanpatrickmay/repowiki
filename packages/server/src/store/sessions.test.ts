import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import { signIn } from "./accounts.ts";
import { createSession, endSession, readSession } from "./sessions.ts";
import { freshDb } from "./test-db.ts";

const T0 = "2026-10-14T12:00:00.000Z";
const A1 = "00000000-0000-4000-8000-000000000001";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(async () => db.close());

describe("sessions (spec 2 S6)", () => {
  beforeEach(async () => {
    const sean = {
      githubUserId: 101,
      login: "SeanPatrickMay",
      displayName: "Sean May",
      githubCreatedAt: "2019-01-01T00:00:00Z",
    };
    await signIn(db, sean, { newAccountId: A1, allowNew: () => true, now: T0 });
  });

  it("are stored only as a hash and read back with their CSRF token", async () => {
    const { token, csrf, expiresAt } = await createSession(db, A1, T0);
    expect(expiresAt).toBe("2026-11-13T12:00:00.000Z");
    const rows = await db.query<{ id_hash: string }>("SELECT id_hash FROM sessions");
    expect(rows[0]?.id_hash).not.toBe(token);
    expect(await readSession(db, token, T0)).toMatchObject({
      account: { id: A1 },
      csrf,
      renewed: false,
    });
    expect(await readSession(db, "forged", T0)).toBeNull();
  });

  it("refuse and delete an expired session, and slide a live one", async () => {
    const { token } = await createSession(db, A1, T0);
    expect(await readSession(db, token, "2026-10-15T11:00:00.000Z")).toMatchObject({
      renewed: false,
    });
    expect(await readSession(db, token, "2026-11-01T00:00:00.000Z")).toMatchObject({
      renewed: true,
    });
    const rows = await db.query<{ expires_at: Date }>("SELECT expires_at FROM sessions");
    expect(rows[0]?.expires_at.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(await readSession(db, token, "2027-01-01T00:00:00.000Z")).toBeNull();
    expect(await db.query("SELECT * FROM sessions")).toEqual([]);
  });

  it("end on sign-out", async () => {
    const { token } = await createSession(db, A1, T0);
    await endSession(db, token);
    expect(await readSession(db, token, T0)).toBeNull();
  });
});
