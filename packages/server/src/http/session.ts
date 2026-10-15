import type { Account } from "@repowiki/hosted";
import type { Config } from "../config.ts";
import { safeEqual } from "../crypto.ts";
import type { Db } from "../db/db.ts";
import { readSession } from "../store/sessions.ts";
import { HttpError } from "./body.ts";
import { parseCookies, serializeCookie, sessionCookieName } from "./cookies.ts";

export interface Session {
  account: Account;
  csrf: string;
  token: string;
}

type Headers = Readonly<Record<string, string | string[] | undefined>>;

/** A header's value; a repeated header counts as absent rather than picking one. */
function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? undefined : value;
}

/** Cookies are Secure and `__Host-` exactly when the origin is https (spec 2 S6). */
export function secureCookies(config: Config): boolean {
  return config.origin.startsWith("https://");
}

/** The signed-in session for a request's cookie, or null. */
export async function currentSession(
  db: Db,
  config: Config,
  headers: Headers,
  now: string,
): Promise<Session | null> {
  const token = parseCookies(header(headers, "cookie")).get(
    sessionCookieName(secureCookies(config)),
  );
  if (token === undefined || token === "") return null;
  const found = await readSession(db, token, now);
  return found === null ? null : { ...found, token };
}

export function sessionSetCookie(config: Config, token: string, maxAgeSeconds: number): string {
  return serializeCookie(sessionCookieName(secureCookies(config)), token, {
    maxAgeSeconds,
    secure: secureCookies(config),
    httpOnly: true,
  });
}

/** A state-changing request: our Origin, a session, and that session's CSRF token (spec 2 S6). */
export function checkMutation(
  config: Config,
  headers: Headers,
  session: Session | null,
  sentToken: string | null,
): asserts session is Session {
  const origin = header(headers, "origin");
  if (origin === undefined || !safeEqual(origin, config.origin)) {
    throw new HttpError(403, "This request did not come from RepoWiki.");
  }
  if (session === null || !sentToken || !safeEqual(sentToken, session.csrf)) {
    throw new HttpError(403, "Your session has expired. Reload the page and try again.");
  }
}
