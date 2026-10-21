import { IsoDateTime } from "@repowiki/core";
import { z } from "zod";
import type { Plan } from "./limits.ts";

/** Every status a Stripe subscription can have (API version 2026-09-30.endive). */
export const SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "canceled",
  "paused",
] as const;
export const SubscriptionStatus = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/**
 * The plan a subscription status gives (billing spec B3): Pro while it is active, trialing or
 * past due (Stripe is still retrying the card), Free otherwise.
 */
export function planForStatus(status: SubscriptionStatus | null): Plan {
  return status === "active" || status === "trialing" || status === "past_due" ? "pro" : "free";
}

/** The owner's two Pro prices, found in Stripe by lookup key (billing spec B1). */
export const PRO_PRICES = {
  monthly: { lookupKey: "repowiki_pro_monthly", label: "$5 a month", months: 1 },
  season: { lookupKey: "repowiki_pro_season", label: "$15 every 4 months", months: 4 },
} as const;
export const ProPrice = z.enum(["monthly", "season"]);
export type ProPrice = z.infer<typeof ProPrice>;

/** Which Pro price a Stripe lookup key names, or null for any other price. */
export function priceForLookupKey(lookupKey: string | null): ProPrice | null {
  for (const price of ProPrice.options) {
    if (PRO_PRICES[price].lookupKey === lookupKey) return price;
  }
  return null;
}

const StripeId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]{1,250}$`));

/**
 * What RepoWiki keeps about an account's Stripe billing (billing spec §5): ids, status and dates,
 * never an email, a name, an address or an amount.
 */
export const BillingState = z
  .strictObject({
    customerId: StripeId("cus"),
    subscriptionId: StripeId("sub").nullable(),
    status: SubscriptionStatus.nullable(),
    price: ProPrice.nullable(),
    periodEnd: IsoDateTime.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    /** When the newest Stripe event applied was created; older ones change nothing (B8). */
    lastEventAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .refine((b) => b.status === null || b.subscriptionId !== null, "a status needs a subscription");
export type BillingState = z.infer<typeof BillingState>;
