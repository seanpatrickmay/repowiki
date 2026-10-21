import type { IncomingMessage } from "node:http";
import type { Config } from "../config.ts";
import type { Reply, RouteRequest } from "./router.ts";
import { type App, text } from "./server.ts";

/** The pages host's default policy: nothing on a public page posts anywhere (ADR-0012). */
export const PAGES_CSP =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * The app host's default policy: spec 2 S2's, with forms allowed to lead to the pages origin,
 * since browsers check `form-action` on the open-preview redirect there (ADR-0012).
 */
export const appCsp = (config: Config) =>
  `default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${config.publicOrigin}${config.stripe === null ? "" : ` ${STRIPE_PAGES}`}`;

/** Where billing's form posts redirect (billing spec B5, B7): Stripe Checkout and the portal. */
export const STRIPE_PAGES = "https://checkout.stripe.com https://billing.stripe.com";

/** `reply` with `csp` unless it names its own policy. */
function withPolicy(reply: Reply, csp: string): Reply {
  const headers = reply.headers ?? {};
  const named = Object.keys(headers).some((h) => h.toLowerCase() === "content-security-policy");
  return named ? reply : { ...reply, headers: { ...headers, "content-security-policy": csp } };
}

/** A request's Host, lowercased; a missing or repeated header is no host. */
function hostOf(request: RouteRequest): string | null {
  // Node keeps only the first of repeated Host headers in `headers`; `headersDistinct` has all.
  const all = (request.raw as Partial<Pick<IncomingMessage, "headersDistinct">>).headersDistinct
    ?.host;
  if (all !== undefined && all.length !== 1) return null;
  const value = request.headers.host;
  return typeof value === "string" && value !== "" ? value.toLowerCase() : null;
}

/** Fly's health check (deploy/fly.server.toml): any host, before routing, never cached. */
const HEALTH: Reply = {
  status: 200,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  body: "ok",
};

/** A pages reply: no cookie set, whatever a handler did, and the pages policy unless it has one. */
function pagesReply(reply: Reply): Reply {
  const headers = Object.fromEntries(
    Object.entries(reply.headers ?? {}).filter(([name]) => name.toLowerCase() !== "set-cookie"),
  );
  return withPolicy({ ...reply, headers }, PAGES_CSP);
}

/**
 * One listener, two origins (ADR-0012): the app host's requests go to `app`; the pages host's go
 * to `pages` without their Cookie header, and its replies set none; any other host is a 404.
 */
export function byHost(config: Config, apps: { app: App; pages: App }): App {
  const appHost = new URL(config.appOrigin).host;
  const pagesHost = new URL(config.publicOrigin).host;
  return async (request) => {
    if ((request.method === "GET" || request.method === "HEAD") && request.path === "/healthz") {
      return HEALTH;
    }
    const host = hostOf(request);
    if (host === appHost) return withPolicy(await apps.app(request), appCsp(config));
    if (host !== pagesHost) return text(404, "Not found.");
    const { cookie: _, ...headers } = request.headers;
    return pagesReply(await apps.pages({ ...request, headers }));
  };
}
