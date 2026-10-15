import type { Config } from "../config.ts";
import type { Reply } from "./router.ts";
import { type App, text } from "./server.ts";

/** The pages host's default policy: nothing on a public page posts anywhere (ADR-0012). */
export const PAGES_CSP =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * The app host's default policy: spec 2 S2's, with forms allowed to lead to the pages origin,
 * since browsers check `form-action` on the open-preview redirect there (ADR-0012).
 */
export const appCsp = (config: Config) =>
  `default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${config.publicOrigin}`;

/** `reply` with `csp` unless it names its own policy. */
function withPolicy(reply: Reply, csp: string): Reply {
  const headers = reply.headers ?? {};
  const named = Object.keys(headers).some((h) => h.toLowerCase() === "content-security-policy");
  return named ? reply : { ...reply, headers: { ...headers, "content-security-policy": csp } };
}

/** A request's Host, lowercased; a missing or repeated header is no host. */
function hostOf(headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const value = headers.host;
  return typeof value === "string" && value !== "" ? value.toLowerCase() : null;
}

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
    const host = hostOf(request.headers);
    if (host === appHost) return withPolicy(await apps.app(request), appCsp(config));
    if (host !== pagesHost) return text(404, "Not found.");
    const { cookie: _, ...headers } = request.headers;
    return pagesReply(await apps.pages({ ...request, headers }));
  };
}
