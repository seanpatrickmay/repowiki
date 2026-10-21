import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { type FakeStripe, fakeStripe } from "../billing/fake.ts";
import { signStripeEvent } from "../billing/signature.ts";
import { stripeApi } from "../billing/stripe.ts";
import type { App } from "../http/server.ts";
import { accountById } from "../store/accounts.ts";
import { billingWebhookRoutes } from "./billing-webhook.ts";
import { call, signedInCookie, TEST_NOW, testDeps } from "./test-app.ts";

const KEYS = { secretKey: "rk_test_abc", webhookSecret: "whsec_hooksecret", testMode: true };
const NOW_S = Math.floor(Date.parse(TEST_NOW) / 1000);

let deps: Deps;
let stripe: FakeStripe;
let app: App;
let accountId: string;
let logged: object[];

const event = (type: string, object: object, id = "evt_1", created = NOW_S) =>
  JSON.stringify({ id, object: "event", type, created, data: { object } });
const deliver = (
  body: string,
  signature = signStripeEvent(Buffer.from(body), KEYS.webhookSecret, Date.parse(TEST_NOW)),
) =>
  call(app, {
    method: "POST",
    path: "/billing/webhook",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body,
  });
const plan = async () => (await accountById(deps.db, accountId))?.plan;
const fetches = () => stripe.requests.filter((r) => r.path.startsWith("/v1/subscriptions/")).length;

beforeEach(async () => {
  stripe = fakeStripe();
  logged = [];
  const base = await testDeps({ log: (line) => logged.push(line) });
  deps = {
    ...base,
    config: { ...base.config, stripe: KEYS },
    stripe: stripeApi(stripe.fetch, KEYS.secretKey),
  };
  app = createApp(deps, billingWebhookRoutes(deps));
  accountId = (await signedInCookie(deps)).accountId;
});
afterEach(async () => deps.db.close());

describe("POST /billing/webhook (billing spec B8)", () => {
  it("re-reads the subscription a signed event names and applies it", async () => {
    const { subscriptionId } = stripe.subscribe(accountId, "repowiki_pro_monthly");
    const reply = await deliver(event("customer.subscription.created", { id: subscriptionId }));
    expect(reply.status).toBe(200);
    expect(await plan()).toBe("pro");
    stripe.update(subscriptionId, { status: "canceled" });
    const ended = event(
      "customer.subscription.deleted",
      { id: subscriptionId },
      "evt_2",
      NOW_S + 1,
    );
    expect((await deliver(ended)).status).toBe(200);
    expect(await plan()).toBe("free");
  });

  it("finds the subscription on a checkout session and on an invoice, in either place", async () => {
    const { subscriptionId } = stripe.subscribe(accountId, "repowiki_pro_season");
    await deliver(
      event("checkout.session.completed", { id: "cs_1", subscription: subscriptionId }),
    );
    expect(await plan()).toBe("pro");
    stripe.update(subscriptionId, { status: "canceled" });
    const invoice = {
      id: "in_1",
      parent: { subscription_details: { subscription: subscriptionId } },
    };
    await deliver(event("invoice.payment_failed", invoice, "evt_2", NOW_S + 1));
    expect(await plan()).toBe("free");
  });

  it("handles an event id once, and answers other event types without calling Stripe", async () => {
    const { subscriptionId } = stripe.subscribe(accountId, "repowiki_pro_monthly");
    const body = event("customer.subscription.updated", { id: subscriptionId });
    await deliver(body);
    await deliver(body);
    expect(fetches()).toBe(1);
    expect((await deliver(event("customer.created", { id: "cus_x" }, "evt_9"))).status).toBe(200);
    expect(fetches()).toBe(1);
  });

  it("refuses a bad or missing signature with 400, logging the reason and never the body", async () => {
    const body = event("customer.subscription.created", { id: "sub_x", email: "a@b.c" });
    expect((await deliver(body, `t=1,v1=${"0".repeat(64)}`)).status).toBe(400);
    expect((await deliver(body, "")).status).toBe(400);
    expect(fetches()).toBe(0);
    expect(JSON.stringify(logged)).not.toContain("a@b.c");
    expect(logged).toContainEqual({ billing: "webhook-refused", reason: "malformed" });
  });

  it("answers 500 when Stripe can't be reached, so Stripe retries, and doesn't count the event as handled", async () => {
    const { subscriptionId } = stripe.subscribe(accountId, "repowiki_pro_monthly");
    const body = event("customer.subscription.created", { id: subscriptionId });
    const working = deps.stripe;
    deps.stripe = stripeApi(async () => new Response("", { status: 503 }), KEYS.secretKey);
    app = createApp(deps, billingWebhookRoutes(deps));
    expect((await deliver(body)).status).toBe(500);
    deps.stripe = working;
    app = createApp(deps, billingWebhookRoutes(deps));
    expect((await deliver(body)).status).toBe(200);
    expect(await plan()).toBe("pro");
  });

  it("is not there with billing off", async () => {
    deps.stripe = null;
    app = createApp(deps, billingWebhookRoutes(deps));
    expect((await deliver(event("customer.subscription.created", { id: "sub_x" }))).status).toBe(
      404,
    );
  });
});
