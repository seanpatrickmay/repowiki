import { randomUUID } from "node:crypto";
import { PRO_PRICES, ProPrice } from "@repowiki/hosted";
import { type Deps, logOf } from "../app.ts";
import type { StripeApi } from "../billing/stripe.ts";
import { HttpError } from "../http/body.ts";
import type { Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { currentSession } from "../http/session.ts";
import { billingPage } from "../pages/billing.ts";
import { pageSession } from "../pages/refusal.ts";
import { appendAudit } from "../store/audit.ts";
import { applySubscription, billingOf } from "../store/billing.ts";
import { mutation } from "./drafts.ts";

/** The billing page, Checkout, its return and the portal (billing spec B5–B7, B12). */
export function billingRoutes(deps: Deps): Route[] {
  /** Stripe, or a 404 when billing is off (B11). */
  const stripe = (): StripeApi => {
    if (deps.stripe === null) throw new HttpError(404, "Not found");
    return deps.stripe;
  };
  const audit = (action: string, accountId: string) =>
    deps.db.transaction((tx) =>
      appendAudit(tx, {
        id: randomUUID(),
        actor: "author",
        action,
        target: { entity: "account", id: accountId },
        outcome: "allowed",
        createdAt: deps.now(),
      }),
    );

  return [
    {
      method: "GET",
      pattern: "/billing",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        if (session === null) return redirect("/auth/github");
        const body = billingPage({
          plan: session.account.plan,
          billing: await billingOf(deps.db, session.account.id),
          enabled: deps.stripe !== null,
          testMode: deps.config.stripe?.testMode ?? false,
          session: pageSession(session),
        });
        return html(200, body, { "cache-control": "private, no-store" });
      },
    },
    {
      method: "POST",
      pattern: "/billing/checkout",
      handler: async (request) => {
        const api = stripe();
        const { session, form } = await mutation(deps, request);
        const price = ProPrice.safeParse(form.get("price"));
        if (!price.success) throw new HttpError(400, "Choose a price.");
        // An account already on Pro manages its subscription instead of buying a second one.
        if (session.account.plan === "pro") return redirect("/billing");
        const existing = await billingOf(deps.db, session.account.id);
        const created = await api.createCheckout({
          priceId: await api.priceId(PRO_PRICES[price.data].lookupKey),
          accountId: session.account.id,
          customerId: existing?.customerId ?? null,
          successUrl: `${deps.config.appOrigin}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${deps.config.appOrigin}/billing`,
        });
        await audit("billing.checkout", session.account.id);
        return redirect(created.url);
      },
    },
    {
      method: "GET",
      pattern: "/billing/return",
      handler: async (request) => {
        const api = stripe();
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        if (session === null) return redirect("/auth/github");
        const id = request.query.get("session_id") ?? "";
        if (!/^cs_[A-Za-z0-9_]{1,250}$/.test(id)) return redirect("/billing");
        const checkout = await api.checkoutSession(id);
        // Only the account that opened the session may apply it (billing spec §6).
        const mine = checkout.accountId === session.account.id;
        if (mine && checkout.complete && checkout.subscriptionId !== null) {
          const subscription = await api.subscription(checkout.subscriptionId);
          const now = deps.now();
          await applySubscription(deps.db, { subscription, eventAt: now, now });
        } else if (!mine) {
          logOf(deps)({ billing: "return-not-mine" });
        }
        return redirect("/billing");
      },
    },
    {
      method: "POST",
      pattern: "/billing/portal",
      handler: async (request) => {
        const api = stripe();
        const { session } = await mutation(deps, request);
        const billing = await billingOf(deps.db, session.account.id);
        if (billing === null) return redirect("/billing");
        const portal = await api.createPortal(
          billing.customerId,
          `${deps.config.appOrigin}/billing`,
        );
        await audit("billing.portal", session.account.id);
        return redirect(portal.url);
      },
    },
  ];
}
