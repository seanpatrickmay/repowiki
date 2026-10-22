import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { type FakeStripe, fakeStripe } from "../billing/fake.ts";
import { stripeApi } from "../billing/stripe.ts";
import type { App } from "../http/server.ts";
import { accountById, resolveHandle } from "../store/accounts.ts";
import { applySubscription } from "../store/billing.ts";
import { readGitHubToken } from "../store/github-tokens.ts";
import { projectById } from "../store/projects.ts";
import { accountRoutes } from "./account.ts";
import { publicRoutes } from "./public.ts";
import {
  auditOutcomes,
  call,
  form,
  generatedProject,
  publishedStub,
  signedInCookie,
  startedJob,
  testDeps,
} from "./test-app.ts";

const KEYS = { secretKey: "rk_test_abc", webhookSecret: "whsec_abc", testMode: true };

let deps: Deps;
let stripe: FakeStripe;
let app: App;
let me: { cookie: string; csrf: string; accountId: string };

beforeEach(async () => {
  stripe = fakeStripe();
  const base = await testDeps();
  deps = {
    ...base,
    config: { ...base.config, stripe: KEYS },
    stripe: stripeApi(stripe.fetch, KEYS.secretKey),
  };
  app = createApp(deps, accountRoutes(deps));
});
afterEach(async () => deps.db.close());

const post = (path: string, body: string) =>
  call(app, {
    method: "POST",
    path,
    headers: form(me.cookie, deps.config.appOrigin),
    body: `csrf=${me.csrf}&${body}`,
  });

describe("deleting an account (Contract §6.2, ADR-0018)", () => {
  it("shows the account page with a delete form that asks for the login, and sends a visitor to sign in", async () => {
    me = await signedInCookie(deps);
    const page = String(
      (await call(app, { path: "/account", headers: { cookie: me.cookie } })).body,
    );
    expect(page).toContain('action="/account/delete"');
    expect(page).toContain('name="confirm"');
    expect(page).toContain("demo-dev");
    expect((await call(app, { path: "/account" })).headers?.location).toBe("/auth/github");
  });

  it("deletes nothing unless the login is typed", async () => {
    me = await signedInCookie(deps);
    const reply = await post("/account/delete", "confirm=someone-else");
    expect(reply.status).toBe(400);
    expect((await accountById(deps.db, me.accountId))?.status).toBe("active");
  });

  it("withdraws every page, tombstones the handle, signs out everywhere and forgets the token", async () => {
    const p = await generatedProject(deps);
    me = { cookie: p.cookie, csrf: p.csrf, accountId: p.accountId };
    const published = await publishedStub(deps, p.accountId, "second", 4242);
    const reply = await post("/account/delete", "confirm=Demo-Dev");
    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain("deleted");
    expect(String(reply.headers?.["set-cookie"])).toMatch(/session=;.*Max-Age=0/);

    expect((await accountById(deps.db, p.accountId))?.status).toBe("deleting");
    for (const id of [p.projectId, published]) {
      expect(await projectById(deps.db, id)).toMatchObject({
        state: "withdrawn",
        withdrawReason: "account-deleted",
      });
    }
    expect((await resolveHandle(deps.db, "demo-dev")).kind).toBe("gone");
    const pages = createApp(deps, publicRoutes(deps), { host: "pages" });
    expect((await call(pages, { path: "/demo-dev" })).status).toBe(410);
    expect((await call(pages, { path: "/demo-dev/second/" })).status).toBe(410);
    expect(await readGitHubToken(deps.db, deps.config.tokenKey, p.accountId)).toBeNull();
    const signedOut = await call(app, { path: "/account", headers: { cookie: me.cookie } });
    expect(signedOut.headers?.location).toBe("/auth/github");
    expect(await auditOutcomes(deps.db, "account.delete", p.accountId)).toEqual(["allowed"]);
  });

  it("cancels a Pro subscription first, so a deleted account is never charged again", async () => {
    me = await signedInCookie(deps);
    const { subscriptionId } = stripe.subscribe(me.accountId, "repowiki_pro_monthly");
    const subscription = await deps.stripe?.subscription(subscriptionId);
    if (subscription === undefined) throw new Error("setup");
    await applySubscription(deps.db, { subscription, eventAt: deps.now(), now: deps.now() });
    expect((await post("/account/delete", "confirm=demo-dev")).status).toBe(200);
    expect(
      stripe.requests.some((r) => r.method === "DELETE" && r.path.includes(subscriptionId)),
    ).toBe(true);
  });

  it("keeps the account while Stripe can't cancel the subscription", async () => {
    me = await signedInCookie(deps);
    const { subscriptionId } = stripe.subscribe(me.accountId, "repowiki_pro_monthly");
    const subscription = await deps.stripe?.subscription(subscriptionId);
    if (subscription === undefined) throw new Error("setup");
    await applySubscription(deps.db, { subscription, eventAt: deps.now(), now: deps.now() });
    deps = {
      ...deps,
      stripe: stripeApi(async () => new Response("down", { status: 503 }), "rk_test_abc"),
    };
    app = createApp(deps, accountRoutes(deps));
    expect((await post("/account/delete", "confirm=demo-dev")).status).toBe(502);
    expect((await accountById(deps.db, me.accountId))?.status).toBe("active");
  });

  it("waits for a build in flight to finish", async () => {
    await startedJob(deps);
    me = await signedInCookie(deps);
    const reply = await post("/account/delete", "confirm=demo-dev");
    expect(reply.status).toBe(409);
    expect(String(reply.body)).toContain("build");
    expect((await accountById(deps.db, me.accountId))?.status).toBe("active");
  });
});
