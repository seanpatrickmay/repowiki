import { z } from "zod";
import { type Deps, logOf, nameOf } from "../app.ts";
import { verifyStripeSignature } from "../billing/signature.ts";
import { HttpError, readBody } from "../http/body.ts";
import type { Route } from "../http/router.ts";
import { text } from "../http/server.ts";
import { applySubscription, eventSeen, pruneEvents, recordEvent } from "../store/billing.ts";

/** Stripe's events can carry a whole invoice; larger than the app's 64 KiB form limit. */
export const WEBHOOK_LIMIT = 262_144;

/** The events that can change a subscription (billing spec B8); the rest are acknowledged. */
export const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

const Event = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]{1,250}$/),
  type: z.string(),
  created: z.number().int(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

const SubscriptionRef = z.string().regex(/^sub_[A-Za-z0-9]{1,250}$/);

/**
 * The subscription an event is about: the object itself for subscription events, its
 * `subscription` for a checkout session or an older invoice, or where this API version keeps it
 * on an invoice, `parent.subscription_details.subscription`.
 */
function subscriptionOf(type: string, object: Record<string, unknown>): string | null {
  const parent = object.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  const candidate = type.startsWith("customer.subscription.")
    ? object.id
    : (object.subscription ?? parent?.subscription_details?.subscription);
  const parsed = SubscriptionRef.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Stripe's webhook (billing spec B8): verify, skip what was handled, re-read, apply. */
export function billingWebhookRoutes(deps: Deps): Route[] {
  return [
    {
      method: "POST",
      pattern: "/billing/webhook",
      handler: async (request) => {
        const stripe = deps.stripe;
        const secret = deps.config.stripe?.webhookSecret;
        if (stripe === null || secret === undefined) throw new HttpError(404, "Not found");
        const raw = await readBody(request.raw, WEBHOOK_LIMIT);
        const header = request.headers["stripe-signature"];
        const check = verifyStripeSignature({
          header: Array.isArray(header) ? header[0] : header,
          rawBody: raw,
          secret,
          now: Date.parse(deps.now()),
        });
        if (!check.ok) {
          logOf(deps)({ billing: "webhook-refused", reason: check.reason });
          return text(400, "Bad signature.");
        }
        let body: unknown = null;
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          // A signed body that isn't JSON is refused below like any other malformed event.
        }
        const parsed = Event.safeParse(body);
        if (!parsed.success) return text(400, "Not a Stripe event.");
        const event = parsed.data;
        if (await eventSeen(deps.db, event.id)) return text(200, "Already handled.");
        const subscriptionId = HANDLED_EVENTS.has(event.type)
          ? subscriptionOf(event.type, event.data.object)
          : null;
        const now = deps.now();
        if (subscriptionId !== null) {
          try {
            const subscription = await stripe.subscription(subscriptionId);
            const eventAt = new Date(event.created * 1000).toISOString();
            await applySubscription(deps.db, { subscription, eventAt, now });
          } catch (error) {
            // Not recorded, so Stripe's retry is handled in full.
            logOf(deps)({ billing: "webhook-failed", type: event.type, error: nameOf(error) });
            return text(500, "Try again.");
          }
        }
        await recordEvent(deps.db, event.id, now);
        await pruneEvents(deps.db, now);
        return text(200, "OK");
      },
    },
  ];
}
