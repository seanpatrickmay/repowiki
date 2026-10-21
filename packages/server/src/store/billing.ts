import { randomUUID } from "node:crypto";
import {
  Account,
  BillingState,
  type Plan,
  planForStatus,
  priceForLookupKey,
} from "@repowiki/hosted";
import type { StripeSubscription } from "../billing/stripe.ts";
import type { Db, Queryable } from "../db/db.ts";
import { appendAudit } from "./audit.ts";
import { asJson, parsedBody } from "./rows.ts";

/** How long a handled Stripe event id is remembered: past Stripe's three days of retries. */
export const EVENT_MEMORY_DAYS = 30;

export interface Applied {
  accountId: string;
  plan: Plan;
  /** Whether the account's plan changed. */
  changed: boolean;
}

/** The account's billing state, or null when it never opened Checkout. */
export async function billingOf(q: Queryable, accountId: string): Promise<BillingState | null> {
  const rows = await q.query<{ body: unknown }>("SELECT body FROM billing WHERE account_id = $1", [
    accountId,
  ]);
  return rows[0] === undefined ? null : parsedBody(BillingState, rows[0].body, "billing");
}

/**
 * Mirrors a subscription Stripe just returned onto its account (billing spec B2, B3, B9), in one
 * transaction: the account is found by its customer, or the first time by the account id
 * Checkout put in the metadata; an event older than the newest applied changes nothing; the plan
 * becomes `planForStatus`, audited when it changes. Null when no account matches.
 */
export async function applySubscription(
  db: Db,
  input: { subscription: StripeSubscription; eventAt: string; now: string },
): Promise<Applied | null> {
  const { subscription: s, eventAt, now } = input;
  return db.transaction(async (tx) => {
    const known = await tx.query<{ account_id: string }>(
      "SELECT account_id FROM billing WHERE stripe_customer_id = $1",
      [s.customerId],
    );
    // A customer stays with the account it was first seen with, whatever later metadata says.
    const accountId = known[0]?.account_id ?? s.accountId;
    if (accountId === null) return null;
    const accounts = await tx.query<{ body: unknown }>(
      "SELECT body FROM accounts WHERE id = $1 FOR UPDATE",
      [accountId],
    );
    if (accounts[0] === undefined) return null;
    const account = parsedBody(Account, accounts[0].body, "account");
    const stored = await tx.query<{ body: unknown }>(
      "SELECT body FROM billing WHERE account_id = $1 FOR UPDATE",
      [accountId],
    );
    const before =
      stored[0] === undefined ? null : parsedBody(BillingState, stored[0].body, "billing");
    const unchanged = { accountId, plan: account.plan, changed: false };
    if (before !== null && Date.parse(before.lastEventAt) > Date.parse(eventAt)) return unchanged;
    // An old subscription ending never takes away the Pro a newer one gives (a resubscription).
    const other = before?.subscriptionId != null && before.subscriptionId !== s.id;
    if (other && planForStatus(before.status) === "pro" && planForStatus(s.status) === "free") {
      return unchanged;
    }
    const state = parsedBody(
      BillingState,
      {
        customerId: s.customerId,
        subscriptionId: s.id,
        status: s.status,
        price: priceForLookupKey(s.lookupKey),
        periodEnd: s.periodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        lastEventAt: eventAt,
        updatedAt: now,
      },
      "billing",
    );
    await tx.query(
      `INSERT INTO billing (account_id, stripe_customer_id, body) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (account_id) DO UPDATE SET stripe_customer_id = $2, body = $3::jsonb`,
      [accountId, s.customerId, asJson(state)],
    );
    const plan = planForStatus(s.status);
    if (plan === account.plan) return unchanged;
    const updated = parsedBody(Account, { ...account, plan }, "account");
    await tx.query("UPDATE accounts SET body = $2::jsonb WHERE id = $1", [
      accountId,
      asJson(updated),
    ]);
    await appendAudit(tx, {
      id: randomUUID(),
      actor: "system",
      action: "billing.plan-change",
      target: { entity: "account", id: accountId },
      outcome: "allowed",
      createdAt: now,
    });
    return { accountId, plan, changed: true };
  });
}

/** Records a Stripe event id; false when it was already handled (billing spec B8). */
export async function recordEvent(q: Queryable, id: string, now: string): Promise<boolean> {
  const rows = await q.query<{ id: string }>(
    "INSERT INTO stripe_events (id, received_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id",
    [id, now],
  );
  return rows.length === 1;
}

/** Forgets event ids older than EVENT_MEMORY_DAYS; returns how many. */
export async function pruneEvents(q: Queryable, now: string): Promise<number> {
  const before = new Date(Date.parse(now) - EVENT_MEMORY_DAYS * 86_400_000).toISOString();
  const rows = await q.query<{ id: string }>(
    "DELETE FROM stripe_events WHERE received_at < $1 RETURNING id",
    [before],
  );
  return rows.length;
}
