import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import {
  accountById,
  activeHandle,
  type GitHubProfile,
  resolveHandle,
  signIn,
} from "./accounts.ts";
import { freshDb } from "./test-db.ts";

const T0 = "2026-10-14T12:00:00.000Z";
const A1 = "00000000-0000-4000-8000-000000000001";
const A2 = "00000000-0000-4000-8000-000000000002";
const sean: GitHubProfile = {
  githubUserId: 101,
  login: "SeanPatrickMay",
  displayName: "Sean May",
  githubCreatedAt: "2019-01-01T00:00:00Z",
};
const yes = () => true;

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(async () => db.close());

describe("signIn (spec 2 S7)", () => {
  it("creates a Free account and its handle on first sign-in", async () => {
    const result = await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    expect(result).toMatchObject({
      created: true,
      handle: "seanpatrickmay",
      account: {
        id: A1,
        githubUserId: 101,
        login: "SeanPatrickMay",
        plan: "free",
        status: "active",
      },
    });
  });

  it("returns the same account and refreshes its cached login later", async () => {
    await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    const again = await signIn(
      db,
      { ...sean, login: "SeanMay", displayName: "S. May" },
      { newAccountId: A2, allowNew: () => false, now: T0 },
    );
    expect(again).toMatchObject({
      created: false,
      handle: "seanpatrickmay",
      account: { id: A1, login: "SeanMay", displayName: "S. May" },
    });
  });

  it("refuses a new account the allowlist does not name", async () => {
    expect(await signIn(db, sean, { newAccountId: A1, allowNew: () => false, now: T0 })).toBeNull();
    expect(await db.query("SELECT * FROM accounts")).toEqual([]);
  });

  it("suffixes a handle another account holds, even a tombstoned one", async () => {
    await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    await db.query("UPDATE handles SET body = jsonb_set(body, '{state}', '\"tombstoned\"')");
    const twin = { ...sean, githubUserId: 202, login: "seanpatrickmay" };
    const result = await signIn(db, twin, { newAccountId: A2, allowNew: yes, now: T0 });
    expect(result?.handle).toBe("seanpatrickmay-2");
  });

  it("makes one account when the same new user signs in twice at once", async () => {
    const [a, b] = await Promise.all([
      signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 }),
      signIn(db, sean, { newAccountId: A2, allowNew: yes, now: T0 }),
    ]);
    expect(a?.account.id).toBe(b?.account.id);
    expect(await db.query("SELECT * FROM accounts")).toHaveLength(1);
    expect(await db.query("SELECT * FROM handles")).toHaveLength(1);
  });

  it("returns the winner's account when a racing first sign-in commits first", async () => {
    // On Postgres the loser's INSERT meets the winner's row as a unique violation (PGlite
    // serialises transactions, so the race is staged): signIn must retry and find the winner.
    let raced = false;
    const racing: Db = {
      ...db,
      transaction: async (fn) => {
        if (!raced) {
          raced = true;
          await signIn(db, sean, { newAccountId: A2, allowNew: yes, now: T0 });
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        }
        return db.transaction(fn);
      },
    };
    const result = await signIn(racing, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    expect(result).toMatchObject({ created: false, account: { id: A2 } });
  });

  it("resolves a handle and finds an account's active one", async () => {
    await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    expect(await resolveHandle(db, "seanpatrickmay")).toEqual({
      kind: "active",
      accountId: A1,
      handle: "seanpatrickmay",
    });
    expect(await resolveHandle(db, "nobody")).toEqual({ kind: "missing" });
    expect(await activeHandle(db, A1)).toBe("seanpatrickmay");
    expect(await accountById(db, A1)).toMatchObject({ id: A1, login: "SeanPatrickMay" });
    expect(await accountById(db, A2)).toBeNull();
  });

  it("follows a redirected handle and stops on a redirect loop", async () => {
    await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    const redirect = (from: string, to: string) =>
      db.query("INSERT INTO handles (handle, account_id, body) VALUES ($1, $2, $3::jsonb)", [
        from,
        A1,
        JSON.stringify({
          handle: from,
          accountId: A1,
          state: "redirect",
          redirectTo: to,
          createdAt: T0,
        }),
      ]);
    await redirect("oldname", "seanpatrickmay");
    expect(await resolveHandle(db, "oldname")).toEqual({ kind: "redirect", to: "seanpatrickmay" });
    await redirect("loop-a", "loop-b");
    await redirect("loop-b", "loop-a");
    expect(await resolveHandle(db, "loop-a")).toEqual({ kind: "missing" });
  });

  it("keeps at most one active handle per account (spec 2 S4)", async () => {
    await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    const second = db.query(
      "INSERT INTO handles (handle, account_id, body) VALUES ($1, $2, $3::jsonb)",
      [
        "another",
        A1,
        JSON.stringify({
          handle: "another",
          accountId: A1,
          state: "active",
          redirectTo: null,
          createdAt: T0,
        }),
      ],
    );
    await expect(second).rejects.toMatchObject({ code: "23505" });
  });

  it("audits an account's creation in the same transaction, and only its creation", async () => {
    await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    await signIn(db, sean, { newAccountId: A2, allowNew: yes, now: T0 });
    const events = await db.query<{ body: Record<string, unknown> }>(
      "SELECT body FROM audit_events",
    );
    expect(events.map((e) => e.body)).toEqual([
      expect.objectContaining({
        actor: "author",
        action: "account.create",
        target: { entity: "account", id: A1 },
        outcome: "allowed",
        createdAt: T0,
      }),
    ]);
  });
});
