import type { Account } from "@repowiki/hosted";
import type { Config } from "../config.ts";
import { safeEqual } from "../crypto.ts";
import type { Queryable } from "../db/db.ts";
import { readSession, SESSION_DAYS } from "../store/sessions.ts";
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
  return config.appOrigin.startsWith("https://");
}

/**
 * The request `currentSession` reads: its headers, and the connection's `raw` message, which
 * keys the renewal so a handler that copies the request or its headers cannot lose it.
 */
export interface SessionRequest {
  headers: Headers;
  raw: object;
}

/** The cookie to re-issue for a request whose session just slid; read by `createApp`. */
const renewals = new WeakMap<object, string>();

export function renewalCookie(request: SessionRequest): string | undefined {
  return renewals.get(request.raw);
}

/** The signed-in session for a request's cookie, or null; a slid session's cookie is re-issued. */
export async function currentSession(
  db: Queryable,
  config: Config,
  request: SessionRequest,
  now: string,
): Promise<Session | null> {
  const token = parseCookies(header(request.headers, "cookie")).get(
    sessionCookieName(secureCookies(config)),
  );
  if (token === undefined || token === "") return null;
  const found = await readSession(db, token, now);
  if (found === null) return null;
  if (found.renewed) {
    renewals.set(request.raw, sessionSetCookie(config, token, SESSION_DAYS * 86_400));
  }
  return { account: found.account, csrf: found.csrf, token };
}

export function sessionSetCookie(config: Config, token: string, maxAgeSeconds: number): string {
  return serializeCookie(sessionCookieName(secureCookies(config)), token, {
    maxAgeSeconds,
    secure: secureCookies(config),
    httpOnly: true,
  });
}

/** Mutations one session may make in any minute (spec 2 §10, M14e A3). */
export const MUTATIONS_PER_MINUTE = 60;
const recent = new Map<string, number[]>();

/** Whether this session is past its mutation limit; every call forgets sessions idle a minute. */
function overLimit(token: string, at: number): boolean {
  for (const [key, times] of recent) {
    const kept = times.filter((t) => at - t < 60_000);
    if (kept.length === 0) recent.delete(key);
    else recent.set(key, kept);
  }
  const mine = recent.get(token) ?? [];
  if (mine.length >= MUTATIONS_PER_MINUTE) return true;
  recent.set(token, [...mine, at]);
  return false;
}

/**
 * A state-changing request: our Origin, a session, that session's CSRF token (spec 2 S6), and
 * at most MUTATIONS_PER_MINUTE of them a minute (429 past it).
 */
export function checkMutation(
  config: Config,
  headers: Headers,
  session: Session | null,
  sentToken: string | null,
): asserts session is Session {
  const origin = header(headers, "origin");
  if (origin === undefined || !safeEqual(origin, config.appOrigin)) {
    throw new HttpError(403, "This request did not come from RepoWiki.");
  }
  if (session === null || !sentToken || !safeEqual(sentToken, session.csrf)) {
    throw new HttpError(403, "Your session has expired. Reload the page and try again.");
  }
  if (overLimit(session.token, Date.now())) {
    throw new HttpError(429, "Too many changes in a minute. Wait a moment and try again.");
  }
}
