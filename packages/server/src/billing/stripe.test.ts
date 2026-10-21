import { describe, expect, it } from "vitest";
import { fakeStripe } from "./fake.ts";
import { STRIPE_API_VERSION, StripeError, stripeApi } from "./stripe.ts";

const KEY = "rk_test_abc";
const ACCOUNT = "4f1c2b8e-0000-4000-8000-000000000001";

describe("stripeApi (billing spec B10)", () => {
  it("finds a price by lookup key once, sending the pinned API version and the key", async () => {
    const stripe = fakeStripe();
    const api = stripeApi(stripe.fetch, KEY);
    const id = await api.priceId("repowiki_pro_monthly");
    expect(await api.priceId("repowiki_pro_monthly")).toBe(id);
    expect(stripe.requests).toHaveLength(1);
    expect(stripe.requests[0]?.headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
      "stripe-version": STRIPE_API_VERSION,
    });
    await expect(api.priceId("repowiki_pro_yearly")).rejects.toThrow(StripeError);
  });

  it("creates a subscription Checkout naming the account three ways, with an idempotency key", async () => {
    const stripe = fakeStripe();
    const api = stripeApi(stripe.fetch, KEY);
    const priceId = await api.priceId("repowiki_pro_season");
    const session = await api.createCheckout({
      priceId,
      accountId: ACCOUNT,
      customerId: null,
      successUrl: "https://app.repowiki.app/billing/return?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://app.repowiki.app/billing",
    });
    expect(session.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const sent = stripe.requests.at(-1);
    expect(sent?.headers["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(Object.fromEntries(sent?.form ?? [])).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      client_reference_id: ACCOUNT,
      "metadata[account_id]": ACCOUNT,
      "subscription_data[metadata][account_id]": ACCOUNT,
      success_url: "https://app.repowiki.app/billing/return?session_id={CHECKOUT_SESSION_ID}",
    });
    expect(sent?.form.has("customer")).toBe(false);
  });

  it("reads back a completed checkout and its subscription, period end from the first item", async () => {
    const stripe = fakeStripe();
    const api = stripeApi(stripe.fetch, KEY);
    const priceId = await api.priceId("repowiki_pro_season");
    const created = await api.createCheckout({
      priceId,
      accountId: ACCOUNT,
      customerId: null,
      successUrl: "https://app.repowiki.app/billing/return",
      cancelUrl: "https://app.repowiki.app/billing",
    });
    const paid = stripe.complete(created.id, { periodEnd: "2027-02-21T00:00:00Z" });
    const session = await api.checkoutSession(created.id);
    expect(session).toEqual({
      id: created.id,
      complete: true,
      accountId: ACCOUNT,
      customerId: paid.customerId,
      subscriptionId: paid.subscriptionId,
    });
    expect(await api.subscription(paid.subscriptionId)).toEqual({
      id: paid.subscriptionId,
      customerId: paid.customerId,
      status: "active",
      lookupKey: "repowiki_pro_season",
      periodEnd: "2027-02-21T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      accountId: ACCOUNT,
    });
  });

  it("opens the portal for a customer and cancels a subscription at once", async () => {
    const stripe = fakeStripe();
    const api = stripeApi(stripe.fetch, KEY);
    const { customerId, subscriptionId } = stripe.subscribe(ACCOUNT, "repowiki_pro_monthly");
    const portal = await api.createPortal(customerId, "https://app.repowiki.app/billing");
    expect(portal.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    await api.cancelSubscription(subscriptionId);
    expect((await api.subscription(subscriptionId)).status).toBe("canceled");
  });

  it("names the failure without the key or the body, and treats an unknown id as an error", async () => {
    const stripe = fakeStripe();
    const api = stripeApi(stripe.fetch, KEY);
    const error = await api.subscription("sub_missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeError);
    expect(String(error)).toMatch(/404/);
    expect(String(error)).not.toContain(KEY);
    const down = stripeApi(async () => new Response("", { status: 503 }), KEY);
    await expect(down.createPortal("cus_1", "https://app.repowiki.app/billing")).rejects.toThrow(
      /503/,
    );
  });
});
