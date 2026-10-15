import type { Config } from "../config.ts";
import type { Reply } from "./router.ts";
import { type App, text } from "./server.ts";

/** The pages host's default policy: nothing on a public page posts anywhere (ADR-0012). */
export const PAGES_CSP =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

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
  const named = Object.keys(headers).some((h) => h.toLowerCase() === "content-security-policy");
  return {
    ...reply,
    headers: named ? headers : { ...headers, "content-security-policy": PAGES_CSP },
  };
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
    if (host === appHost) return apps.app(request);
    if (host !== pagesHost) return text(404, "Not found.");
    const { cookie: _, ...headers } = request.headers;
    return pagesReply(await apps.pages({ ...request, headers }));
  };
}
