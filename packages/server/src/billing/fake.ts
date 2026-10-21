import { PRO_PRICES, type SubscriptionStatus } from "@repowiki/hosted";
import { STRIPE_API } from "./stripe.ts";

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  form: URLSearchParams;
}

interface FakeSubscription {
  id: string;
  customer: string;
  status: SubscriptionStatus;
  lookupKey: string;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  accountId: string;
}

interface FakeSession {
  id: string;
  accountId: string;
  priceId: string;
  customer: string | null;
  subscription: string | null;
}

export interface FakeStripe {
  fetch: typeof fetch;
  requests: FakeRequest[];
  /** Pays a Checkout Session, as the student would on Stripe's page; returns the new ids. */
  complete(sessionId: string, at?: { periodEnd?: string }): Paid;
  /** A subscription made outside Checkout, for tests that start from Pro. */
  subscribe(accountId: string, lookupKey: string): Paid;
  /** Changes a subscription as a portal visit or a failed payment would. */
  update(
    subscriptionId: string,
    patch: { status?: SubscriptionStatus; cancelAtPeriodEnd?: boolean },
  ): void;
}

interface Paid {
  customerId: string;
  subscriptionId: string;
}

const MONTH_SECONDS = 30 * 86_400;

/** An in-memory Stripe for tests (billing spec §7): the five calls RepoWiki makes, nothing else. */
export function fakeStripe(): FakeStripe {
  const requests: FakeRequest[] = [];
  const prices = new Map<string, string>(
    Object.values(PRO_PRICES).map((p, i) => [`price_fake${i + 1}`, p.lookupKey] as const),
  );
  const sessions = new Map<string, FakeSession>();
  const subscriptions = new Map<string, FakeSubscription>();
  let serial = 0;
  const next = (prefix: string) => `${prefix}_fake${(++serial).toString().padStart(6, "0")}`;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const missing = () => json({ error: { type: "invalid_request_error" } }, 404);
  const subscriptionBody = (s: FakeSubscription) => ({
    id: s.id,
    customer: s.customer,
    status: s.status,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    metadata: { account_id: s.accountId },
    items: { data: [{ current_period_end: s.periodEnd, price: { lookup_key: s.lookupKey } }] },
  });
  const create = (accountId: string, lookupKey: string, customer: string | null, end?: string) => {
    const s: FakeSubscription = {
      id: next("sub"),
      customer: customer ?? next("cus"),
      status: "active",
      lookupKey,
      periodEnd:
        end === undefined ? Math.floor(Date.now() / 1000) + MONTH_SECONDS : Date.parse(end) / 1000,
      cancelAtPeriodEnd: false,
      accountId,
    };
    subscriptions.set(s.id, s);
    return s;
  };

  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== STRIPE_API) return new Response("not Stripe", { status: 502 });
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    requests.push({ method, path: `${url.pathname}${url.search}`, headers, form });
    const [, , kind, id] = url.pathname.split("/");
    if (method === "GET" && url.pathname === "/v1/prices") {
      const wanted = url.searchParams.getAll("lookup_keys[]");
      const data = [...prices].filter(([, key]) => wanted.includes(key));
      return json({ data: data.map(([pid, key]) => ({ id: pid, lookup_key: key })) });
    }
    if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const session: FakeSession = {
        id: next("cs_test"),
        accountId: form.get("client_reference_id") ?? "",
        priceId: form.get("line_items[0][price]") ?? "",
        customer: form.get("customer"),
        subscription: null,
      };
      sessions.set(session.id, session);
      return json({ id: session.id, url: `https://checkout.stripe.com/c/pay/${session.id}` });
    }
    if (method === "GET" && url.pathname.startsWith("/v1/checkout/sessions/")) {
      const s = sessions.get(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
      if (s === undefined) return missing();
      return json({
        id: s.id,
        status: s.subscription === null ? "open" : "complete",
        client_reference_id: s.accountId,
        customer: s.customer,
        subscription: s.subscription,
      });
    }
    if (kind === "subscriptions" && id !== undefined) {
      const s = subscriptions.get(decodeURIComponent(id));
      if (s === undefined) return missing();
      if (method === "DELETE") s.status = "canceled";
      return json(subscriptionBody(s));
    }
    if (method === "POST" && url.pathname === "/v1/billing_portal/sessions") {
      return json({ id: next("bps"), url: `https://billing.stripe.com/p/session/${next("test")}` });
    }
    return missing();
  };

  return {
    fetch: fetchFn,
    requests,
    complete(sessionId, at = {}) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new Error(`no session ${sessionId}`);
      const lookupKey = prices.get(session.priceId) ?? "";
      const s = create(session.accountId, lookupKey, session.customer, at.periodEnd);
      session.customer = s.customer;
      session.subscription = s.id;
      return { customerId: s.customer, subscriptionId: s.id };
    },
    subscribe(accountId, lookupKey) {
      const s = create(accountId, lookupKey, null);
      return { customerId: s.customer, subscriptionId: s.id };
    },
    update(subscriptionId, patch) {
      const s = subscriptions.get(subscriptionId);
      if (s === undefined) throw new Error(`no subscription ${subscriptionId}`);
      if (patch.status !== undefined) s.status = patch.status;
      if (patch.cancelAtPeriodEnd !== undefined) s.cancelAtPeriodEnd = patch.cancelAtPeriodEnd;
    },
  };
}
