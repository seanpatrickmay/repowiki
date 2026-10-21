import { randomBytes } from "node:crypto";
import { SubscriptionStatus } from "@repowiki/hosted";
import { z } from "zod";

/** The API version every request names (billing spec B10): the account's on 2026-10-21. */
export const STRIPE_API_VERSION = "2026-09-30.endive";
export const STRIPE_API = "https://api.stripe.com";

export class StripeError extends Error {}

export interface StripeSubscription {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  /** The first item's price lookup key; null for a price without one. */
  lookupKey: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** The account RepoWiki named at checkout (`metadata.account_id`), when present. */
  accountId: string | null;
}

export interface StripeCheckout {
  id: string;
  complete: boolean;
  accountId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
}

export interface StripeApi {
  priceId(lookupKey: string): Promise<string>;
  createCheckout(input: {
    priceId: string;
    accountId: string;
    customerId: string | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; url: string }>;
  checkoutSession(id: string): Promise<StripeCheckout>;
  subscription(id: string): Promise<StripeSubscription>;
  createPortal(customerId: string, returnUrl: string): Promise<{ url: string }>;
  cancelSubscription(id: string): Promise<void>;
}

const Created = z.object({ id: z.string(), url: z.string().url() });
const Session = z.object({
  id: z.string(),
  status: z.string().nullable(),
  client_reference_id: z.string().nullable(),
  customer: z.string().nullable(),
  subscription: z.string().nullable(),
});
const Subscription = z.object({
  id: z.string(),
  customer: z.string(),
  status: SubscriptionStatus,
  cancel_at_period_end: z.boolean(),
  metadata: z.record(z.string(), z.string()).default({}),
  items: z.object({
    data: z.array(
      z.object({
        current_period_end: z.number().int().nullable().optional(),
        price: z.object({ lookup_key: z.string().nullable() }),
      }),
    ),
  }),
});
const Prices = z.object({ data: z.array(z.object({ id: z.string(), lookup_key: z.string() })) });

/** Stripe's REST API with a secret or restricted key, through `fetchFn` (billing spec B10). */
export function stripeApi(fetchFn: typeof fetch, key: string, base = STRIPE_API): StripeApi {
  const priceIds = new Map<string, string>();

  async function call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    schema: z.ZodType<T>,
    form?: URLSearchParams,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      "stripe-version": STRIPE_API_VERSION,
    };
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers["idempotency-key"] = randomBytes(18).toString("base64url");
    }
    const response = await fetchFn(`${base}${path}`, {
      method,
      headers,
      ...(form === undefined ? {} : { body: form.toString() }),
      signal: AbortSignal.timeout(10_000),
    });
    const what = path.split("?")[0]?.replace(/\/(?:cs|sub|cus)_[A-Za-z0-9_]+/, "/<id>");
    if (!response.ok) throw new StripeError(`Stripe answered ${response.status} for ${what}`);
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new StripeError(`Stripe sent an unexpected answer for ${what}`);
    return parsed.data;
  }

  return {
    async priceId(lookupKey) {
      const known = priceIds.get(lookupKey);
      if (known !== undefined) return known;
      const query = new URLSearchParams({ "lookup_keys[]": lookupKey, active: "true" });
      const { data } = await call("GET", `/v1/prices?${query}`, Prices);
      const id = data.find((p) => p.lookup_key === lookupKey)?.id;
      if (id === undefined) throw new StripeError(`Stripe has no active price ${lookupKey}`);
      priceIds.set(lookupKey, id);
      return id;
    },
    async createCheckout(input) {
      const form = new URLSearchParams({
        mode: "subscription",
        "line_items[0][price]": input.priceId,
        "line_items[0][quantity]": "1",
        client_reference_id: input.accountId,
        "metadata[account_id]": input.accountId,
        "subscription_data[metadata][account_id]": input.accountId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      });
      if (input.customerId !== null) form.set("customer", input.customerId);
      return call("POST", "/v1/checkout/sessions", Created, form);
    },
    async checkoutSession(id) {
      const s = await call("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`, Session);
      return {
        id: s.id,
        complete: s.status === "complete",
        accountId: s.client_reference_id,
        customerId: s.customer,
        subscriptionId: s.subscription,
      };
    },
    async subscription(id) {
      const s = await call("GET", `/v1/subscriptions/${encodeURIComponent(id)}`, Subscription);
      const item = s.items.data[0];
      const end = item?.current_period_end ?? null;
      return {
        id: s.id,
        customerId: s.customer,
        status: s.status,
        lookupKey: item?.price.lookup_key ?? null,
        periodEnd: end === null ? null : new Date(end * 1000).toISOString(),
        cancelAtPeriodEnd: s.cancel_at_period_end,
        accountId: s.metadata.account_id ?? null,
      };
    },
    async createPortal(customerId, returnUrl) {
      const form = new URLSearchParams({ customer: customerId, return_url: returnUrl });
      return call("POST", "/v1/billing_portal/sessions", Created, form);
    },
    async cancelSubscription(id) {
      await call("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`, z.unknown());
    },
  };
}
