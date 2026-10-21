import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StripeSubscription } from "../billing/stripe.ts";
import type { Db } from "../db/db.ts";
import { accountById, signIn } from "./accounts.ts";
import { applySubscription, billingOf, pruneEvents, recordEvent } from "./billing.ts";
import { freshDb } from "./test-db.ts";

const T0 = "2026-10-21T12:00:00.000Z";
const T1 = "2026-10-21T12:05:00.000Z";
const A1 = "00000000-0000-4000-8000-000000000001";
const A2 = "00000000-0000-4000-8000-000000000002";

const sub = (patch: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id: "sub_1",
  customerId: "cus_1",
  status: "active",
  lookupKey: "repowiki_pro_monthly",
  periodEnd: "2026-11-21T12:00:00.000Z",
  cancelAtPeriodEnd: false,
  accountId: A1,
  ...patch,
});

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  for (const [id, githubUserId, login] of [
    [A1, 101, "ada"],
    [A2, 102, "grace"],
  ] as const) {
    await signIn(
      db,
      { githubUserId, login, displayName: login, githubCreatedAt: "2019-01-01T00:00:00Z" },
      { newAccountId: id, allowNew: () => true, now: T0 },
    );
  }
});
afterEach(async () => db.close());

const audits = async () =>
  (
    await db.query<{ body: { action: string; actor: string; target: { id: string } } }>(
      "SELECT body FROM audit_events ORDER BY created_at, id",
    )
  )
    .map((r) => r.body)
    .filter((b) => b.action.startsWith("billing."));

describe("applySubscription (billing spec B2, B3, B9)", () => {
  it("finds the account by checkout metadata the first time, stores the state and makes it Pro", async () => {
    const result = await applySubscription(db, { subscription: sub(), eventAt: T0, now: T0 });
    expect(result).toEqual({ accountId: A1, plan: "pro", changed: true });
    expect((await accountById(db, A1))?.plan).toBe("pro");
    expect(await billingOf(db, A1)).toEqual({
      customerId: "cus_1",
      subscriptionId: "sub_1",
      status: "active",
      price: "monthly",
      periodEnd: "2026-11-21T12:00:00.000Z",
      cancelAtPeriodEnd: false,
      lastEventAt: T0,
      updatedAt: T0,
    });
    expect(await audits()).toEqual([
      expect.objectContaining({
        action: "billing.plan-change",
        actor: "system",
        target: { entity: "account", id: A1 },
      }),
    ]);
  });

  it("finds the account by its customer afterwards, and turns it Free when the subscription ends", async () => {
    await applySubscription(db, { subscription: sub(), eventAt: T0, now: T0 });
    const ended = sub({ status: "canceled", accountId: null });
    expect(await applySubscription(db, { subscription: ended, eventAt: T1, now: T1 })).toEqual({
      accountId: A1,
      plan: "free",
      changed: true,
    });
    expect((await accountById(db, A1))?.plan).toBe("free");
    expect((await billingOf(db, A1))?.status).toBe("canceled");
    expect(await audits()).toHaveLength(2);
  });

  it("keeps Pro while a payment is past due, recording no plan change", async () => {
    await applySubscription(db, { subscription: sub(), eventAt: T0, now: T0 });
    const late = sub({ status: "past_due" });
    expect(await applySubscription(db, { subscription: late, eventAt: T1, now: T1 })).toEqual({
      accountId: A1,
      plan: "pro",
      changed: false,
    });
    expect(await audits()).toHaveLength(1);
  });

  it("changes nothing for an event older than the newest applied", async () => {
    await applySubscription(db, {
      subscription: sub({ status: "canceled" }),
      eventAt: T1,
      now: T1,
    });
    const stale = await applySubscription(db, { subscription: sub(), eventAt: T0, now: T1 });
    expect(stale).toEqual({ accountId: A1, plan: "free", changed: false });
    expect((await billingOf(db, A1))?.status).toBe("canceled");
  });

  it("ignores a customer it doesn't know with no account named, and an account that isn't there", async () => {
    expect(
      await applySubscription(db, { subscription: sub({ accountId: null }), eventAt: T0, now: T0 }),
    ).toBeNull();
    const ghost = sub({ accountId: "00000000-0000-4000-8000-000000000009" });
    expect(await applySubscription(db, { subscription: ghost, eventAt: T0, now: T0 })).toBeNull();
    expect(await billingOf(db, A1)).toBeNull();
  });

  it("never moves a customer to another account, whatever the metadata says", async () => {
    await applySubscription(db, { subscription: sub(), eventAt: T0, now: T0 });
    const moved = await applySubscription(db, {
      subscription: sub({ accountId: A2 }),
      eventAt: T1,
      now: T1,
    });
    expect(moved?.accountId).toBe(A1);
    expect(await billingOf(db, A2)).toBeNull();
  });
});

describe("a second subscription (billing spec B9)", () => {
  it("lets a late cancellation of the old subscription leave the new one's Pro alone", async () => {
    await applySubscription(db, { subscription: sub(), eventAt: T0, now: T0 });
    const renewed = sub({ id: "sub_2" });
    await applySubscription(db, { subscription: renewed, eventAt: T1, now: T1 });
    const later = "2026-10-21T12:10:00.000Z";
    const old = sub({ status: "canceled" });
    expect(await applySubscription(db, { subscription: old, eventAt: later, now: later })).toEqual({
      accountId: A1,
      plan: "pro",
      changed: false,
    });
    expect((await billingOf(db, A1))?.subscriptionId).toBe("sub_2");
  });
});

describe("recordEvent (billing spec B8)", () => {
  it("is true the first time an event id arrives and false after", async () => {
    expect(await recordEvent(db, "evt_1", T0)).toBe(true);
    expect(await recordEvent(db, "evt_1", T1)).toBe(false);
    expect(await recordEvent(db, "evt_2", T1)).toBe(true);
  });

  it("forgets events after 30 days", async () => {
    await recordEvent(db, "evt_old", "2026-09-01T00:00:00Z");
    await recordEvent(db, "evt_new", T0);
    expect(await pruneEvents(db, T0)).toBe(1);
    expect(await recordEvent(db, "evt_new", T1)).toBe(false);
  });
});
