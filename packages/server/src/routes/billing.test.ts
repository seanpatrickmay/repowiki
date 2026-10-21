import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { type FakeStripe, fakeStripe } from "../billing/fake.ts";
import { stripeApi } from "../billing/stripe.ts";
import type { App } from "../http/server.ts";
import { accountById } from "../store/accounts.ts";
import { applySubscription, billingOf } from "../store/billing.ts";
import { billingRoutes } from "./billing.ts";
import { auditOutcomes, call, form, signedInCookie, testDeps } from "./test-app.ts";

const KEYS = { secretKey: "rk_test_abc", webhookSecret: "whsec_abc", testMode: true };

let deps: Deps;
let stripe: FakeStripe;
let app: App;
let me: { cookie: string; csrf: string; accountId: string };

const withBilling = async () => {
  stripe = fakeStripe();
  const base = await testDeps();
  deps = {
    ...base,
    config: { ...base.config, stripe: KEYS },
    stripe: stripeApi(stripe.fetch, KEYS.secretKey),
  };
  app = createApp(deps, billingRoutes(deps));
  me = await signedInCookie(deps);
};
const post = (path: string, body = "") =>
  call(app, {
    method: "POST",
    path,
    headers: form(me.cookie, deps.config.appOrigin),
    body: `csrf=${me.csrf}${body}`,
  });
const get = (path: string) => call(app, { path, headers: { cookie: me.cookie } });

afterEach(async () => deps.db.close());

describe("the billing page (billing spec B12)", () => {
  beforeEach(withBilling);

  it("offers Free both prices, says it's test mode, and sends a signed-out visitor to sign in", async () => {
    const page = String((await get("/billing")).body);
    expect(page).toContain("Free");
    expect(page).toContain("$5 a month");
    expect(page).toContain("$15 every 4 months");
    expect(page).toContain('action="/billing/checkout"');
    expect(page).toContain("Test mode");
    expect((await call(app, { path: "/billing" })).headers?.location).toBe("/auth/github");
  });

  it("shows Pro its price, its renewal and the portal, and warns when a payment failed", async () => {
    const { subscriptionId } = stripe.subscribe(me.accountId, "repowiki_pro_season");
    const subscription = await deps.stripe?.subscription(subscriptionId);
    if (subscription === undefined) throw new Error("setup");
    await applySubscription(deps.db, { subscription, eventAt: deps.now(), now: deps.now() });
    let page = String((await get("/billing")).body);
    expect(page).toContain("$15 every 4 months");
    expect(page).toContain("Renews on");
    expect(page).toContain('action="/billing/portal"');
    expect(page).not.toContain('action="/billing/checkout"');
    const late = { ...subscription, status: "past_due" as const, cancelAtPeriodEnd: true };
    await applySubscription(deps.db, {
      subscription: late,
      eventAt: "2026-10-14T12:01:00.000Z",
      now: deps.now(),
    });
    page = String((await get("/billing")).body);
    expect(page).toContain("last payment didn't go through");
    expect(page).toContain("Ends on");
  });
});

describe("checkout, return and portal (billing spec B5, B6, B7)", () => {
  beforeEach(withBilling);

  it("sends Free to Stripe Checkout for the price chosen, audited", async () => {
    const reply = await post("/billing/checkout", "&price=season");
    expect(reply.status).toBe(303);
    expect(reply.headers?.location).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const sent = stripe.requests.find((r) => r.path === "/v1/checkout/sessions");
    expect(sent?.form.get("client_reference_id")).toBe(me.accountId);
    expect(sent?.form.get("success_url")).toBe(
      `${deps.config.appOrigin}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    );
    expect(await auditOutcomes(deps.db, "billing.checkout", me.accountId)).toEqual(["allowed"]);
    expect((await post("/billing/checkout", "&price=yearly")).status).toBe(400);
  });

  it("makes the account Pro on return, and ignores another account's session", async () => {
    const reply = await post("/billing/checkout", "&price=monthly");
    const sessionId = String(reply.headers?.location).split("/").at(-1) ?? "";
    stripe.complete(sessionId);
    const back = await get(`/billing/return?session_id=${sessionId}`);
    expect(back.headers?.location).toBe("/billing");
    expect((await accountById(deps.db, me.accountId))?.plan).toBe("pro");
    expect((await billingOf(deps.db, me.accountId))?.price).toBe("monthly");
    expect((await post("/billing/checkout", "&price=season")).headers?.location).toBe("/billing");
  });

  it("refuses to apply a session made for another account", async () => {
    const theirs = await deps.stripe?.createCheckout({
      priceId: await (deps.stripe?.priceId("repowiki_pro_monthly") ?? Promise.resolve("")),
      accountId: "00000000-0000-4000-8000-0000000000ee",
      customerId: null,
      successUrl: `${deps.config.appOrigin}/billing/return`,
      cancelUrl: `${deps.config.appOrigin}/billing`,
    });
    if (theirs === undefined) throw new Error("setup");
    stripe.complete(theirs.id);
    const back = await get(`/billing/return?session_id=${theirs.id}`);
    expect(back.headers?.location).toBe("/billing");
    expect((await accountById(deps.db, me.accountId))?.plan).toBe("free");
    expect(await billingOf(deps.db, me.accountId)).toBeNull();
  });

  it("opens the portal for an account with a customer, and sends one without to /billing", async () => {
    expect((await post("/billing/portal")).headers?.location).toBe("/billing");
    const { subscriptionId } = stripe.subscribe(me.accountId, "repowiki_pro_monthly");
    const subscription = await deps.stripe?.subscription(subscriptionId);
    if (subscription === undefined) throw new Error("setup");
    await applySubscription(deps.db, { subscription, eventAt: deps.now(), now: deps.now() });
    const reply = await post("/billing/portal");
    expect(reply.headers?.location).toMatch(/^https:\/\/billing\.stripe\.com\//);
    const sent = stripe.requests.find((r) => r.path === "/v1/billing_portal/sessions");
    expect(sent?.form.get("return_url")).toBe(`${deps.config.appOrigin}/billing`);
  });
});

describe("with billing off (billing spec B11)", () => {
  beforeEach(async () => {
    deps = await testDeps();
    app = createApp(deps, billingRoutes(deps));
    me = await signedInCookie(deps);
  });

  it("shows the plan with no way to pay, and refuses every billing action", async () => {
    const page = String((await get("/billing")).body);
    expect(page).toContain("Free");
    expect(page).not.toContain("/billing/checkout");
    expect(page).toContain("isn't open yet");
    expect((await post("/billing/checkout", "&price=monthly")).status).toBe(404);
    expect((await post("/billing/portal")).status).toBe(404);
    expect((await get("/billing/return?session_id=cs_x")).status).toBe(404);
  });
});
