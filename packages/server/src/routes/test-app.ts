import { Readable } from "node:stream";
import type { Deps } from "../app.ts";
import { loadConfig } from "../config.ts";
import type { Db } from "../db/db.ts";
import { fakeEndpoints } from "../github/endpoints.ts";
import { FAKE_TOKEN, FAKE_USER, fakeGitHubFetch } from "../github/fake.ts";
import { HttpError } from "../http/body.ts";
import type { Method, Reply, RouteRequest } from "../http/router.ts";
import { type App, text } from "../http/server.ts";
import { recordingRunner } from "../runner/runner.ts";
import { signIn } from "../store/accounts.ts";
import { saveGitHubToken } from "../store/github-tokens.ts";
import { createSession } from "../store/sessions.ts";
import { freshDb } from "../store/test-db.ts";

export const TEST_NOW = "2026-10-14T12:00:00.000Z";

/** Test-only: demo-mode dependencies over a fresh database, with a fixed clock and ids. */
export async function testDeps(overrides: Partial<Deps> = {}): Promise<Deps & { db: Db }> {
  const config = loadConfig({ REPOWIKI_MODE: "demo" });
  const github = fakeEndpoints(config.origin);
  let n = 0;
  return {
    config,
    db: await freshDb(),
    fetch: fakeGitHubFetch(github),
    github,
    now: () => TEST_NOW,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    runner: recordingRunner().runner,
    ...overrides,
  };
}

/** Test-only: one request to `app` without a socket; path and errors handled as `listen` does. */
export async function call(
  app: App,
  init: { method?: Method; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  const headers = Object.fromEntries(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const method = init.method ?? "GET";
  const raw = Object.assign(
    Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]),
    { headers, method },
  ) as unknown as RouteRequest["raw"];
  const at = init.path.indexOf("?");
  const request = app({
    method,
    path: at === -1 ? init.path : init.path.slice(0, at),
    params: {},
    query: new URLSearchParams(at === -1 ? "" : init.path.slice(at + 1)),
    headers,
    raw,
  });
  // As `listen` does: an HttpError is the client's answer.
  return request.catch((e: unknown) => {
    if (e instanceof HttpError) return text(e.status, e.message);
    throw e;
  });
}

/** Test-only: the value a reply's Set-Cookie gives `name`, or undefined. */
export function setCookie(reply: Reply, name: string): string | undefined {
  const value = reply.headers?.["set-cookie"];
  const all = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const found = all.find((c) => c.startsWith(`${name}=`));
  return found === undefined
    ? undefined
    : decodeURIComponent(found.slice(name.length + 1).split(";")[0] ?? "");
}

/** Test-only: the fake GitHub user signed in with their token stored; a cookie and CSRF token. */
export async function signedInCookie(
  deps: Deps,
): Promise<{ cookie: string; csrf: string; accountId: string }> {
  const signed = await signIn(
    deps.db,
    {
      githubUserId: FAKE_USER.id,
      login: FAKE_USER.login,
      displayName: FAKE_USER.name,
      githubCreatedAt: FAKE_USER.created_at,
    },
    { newAccountId: deps.newId(), allowNew: () => true, now: deps.now() },
  );
  if (signed === null) throw new Error("sign-in refused");
  const { id } = signed.account;
  await deps.db.transaction((tx) => saveGitHubToken(tx, deps.config.tokenKey, id, FAKE_TOKEN));
  const session = await createSession(deps.db, id, deps.now());
  return { cookie: `session=${session.token}`, csrf: session.csrf, accountId: id };
}

/** Test-only: the headers of a same-origin form post. */
export function form(cookie: string, origin: string): Record<string, string> {
  return { cookie, origin, "content-type": "application/x-www-form-urlencoded" };
}
