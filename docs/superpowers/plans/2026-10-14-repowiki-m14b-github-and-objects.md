# M14b GitHub Sign-in, GitHub Client and Object Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign in with GitHub (or the built-in fake), keep the GitHub token encrypted, read the GitHub facts the Contract's eligibility rule needs, and store objects on disk or in R2.

**Architecture:** OAuth app, no scopes (S7); one injected `fetch` for every GitHub call, so the fake GitHub (S18) is a `fetch` too and nothing touches the network in tests; responses validated with zod at the boundary; an `ObjectStore` seam with a filesystem twin and an S3 implementation that signs SigV4 itself (S12).

**Tech Stack:** TypeScript, zod, `node:crypto` (AES-256-GCM, HMAC-SHA256), vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-repowiki-hosted-slice-design.md` (S6–S8, S12, S18).

## Global Constraints

- No new dependencies.
- GitHub responses are parsed with zod before use (CLAUDE.md "validate data at boundaries").
- Tokens never appear in logs, errors or HTML.
- One branch per task, stacked on M14a: `m14/server-sessions`, `m14/server-oauth`, `m14/server-github`, `m14/server-objects`.

## Review Focus

1. **A callback with a state that does not match the cookie, or no cookie at all**: refused, no session. Pinned in Task 2.
2. **A GitHub token whose ciphertext was tampered with or moved to another account's row**: decryption fails closed. Pinned in Task 1.
3. **A POST with the right CSRF token but a foreign Origin, or no Origin**: refused. Pinned in Task 1.
4. **A repository list longer than one page**: every public repository is found, private ones never. Pinned in Task 3.
5. **An object key with `..`, a leading slash or a backslash**: refused before touching disk or R2. Pinned in Task 4.

---

### Task 1: Encrypted GitHub tokens, the session helpers and CSRF

**Files:**
- Modify: `packages/server/src/crypto.ts`, `packages/server/src/crypto.test.ts`
- Create: `packages/server/src/store/github-tokens.ts`, `packages/server/src/store/github-tokens.test.ts`
- Create: `packages/server/src/http/session.ts`, `packages/server/src/http/session.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: `Config` (M14a T1), `Db`, `Queryable` (T2), `readSession` (T3), `parseCookies`, `serializeCookie`, `sessionCookieName`, `safeEqual`, `HttpError`.
- Produces: `Sealed`, `seal(key, plaintext, associated)`, `unseal(key, sealed, associated): string | null`; `saveGitHubToken(tx, key, accountId, token)`, `readGitHubToken(db, key, accountId): Promise<string | null>`; `Session` (`account`, `csrf`, `token`), `currentSession(db, config, headers, now)`, `sessionSetCookie(config, token, maxAgeSeconds)`, `secureCookies(config)`, `checkMutation(config, headers, session, sentToken)`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-sessions
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/server/src/crypto.test.ts`:

```ts
import { seal, unseal } from "./crypto.ts";

describe("sealed GitHub tokens (spec 2 S7)", () => {
  const key = Buffer.alloc(32, 9);
  const other = Buffer.alloc(32, 8);

  it("round-trip under the same key and account", () => {
    const sealed = seal(key, "gho_secret", "account-1");
    expect(sealed.ciphertext.toString("utf8")).not.toContain("gho_secret");
    expect(sealed.nonce).toHaveLength(12);
    expect(unseal(key, sealed, "account-1")).toBe("gho_secret");
  });

  it("fail closed with another key, another account or a flipped bit", () => {
    const sealed = seal(key, "gho_secret", "account-1");
    expect(unseal(other, sealed, "account-1")).toBeNull();
    expect(unseal(key, sealed, "account-2")).toBeNull();
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(unseal(key, { ...sealed, ciphertext: flipped }, "account-1")).toBeNull();
  });

  it("use a fresh nonce every time", () => {
    expect(seal(key, "x", "a").nonce.equals(seal(key, "x", "a").nonce)).toBe(false);
  });
});
```

`packages/server/src/store/github-tokens.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import { signIn } from "./accounts.ts";
import { readGitHubToken, saveGitHubToken } from "./github-tokens.ts";
import { freshDb } from "./test-db.ts";

const KEY = Buffer.alloc(32, 3);
const A1 = "00000000-0000-4000-8000-000000000001";
const A2 = "00000000-0000-4000-8000-000000000002";
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  for (const [id, githubUserId] of [
    [A1, 1],
    [A2, 2],
  ] as const) {
    await signIn(
      db,
      { githubUserId, login: `u${githubUserId}`, displayName: "U", githubCreatedAt: "2019-01-01T00:00:00Z" },
      { newAccountId: id, allowNew: () => true, now: "2026-10-14T12:00:00Z" },
    );
  }
});
afterEach(async () => db.close());

describe("stored GitHub tokens (spec 2 S7)", () => {
  it("are kept encrypted and replaced on the next sign-in", async () => {
    await db.transaction((tx) => saveGitHubToken(tx, KEY, A1, "gho_first"));
    await db.transaction((tx) => saveGitHubToken(tx, KEY, A1, "gho_second"));
    const rows = await db.query<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM github_tokens");
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]?.ciphertext ?? []).toString("utf8")).not.toContain("gho_");
    expect(await readGitHubToken(db, KEY, A1)).toBe("gho_second");
  });

  it("do not decrypt once moved to another account's row", async () => {
    await db.transaction((tx) => saveGitHubToken(tx, KEY, A1, "gho_first"));
    await db.query("UPDATE github_tokens SET account_id = $1", [A2]);
    expect(await readGitHubToken(db, KEY, A2)).toBeNull();
    expect(await readGitHubToken(db, KEY, A1)).toBeNull();
  });
});
```

`packages/server/src/http/session.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import type { Db } from "../db/db.ts";
import { signIn } from "../store/accounts.ts";
import { createSession } from "../store/sessions.ts";
import { freshDb } from "../store/test-db.ts";
import { HttpError } from "./body.ts";
import { checkMutation, currentSession, sessionSetCookie } from "./session.ts";

const T0 = "2026-10-14T12:00:00.000Z";
const A1 = "00000000-0000-4000-8000-000000000001";
const dev = loadConfig({ REPOWIKI_MODE: "demo" });
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  await signIn(
    db,
    { githubUserId: 1, login: "u1", displayName: "U", githubCreatedAt: "2019-01-01T00:00:00Z" },
    { newAccountId: A1, allowNew: () => true, now: T0 },
  );
});
afterEach(async () => db.close());

describe("currentSession (spec 2 S6)", () => {
  it("reads the session cookie for this origin's cookie name", async () => {
    const { token, csrf } = await createSession(db, A1, T0);
    const session = await currentSession(db, dev, { cookie: `other=1; session=${token}` }, T0);
    expect(session).toMatchObject({ account: { id: A1 }, csrf, token });
    expect(await currentSession(db, dev, { cookie: `__Host-session=${token}` }, T0)).toBeNull();
    expect(await currentSession(db, dev, {}, T0)).toBeNull();
  });

  it("sets a Secure __Host- cookie only on an https origin", () => {
    expect(sessionSetCookie(dev, "t", 60)).toBe("session=t; Path=/; Max-Age=60; SameSite=Lax; HttpOnly");
    const prod = { ...dev, origin: "https://repowiki.dev" };
    expect(sessionSetCookie(prod, "t", 60)).toBe(
      "__Host-session=t; Path=/; Max-Age=60; SameSite=Lax; HttpOnly; Secure",
    );
  });
});

describe("checkMutation (spec 2 S6)", () => {
  const session = { account: {} as never, csrf: "right", token: "t" };
  const origin = dev.origin;

  it("passes our origin with the session's CSRF token", () => {
    expect(() => checkMutation(dev, { origin }, session, "right")).not.toThrow();
  });

  it("refuses a foreign or missing Origin, a wrong token, or no session", () => {
    const refuse = (f: () => void) => {
      expect(f).toThrow(HttpError);
      try {
        f();
      } catch (e) {
        expect((e as HttpError).status).toBe(403);
      }
    };
    refuse(() => checkMutation(dev, { origin: "https://evil.example" }, session, "right"));
    refuse(() => checkMutation(dev, {}, session, "right"));
    refuse(() => checkMutation(dev, { origin }, session, "wrong"));
    refuse(() => checkMutation(dev, { origin }, session, null));
    refuse(() => checkMutation(dev, { origin }, null, "right"));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server`
Expected: FAIL — `seal` is not exported; cannot resolve `./github-tokens.ts`, `./session.ts`.

- [ ] **Step 4: Write the implementation**

Append to `packages/server/src/crypto.ts` (and add `createCipheriv, createDecipheriv` to its `node:crypto` import):

```ts
export interface Sealed {
  /** The AES-256-GCM ciphertext followed by its 16-byte tag. */
  ciphertext: Buffer;
  nonce: Buffer;
}

/** Encrypt `plaintext` bound to `associated` (an account id), so a row moved elsewhere fails. */
export function seal(key: Buffer, plaintext: string, associated: string): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(associated, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

/** The plaintext, or null when the key, the associated data or a byte is wrong. */
export function unseal(key: Buffer, sealed: Sealed, associated: string): string | null {
  if (sealed.ciphertext.length < 16) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
    decipher.setAAD(Buffer.from(associated, "utf8"));
    decipher.setAuthTag(sealed.ciphertext.subarray(-16));
    const body = sealed.ciphertext.subarray(0, -16);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
```

`packages/server/src/store/github-tokens.ts`:

```ts
import { seal, unseal } from "../crypto.ts";
import type { Queryable } from "../db/db.ts";

/** Keep the account's GitHub token, encrypted and bound to the account (spec 2 S7). */
export async function saveGitHubToken(
  tx: Queryable,
  key: Buffer,
  accountId: string,
  token: string,
): Promise<void> {
  const sealed = seal(key, token, accountId);
  await tx.query(
    `INSERT INTO github_tokens (account_id, ciphertext, nonce) VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce`,
    [accountId, sealed.ciphertext, sealed.nonce],
  );
}

export async function readGitHubToken(
  db: Queryable,
  key: Buffer,
  accountId: string,
): Promise<string | null> {
  const rows = await db.query<{ ciphertext: Uint8Array; nonce: Uint8Array }>(
    "SELECT ciphertext, nonce FROM github_tokens WHERE account_id = $1",
    [accountId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return unseal(
    key,
    { ciphertext: Buffer.from(row.ciphertext), nonce: Buffer.from(row.nonce) },
    accountId,
  );
}
```

`packages/server/src/http/session.ts`:

```ts
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

const header = (headers: Headers, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** Cookies are Secure and `__Host-` exactly when the origin is https (spec 2 S6). */
export function secureCookies(config: Config): boolean {
  return config.origin.startsWith("https://");
}

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
  if (header(headers, "origin") !== config.origin) {
    throw new HttpError(403, "This request did not come from RepoWiki.");
  }
  if (session === null || sentToken === null || !safeEqual(sentToken, session.csrf)) {
    throw new HttpError(403, "Your session has expired. Reload the page and try again.");
  }
}
```

Add to `packages/server/src/index.ts`:

```ts
export { type Sealed, seal, unseal } from "./crypto.ts";
export {
  checkMutation,
  currentSession,
  type Session,
  secureCookies,
  sessionSetCookie,
} from "./http/session.ts";
export { readGitHubToken, saveGitHubToken } from "./store/github-tokens.ts";
```

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server
pnpm check
git add packages/server
git -c user.email=sean.may101@gmail.com commit -m "feat(server): seal GitHub tokens and check origin and CSRF on every mutation"
```

Expected: PASS, then a green check.

---

### Task 2: GitHub OAuth, the fake GitHub and the sign-in routes

**Files:**
- Create: `packages/server/src/github/endpoints.ts`, `packages/server/src/github/oauth.ts`, `packages/server/src/github/fake.ts`
- Create: `packages/server/src/pages/layout.ts`, `packages/server/src/pages/layout.test.ts`
- Create: `packages/server/src/app.ts`, `packages/server/src/routes/auth.ts`, `packages/server/src/routes/auth.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: Task 1; M14a's router, server helpers, `signIn`, `createSession`, `endSession`, `readForm`, `randomToken`, `safeEqual`.
- Produces: `GitHubEndpoints` (`web`, `api`), `GITHUB`, `fakeEndpoints(origin)`; `authorizeUrl(endpoints, clientId, redirectUri, state)`, `exchangeCode(fetch, endpoints, input): Promise<string | null>`; `FAKE_USER`, `FAKE_REPO`, `FAKE_TOKEN`, `fakeGitHubFetch(endpoints): typeof fetch`, `fakeAuthorizeRoute(endpoints)`; `escapeHtml(text)`, `page({ title, body, session })`; `Deps`, `createApp(deps, routes)`, `authRoutes(deps)`; test-only `testDeps()` and `call(app, init)` live in `routes/test-app.ts`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-oauth
```

- [ ] **Step 2: Write the failing tests**

`packages/server/src/pages/layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { escapeHtml, page } from "./layout.ts";

describe("pages (spec 2 §10)", () => {
  it("escape every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("wrap a body in the layout with an escaped title and the sign-out form when signed in", () => {
    const signedOut = page({ title: "<Home>", body: "<p>hi</p>", session: null });
    expect(signedOut).toContain("<title>&lt;Home&gt; · RepoWiki</title>");
    expect(signedOut).toContain("<p>hi</p>");
    expect(signedOut).not.toContain("/auth/signout");
    const signedIn = page({ title: "x", body: "", session: { csrf: "c&t", login: "sean" } });
    expect(signedIn).toContain('action="/auth/signout"');
    expect(signedIn).toContain('value="c&amp;t"');
  });
});
```

`packages/server/src/routes/test-app.ts`:

```ts
import { loadConfig } from "../config.ts";
import type { Db } from "../db/db.ts";
import { fakeEndpoints, fakeGitHubFetch } from "../github/fake.ts";
import type { RouteRequest } from "../http/router.ts";
import type { Reply } from "../http/router.ts";
import { freshDb } from "../store/test-db.ts";
import type { Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { Readable } from "node:stream";

/** Test-only: demo-mode dependencies over a fresh database, with a fixed clock and ids. */
export async function testDeps(overrides: Partial<Deps> = {}): Promise<Deps & { db: Db }> {
  const config = loadConfig({ REPOWIKI_MODE: "demo" });
  const github = fakeEndpoints(config.origin);
  let n = 0;
  const deps: Deps & { db: Db } = {
    config,
    db: await freshDb(),
    fetch: fakeGitHubFetch(github),
    github,
    now: () => "2026-10-14T12:00:00.000Z",
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    ...overrides,
  } as Deps & { db: Db };
  return deps;
}

/** Test-only: one request to `app` without a socket. */
export async function call(
  app: App,
  init: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  const url = new URL(init.path, "http://127.0.0.1");
  const raw = Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]) as never;
  Object.assign(raw, { headers: { ...init.headers }, method: init.method ?? "GET" });
  const request: RouteRequest = {
    method: (init.method ?? "GET") as RouteRequest["method"],
    path: url.pathname,
    params: {},
    query: url.searchParams,
    headers: Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    raw,
  };
  return app(request);
}

/** The cookie a reply sets for `name`, or undefined. */
export function setCookie(reply: Reply, name: string): string | undefined {
  const value = reply.headers?.["set-cookie"];
  const all = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const found = all.find((c) => c.startsWith(`${name}=`));
  return found?.slice(name.length + 1).split(";")[0];
}
```

`packages/server/src/routes/auth.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { FAKE_USER } from "../github/fake.ts";
import type { App } from "../http/server.ts";
import { readGitHubToken } from "../store/github-tokens.ts";
import { authRoutes } from "./auth.ts";
import { call, setCookie, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, authRoutes(deps));
});
afterEach(async () => deps.db.close());

async function signInFlow(): Promise<{ session: string }> {
  const start = await call(app, { path: "/auth/github" });
  const state = setCookie(start, "oauth_state") ?? "";
  const location = String(start.headers?.location);
  const authorize = new URL(location);
  expect(authorize.searchParams.get("state")).toBe(state);
  expect(authorize.searchParams.get("scope")).toBe("");
  const back = await call(app, {
    path: `/auth/github/callback?code=fake-code&state=${state}`,
    headers: { cookie: `oauth_state=${state}` },
  });
  expect(back.status).toBe(303);
  expect(back.headers?.location).toBe("/dashboard");
  return { session: setCookie(back, "session") ?? "" };
}

describe("GitHub sign-in (spec 2 S7, S18)", () => {
  it("redirects to GitHub with a state cookie and no scope", async () => {
    const start = await call(app, { path: "/auth/github" });
    expect(start.status).toBe(303);
    expect(String(start.headers?.location)).toMatch(
      /^http:\/\/127\.0\.0\.1:8787\/_fake\/github\/login\/oauth\/authorize\?/,
    );
    expect(setCookie(start, "oauth_state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("signs in, keeps the token encrypted, and starts a session", async () => {
    const { session } = await signInFlow();
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const accounts = await deps.db.query<{ github_user_id: string }>(
      "SELECT github_user_id FROM accounts",
    );
    expect(accounts.map((a) => Number(a.github_user_id))).toEqual([FAKE_USER.id]);
    const [{ id }] = (await deps.db.query<{ id: string }>("SELECT id FROM accounts")) as [
      { id: string },
    ];
    expect(await readGitHubToken(deps.db, deps.config.tokenKey, id)).toBe("fake-token");
  });

  it("refuses a callback whose state does not match the cookie, or has no cookie", async () => {
    const start = await call(app, { path: "/auth/github" });
    const state = setCookie(start, "oauth_state") ?? "";
    const wrong = await call(app, {
      path: "/auth/github/callback?code=fake-code&state=forged",
      headers: { cookie: `oauth_state=${state}` },
    });
    expect(wrong.status).toBe(400);
    const none = await call(app, { path: `/auth/github/callback?code=fake-code&state=${state}` });
    expect(none.status).toBe(400);
    expect(await deps.db.query("SELECT * FROM sessions")).toEqual([]);
  });

  it("refuses a code GitHub will not exchange", async () => {
    const start = await call(app, { path: "/auth/github" });
    const state = setCookie(start, "oauth_state") ?? "";
    const bad = await call(app, {
      path: `/auth/github/callback?code=nope&state=${state}`,
      headers: { cookie: `oauth_state=${state}` },
    });
    expect(bad.status).toBe(400);
  });

  it("turns away a new user the allowlist does not name, outside the demo", async () => {
    const strict = await testDeps({
      config: { ...deps.config, mode: "development", github: { kind: "oauth", clientId: "c", clientSecret: "s" } },
    });
    const strictApp = createApp(strict, authRoutes(strict));
    const start = await call(strictApp, { path: "/auth/github" });
    const state = setCookie(start, "oauth_state") ?? "";
    const back = await call(strictApp, {
      path: `/auth/github/callback?code=fake-code&state=${state}`,
      headers: { cookie: `oauth_state=${state}` },
    });
    expect(back.status).toBe(403);
    expect(String(back.body)).toContain("invite-only");
    await strict.db.close();
  });

  it("signs out with a valid CSRF token and clears the cookie", async () => {
    const { session } = await signInFlow();
    const [{ csrf }] = (await deps.db.query<{ csrf: string }>("SELECT csrf FROM sessions")) as [
      { csrf: string },
    ];
    const out = await call(app, {
      method: "POST",
      path: "/auth/signout",
      headers: {
        cookie: `session=${session}`,
        origin: deps.config.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=${csrf}`,
    });
    expect(out.status).toBe(303);
    expect(setCookie(out, "session")).toBe("");
    expect(await deps.db.query("SELECT * FROM sessions")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server`
Expected: FAIL — cannot resolve `./layout.ts`, `../app.ts`, `../github/fake.ts`, `./auth.ts`.

- [ ] **Step 4: Write the implementation**

`packages/server/src/github/endpoints.ts`:

```ts
/** Where GitHub's web (OAuth) and API hosts are; the fake GitHub lives under our own origin. */
export interface GitHubEndpoints {
  web: string;
  api: string;
}

export const GITHUB: GitHubEndpoints = { web: "https://github.com", api: "https://api.github.com" };

export function fakeEndpoints(origin: string): GitHubEndpoints {
  return { web: `${origin}/_fake/github`, api: `${origin}/_fake/github/api` };
}
```

`packages/server/src/github/oauth.ts`:

```ts
import { z } from "zod";
import type { GitHubEndpoints } from "./endpoints.ts";

/** GitHub's authorize page, asking for no scope at all (spec 2 S7). */
export function authorizeUrl(
  endpoints: GitHubEndpoints,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: "",
    allow_signup: "true",
  });
  return `${endpoints.web}/login/oauth/authorize?${query}`;
}

const TokenReply = z.object({ access_token: z.string().min(1) });

/** The access token for an OAuth code, or null when GitHub refuses it. */
export async function exchangeCode(
  fetchFn: typeof fetch,
  endpoints: GitHubEndpoints,
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<string | null> {
  const response = await fetchFn(`${endpoints.web}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const parsed = TokenReply.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.access_token : null;
}
```

`packages/server/src/github/fake.ts`:

```ts
import type { Route } from "../http/router.ts";
import { redirect } from "../http/server.ts";
import type { GitHubEndpoints } from "./endpoints.ts";

/** The demo's GitHub (spec 2 S18): one user, one public repository they own, 42 commits. */
export const FAKE_TOKEN = "fake-token";
export const FAKE_CODE = "fake-code";
export const FAKE_COMMITS = 42;

export const FAKE_USER = {
  id: 4242,
  login: "demo-dev",
  name: "Demo Developer",
  created_at: "2019-01-01T00:00:00Z",
};

export const FAKE_REPO = {
  id: 9090,
  name: "demo-repo",
  full_name: "demo-dev/demo-repo",
  owner: { login: "demo-dev" },
  private: false,
  fork: false,
  default_branch: "main",
  size: 120,
  description: "A small project the demo documents.",
  html_url: "https://github.com/demo-dev/demo-repo",
  clone_url: "https://github.com/demo-dev/demo-repo.git",
  permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
};

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

/** A `fetch` that answers the GitHub calls RepoWiki makes, for the demo and the tests. */
export function fakeGitHubFetch(endpoints: GitHubEndpoints): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const href = `${url.origin}${url.pathname}`;
    if (method === "POST" && href === `${endpoints.web}/login/oauth/access_token`) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      return body.get("code") === FAKE_CODE
        ? json({ access_token: FAKE_TOKEN, token_type: "bearer", scope: "" })
        : json({ error: "bad_verification_code" });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (!href.startsWith(endpoints.api)) return new Response("not found", { status: 404 });
    if (auth !== `Bearer ${FAKE_TOKEN}`) return json({ message: "Bad credentials" }, { status: 401 });
    const path = href.slice(endpoints.api.length);
    if (path === "/user") return json(FAKE_USER);
    if (path === "/user/repos") return json(url.searchParams.get("page") === "2" ? [] : [FAKE_REPO]);
    if (path === `/repositories/${FAKE_REPO.id}`) return json(FAKE_REPO);
    if (path === `/repos/${FAKE_REPO.full_name}/commits`) {
      const author = url.searchParams.get("author");
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      if (author?.toLowerCase() !== FAKE_USER.login) return json([]);
      const shown = Math.min(perPage, FAKE_COMMITS);
      const commits = Array.from({ length: shown }, (_, i) => ({
        sha: (i + 1).toString(16).padStart(40, "0"),
      }));
      const last = Math.ceil(FAKE_COMMITS / perPage);
      const link =
        last > 1
          ? `<${endpoints.api}${path}?author=${author}&per_page=${perPage}&page=2>; rel="next", <${endpoints.api}${path}?author=${author}&per_page=${perPage}&page=${last}>; rel="last"`
          : "";
      return json(commits, { headers: link ? { link } : {} });
    }
    return json({ message: "Not Found" }, { status: 404 });
  };
}

/** The fake authorize page, which a browser visits: it approves at once. */
export function fakeAuthorizeRoute(): Route {
  return {
    method: "GET",
    pattern: "/_fake/github/login/oauth/authorize",
    handler: async (request) => {
      const back = new URL(request.query.get("redirect_uri") ?? "/");
      back.searchParams.set("code", FAKE_CODE);
      back.searchParams.set("state", request.query.get("state") ?? "");
      return redirect(back.href, 302);
    },
  };
}
```

`packages/server/src/pages/layout.ts`:

```ts
/** Escape text for HTML element content and double- or single-quoted attributes. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f23;--muted:#57606a;--line:#d0d7de;--accent:#0b5cad}@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--accent:#58a6ff}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}header{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.75rem 1rem;border-bottom:1px solid var(--line)}header a{color:var(--fg);font-weight:600;text-decoration:none}main{max-width:56rem;margin:0 auto;padding:1.5rem 1rem 4rem}a{color:var(--accent)}h1{font-size:1.75rem;line-height:1.2}.muted{color:var(--muted)}.card{border:1px solid var(--line);border-radius:8px;padding:1rem;margin:1rem 0}label{display:block;font-weight:600;margin:1rem 0 .25rem}input:not([type=checkbox]),textarea,select{width:100%;font:inherit;padding:.5rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}textarea{min-height:6rem}button{font:inherit;font-weight:600;padding:.5rem 1rem;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}button.secondary{background:transparent;color:var(--accent)}form.inline{display:inline}.notice{border-left:4px solid var(--accent);padding:.5rem 1rem;margin:1rem 0}`;

export interface PageSession {
  csrf: string;
  login: string;
}

/** A full page in the app's layout; `body` must already be escaped HTML. */
export function page(input: { title: string; body: string; session: PageSession | null }): string {
  const nav =
    input.session === null
      ? `<a href="/auth/github">Sign in with GitHub</a>`
      : `<span><a href="/dashboard">${escapeHtml(input.session.login)}</a> <form class="inline" method="post" action="/auth/signout"><input type="hidden" name="csrf" value="${escapeHtml(input.session.csrf)}"><button class="secondary">Sign out</button></form></span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title)} · RepoWiki</title><style>${STYLE}</style></head><body><header><a href="/">RepoWiki</a>${nav}</header><main>${input.body}</main></body></html>`;
}
```

The style sheet is inline, so pages answer with a CSP that allows it: `style-src 'self' 'unsafe-inline'` (no script is inline). `createApp` sets that on HTML replies.

`packages/server/src/app.ts`:

```ts
import type { Config } from "./config.ts";
import type { Db } from "./db/db.ts";
import type { GitHubEndpoints } from "./github/endpoints.ts";
import { fakeAuthorizeRoute } from "./github/fake.ts";
import { createRouter, type Route } from "./http/router.ts";
import { type App, html, text } from "./http/server.ts";
import { escapeHtml, page } from "./pages/layout.ts";

/** Everything a route needs from outside (spec 2 §4); tests pass fakes. */
export interface Deps {
  config: Config;
  db: Db;
  /** Every call to GitHub goes through this `fetch` (the fake in the demo and in tests). */
  fetch: typeof fetch;
  github: GitHubEndpoints;
  now: () => string;
  newId: () => string;
}

const PAGE_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** The routes, plus the fake GitHub's authorize page in fake mode, behind one dispatcher. */
export function createApp(deps: Deps, routes: readonly Route[]): App {
  const all = [...(deps.config.github.kind === "fake" ? [fakeAuthorizeRoute()] : []), ...routes];
  const route = createRouter(all);
  return async (request) => {
    const found = route(request.method, request.path);
    if ("status" in found) {
      return found.status === 405
        ? text(405, "Method not allowed.")
        : html(404, page({ title: "Not found", body: `<h1>Not found</h1><p class="muted">${escapeHtml(request.path)} is not a page on RepoWiki.</p>`, session: null }), { "content-security-policy": PAGE_CSP });
    }
    const reply = await found.handler({ ...request, params: found.params });
    const type = String(reply.headers?.["content-type"] ?? "");
    return type.startsWith("text/html") && reply.headers?.["content-security-policy"] === undefined
      ? { ...reply, headers: { ...reply.headers, "content-security-policy": PAGE_CSP } }
      : reply;
  };
}
```

`packages/server/src/routes/auth.ts`:

```ts
import type { Deps } from "../app.ts";
import { randomToken, safeEqual } from "../crypto.ts";
import { authorizeUrl, exchangeCode } from "../github/oauth.ts";
import { readForm } from "../http/body.ts";
import { parseCookies, serializeCookie } from "../http/cookies.ts";
import type { Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { checkMutation, currentSession, secureCookies, sessionSetCookie } from "../http/session.ts";
import { page } from "../pages/layout.ts";
import { signIn } from "../store/accounts.ts";
import { saveGitHubToken } from "../store/github-tokens.ts";
import { createSession, endSession, SESSION_DAYS } from "../store/sessions.ts";
import { z } from "zod";

const STATE_COOKIE = "oauth_state";
const STATE_SECONDS = 600;

const GitHubUser = z.object({
  id: z.int().positive(),
  login: z.string().min(1).max(39),
  name: z.string().nullable(),
  created_at: z.string(),
});

const oauthClient = (deps: Deps) =>
  deps.config.github.kind === "oauth"
    ? deps.config.github
    : { clientId: "fake-client", clientSecret: "fake-secret" };

const failure = (status: number, title: string, message: string) =>
  html(status, page({ title, body: `<h1>${title}</h1><p>${message}</p><p><a href="/">Back to RepoWiki</a></p>`, session: null }));

/** Sign-in with GitHub and sign-out (spec 2 S6, S7). */
export function authRoutes(deps: Deps): Route[] {
  const redirectUri = `${deps.config.origin}/auth/github/callback`;
  const secure = secureCookies(deps.config);
  const stateCookie = (value: string, maxAgeSeconds: number) =>
    serializeCookie(STATE_COOKIE, value, { maxAgeSeconds, secure, httpOnly: true });

  return [
    {
      method: "GET",
      pattern: "/auth/github",
      handler: async () => {
        const state = randomToken();
        const { clientId } = oauthClient(deps);
        return {
          ...redirect(authorizeUrl(deps.github, clientId, redirectUri, state)),
          headers: {
            location: authorizeUrl(deps.github, clientId, redirectUri, state),
            "set-cookie": stateCookie(state, STATE_SECONDS),
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/auth/github/callback",
      handler: async (request) => {
        const expected = parseCookies(String(request.headers.cookie ?? "")).get(STATE_COOKIE);
        const state = request.query.get("state");
        const code = request.query.get("code");
        if (!expected || !state || !code || !safeEqual(state, expected)) {
          return failure(400, "Sign-in failed", "The sign-in link expired or was not started here. Try again.");
        }
        const { clientId, clientSecret } = oauthClient(deps);
        const token = await exchangeCode(deps.fetch, deps.github, { clientId, clientSecret, code, redirectUri });
        if (token === null) return failure(400, "Sign-in failed", "GitHub did not confirm the sign-in. Try again.");
        const response = await deps.fetch(`${deps.github.api}/user`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "RepoWiki" },
          signal: AbortSignal.timeout(10_000),
        });
        const user = GitHubUser.safeParse(response.ok ? await response.json() : null);
        if (!user.success) return failure(502, "Sign-in failed", "GitHub did not return your profile. Try again.");
        const allowlist = new Set(deps.config.signupAllowlist);
        const signedIn = await signIn(
          deps.db,
          {
            githubUserId: user.data.id,
            login: user.data.login,
            displayName: user.data.name?.trim() || user.data.login,
            githubCreatedAt: new Date(user.data.created_at).toISOString(),
          },
          {
            newAccountId: deps.newId(),
            allowNew: (login) => deps.config.mode === "demo" || allowlist.has(login),
            now: deps.now(),
          },
        );
        if (signedIn === null) {
          return failure(403, "Not yet", "RepoWiki is invite-only for now. Ask for an invitation and sign in again once you have one.");
        }
        await deps.db.transaction((tx) => saveGitHubToken(tx, deps.config.tokenKey, signedIn.account.id, token));
        const session = await createSession(deps.db, signedIn.account.id, deps.now());
        return {
          status: 303,
          headers: {
            location: "/dashboard",
            "set-cookie": [sessionSetCookie(deps.config, session.token, SESSION_DAYS * 86_400), stateCookie("", 0)],
          },
        };
      },
    },
    {
      method: "POST",
      pattern: "/auth/signout",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request.headers, deps.now());
        const form = await readForm(request.raw);
        checkMutation(deps.config, request.headers, session, form.get("csrf"));
        await endSession(deps.db, session.token);
        return { status: 303, headers: { location: "/", "set-cookie": sessionSetCookie(deps.config, "", 0) } };
      },
    },
  ];
}
```

Add to `packages/server/src/index.ts`:

```ts
export { createApp, type Deps } from "./app.ts";
export { fakeEndpoints, GITHUB, type GitHubEndpoints } from "./github/endpoints.ts";
export { FAKE_REPO, FAKE_TOKEN, FAKE_USER, fakeAuthorizeRoute, fakeGitHubFetch } from "./github/fake.ts";
export { authorizeUrl, exchangeCode } from "./github/oauth.ts";
export { escapeHtml, page, type PageSession } from "./pages/layout.ts";
export { authRoutes } from "./routes/auth.ts";
```

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server
pnpm check
git add packages/server
git -c user.email=sean.may101@gmail.com commit -m "feat(server): sign in with GitHub, or the demo's fake GitHub"
```

Expected: PASS, then a green check.

---

### Task 3: The GitHub API client and eligibility facts

**Files:**
- Create: `packages/server/src/github/api.ts`, `packages/server/src/github/api.test.ts`
- Create: `packages/server/src/github/facts.ts`, `packages/server/src/github/facts.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: `GitHubEndpoints`, `fakeGitHubFetch`, `FAKE_*` (Task 2); `EligibilityFacts`, `Permission` from `@repowiki/hosted`.
- Produces: `GitHubRepo` (schema and type), `GitHubError`, `TokenRevoked`, `GitHubApi` (`user(token)`, `publicRepos(token)`, `repository(token, id)`, `countCommits(token, fullName, login)`, `commitShas(token, fullName, login, max)`), `githubApi(fetch, endpoints)`, `lastPage(link)`; `permissionOf(repo)`, `eligibilityFacts(api, token, { githubUserId, login, githubRepoId, now, indexedFiles })` → `{ facts, repo }`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-github
```

- [ ] **Step 2: Write the failing tests**

`packages/server/src/github/api.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GitHubError, githubApi, lastPage, TokenRevoked } from "./api.ts";
import { fakeEndpoints } from "./endpoints.ts";
import { FAKE_COMMITS, FAKE_REPO, FAKE_TOKEN, FAKE_USER, fakeGitHubFetch } from "./fake.ts";

const endpoints = fakeEndpoints("http://127.0.0.1:8787");
const api = githubApi(fakeGitHubFetch(endpoints), endpoints);

describe("the GitHub API client (spec 2 S8)", () => {
  it("reads the user and a repository", async () => {
    expect(await api.user(FAKE_TOKEN)).toMatchObject({ id: FAKE_USER.id, login: FAKE_USER.login });
    expect(await api.repository(FAKE_TOKEN, FAKE_REPO.id)).toMatchObject({
      id: FAKE_REPO.id,
      full_name: FAKE_REPO.full_name,
      permissions: { push: true },
    });
    expect(await api.repository(FAKE_TOKEN, 1)).toBeNull();
  });

  it("counts commits from the Link header and caps at 1000", async () => {
    expect(await api.countCommits(FAKE_TOKEN, FAKE_REPO.full_name, FAKE_USER.login)).toBe(FAKE_COMMITS);
    expect(await api.countCommits(FAKE_TOKEN, FAKE_REPO.full_name, "someone-else")).toBe(0);
    expect(lastPage('<https://x?page=2>; rel="next", <https://x?per_page=1&page=5000>; rel="last"')).toBe(5000);
    expect(lastPage(null)).toBeNull();
  });

  it("lists commit shas up to the asked number", async () => {
    const shas = await api.commitShas(FAKE_TOKEN, FAKE_REPO.full_name, FAKE_USER.login, 10);
    expect(shas).toHaveLength(10);
    expect(shas[0]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("raises TokenRevoked on a 401 and GitHubError on anything else unexpected", async () => {
    await expect(api.user("revoked")).rejects.toBeInstanceOf(TokenRevoked);
    const broken = githubApi(async () => new Response("oops", { status: 500 }), endpoints);
    await expect(broken.user(FAKE_TOKEN)).rejects.toBeInstanceOf(GitHubError);
    const garbage = githubApi(async () => Response.json({ id: "nope" }), endpoints);
    await expect(garbage.user(FAKE_TOKEN)).rejects.toBeInstanceOf(GitHubError);
  });

  it("lists every page of repositories and keeps only public ones", async () => {
    const pages: Record<string, unknown[]> = {
      "1": Array.from({ length: 100 }, (_, i) => ({ ...FAKE_REPO, id: i + 1, private: i % 2 === 1 })),
      "2": [{ ...FAKE_REPO, id: 500 }],
      "3": [],
    };
    const paged = githubApi(async (input) => {
      const url = new URL(String(input));
      return Response.json(pages[url.searchParams.get("page") ?? "1"] ?? []);
    }, endpoints);
    const repos = await paged.publicRepos(FAKE_TOKEN);
    expect(repos).toHaveLength(51);
    expect(repos.every((r) => !r.private)).toBe(true);
    expect(repos.at(-1)?.id).toBe(500);
  });
});
```

`packages/server/src/github/facts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type GitHubRepo, githubApi } from "./api.ts";
import { fakeEndpoints } from "./endpoints.ts";
import { eligibilityFacts, permissionOf } from "./facts.ts";
import { FAKE_REPO, FAKE_TOKEN, FAKE_USER, fakeGitHubFetch } from "./fake.ts";

const endpoints = fakeEndpoints("http://127.0.0.1:8787");
const api = githubApi(fakeGitHubFetch(endpoints), endpoints);
const NOW = "2026-10-14T12:00:00.000Z";
const input = {
  githubUserId: FAKE_USER.id,
  login: FAKE_USER.login,
  githubRepoId: FAKE_REPO.id,
  now: NOW,
  indexedFiles: null,
};

describe("eligibility facts (spec 2 S8, Contract §7.2)", () => {
  it("come from the repository and the commit count", async () => {
    const { facts, repo } = await eligibilityFacts(api, FAKE_TOKEN, input);
    expect(repo?.id).toBe(FAKE_REPO.id);
    expect(facts).toEqual({
      checkedAt: NOW,
      githubUserId: FAKE_USER.id,
      githubRepoId: FAKE_REPO.id,
      fullName: FAKE_REPO.full_name,
      visibility: "public",
      isFork: false,
      permission: "admin",
      authoredCommits: 42,
      indexedFiles: null,
      tokenValid: true,
    });
  });

  it("report a revoked token, and a repository GitHub hides, as ineligible", async () => {
    expect((await eligibilityFacts(api, "revoked", input)).facts).toMatchObject({
      tokenValid: false,
      visibility: "private",
      authoredCommits: 0,
    });
    const gone = await eligibilityFacts(api, FAKE_TOKEN, { ...input, githubRepoId: 1 });
    expect(gone.repo).toBeNull();
    expect(gone.facts).toMatchObject({ tokenValid: true, visibility: "private", permission: "none" });
  });

  it("read the strongest permission GitHub reports, or none", () => {
    const repo = (permissions?: GitHubRepo["permissions"]) => ({ ...FAKE_REPO, permissions }) as GitHubRepo;
    expect(permissionOf(repo({ admin: false, maintain: true, push: true, triage: true, pull: true }))).toBe("maintain");
    expect(permissionOf(repo({ admin: false, push: true, pull: true }))).toBe("push");
    expect(permissionOf(repo({ admin: false, push: false, pull: true }))).toBe("pull");
    expect(permissionOf(repo(undefined))).toBe("none");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server/src/github`
Expected: FAIL — cannot resolve `./api.ts`, `./facts.ts`.

- [ ] **Step 4: Write the implementation**

`packages/server/src/github/api.ts`:

```ts
import { z } from "zod";
import type { GitHubEndpoints } from "./endpoints.ts";

export class GitHubError extends Error {}
/** GitHub answered 401: the user revoked RepoWiki or the token expired. */
export class TokenRevoked extends Error {}

export const GitHubUser = z.object({
  id: z.int().positive(),
  login: z.string().min(1).max(39),
  name: z.string().nullable(),
  created_at: z.string(),
});
export type GitHubUser = z.infer<typeof GitHubUser>;

export const GitHubRepo = z.object({
  id: z.int().positive(),
  name: z.string().min(1),
  full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  owner: z.object({ login: z.string().min(1) }),
  private: z.boolean(),
  fork: z.boolean(),
  default_branch: z.string().min(1),
  size: z.number().nonnegative(),
  description: z.string().nullable(),
  html_url: z.string(),
  clone_url: z.string(),
  permissions: z
    .object({
      admin: z.boolean(),
      maintain: z.boolean().optional(),
      push: z.boolean(),
      triage: z.boolean().optional(),
      pull: z.boolean(),
    })
    .optional(),
});
export type GitHubRepo = z.infer<typeof GitHubRepo>;

const Commits = z.array(z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }));
const MAX_COUNT = 1000;
const MAX_REPO_PAGES = 10;

/** The `page` of a Link header's rel="last" URL. */
export function lastPage(link: string | null): number | null {
  if (link === null) return null;
  const last = link.split(",").find((part) => /rel="last"/.test(part));
  const url = last?.match(/<([^>]+)>/)?.[1];
  if (url === undefined) return null;
  const page = Number(new URL(url).searchParams.get("page"));
  return Number.isInteger(page) && page > 0 ? page : null;
}

export interface GitHubApi {
  user(token: string): Promise<GitHubUser>;
  publicRepos(token: string): Promise<GitHubRepo[]>;
  repository(token: string, id: number): Promise<GitHubRepo | null>;
  countCommits(token: string, fullName: string, login: string): Promise<number>;
  commitShas(token: string, fullName: string, login: string, max: number): Promise<string[]>;
}

/** GitHub's REST API as the signed-in user, through `fetchFn` (spec 2 S8). */
export function githubApi(fetchFn: typeof fetch, endpoints: GitHubEndpoints): GitHubApi {
  async function get(token: string, path: string): Promise<Response | null> {
    const response = await fetchFn(`${endpoints.api}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "RepoWiki",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) throw new TokenRevoked("GitHub refused the token");
    if (response.status === 404) return null;
    if (!response.ok) throw new GitHubError(`GitHub answered ${response.status} for ${path.split("?")[0]}`);
    return response;
  }

  async function parse<T>(response: Response | null, schema: z.ZodType<T>, what: string): Promise<T | null> {
    if (response === null) return null;
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new GitHubError(`GitHub sent an unexpected ${what}`);
    return parsed.data;
  }

  const commitsPath = (fullName: string, login: string, perPage: number) =>
    `/repos/${fullName}/commits?author=${encodeURIComponent(login)}&per_page=${perPage}`;

  return {
    async user(token) {
      const user = await parse(await get(token, "/user"), GitHubUser, "user");
      if (user === null) throw new GitHubError("GitHub has no user for this token");
      return user;
    },
    async publicRepos(token) {
      const all: GitHubRepo[] = [];
      for (let page = 1; page <= MAX_REPO_PAGES; page++) {
        const batch = await parse(
          await get(token, `/user/repos?type=all&sort=pushed&per_page=100&page=${page}`),
          z.array(GitHubRepo),
          "repository list",
        );
        if (batch === null || batch.length === 0) break;
        all.push(...batch.filter((repo) => !repo.private));
        if (batch.length < 100) break;
      }
      return all;
    },
    async repository(token, id) {
      return parse(await get(token, `/repositories/${id}`), GitHubRepo, "repository");
    },
    async countCommits(token, fullName, login) {
      const response = await get(token, commitsPath(fullName, login, 1));
      if (response === null) return 0;
      const pages = lastPage(response.headers.get("link"));
      const first = await parse(response, Commits, "commit list");
      return Math.min(pages ?? first?.length ?? 0, MAX_COUNT);
    },
    async commitShas(token, fullName, login, max) {
      const perPage = Math.min(Math.max(max, 1), 100);
      const commits = await parse(await get(token, commitsPath(fullName, login, perPage)), Commits, "commit list");
      return (commits ?? []).slice(0, max).map((c) => c.sha);
    },
  };
}
```

`packages/server/src/github/facts.ts`:

```ts
import type { EligibilityFacts, Permission } from "@repowiki/hosted";
import { type GitHubApi, type GitHubRepo, TokenRevoked } from "./api.ts";

/** The strongest permission GitHub reports for the signed-in user (spec 2 S8). */
export function permissionOf(repo: GitHubRepo): Permission {
  const p = repo.permissions;
  if (p === undefined) return "none";
  if (p.admin) return "admin";
  if (p.maintain) return "maintain";
  if (p.push) return "push";
  if (p.triage) return "triage";
  if (p.pull) return "pull";
  return "none";
}

export interface FactsInput {
  githubUserId: number;
  login: string;
  githubRepoId: number;
  now: string;
  indexedFiles: number | null;
}

/** What GitHub says right now about this user and repository (Contract §7.2). */
export async function eligibilityFacts(
  api: GitHubApi,
  token: string,
  input: FactsInput,
): Promise<{ facts: EligibilityFacts; repo: GitHubRepo | null }> {
  const base = {
    checkedAt: input.now,
    githubUserId: input.githubUserId,
    githubRepoId: input.githubRepoId,
    indexedFiles: input.indexedFiles,
  };
  const unavailable = (tokenValid: boolean): EligibilityFacts => ({
    ...base,
    fullName: "unknown/unknown",
    visibility: "private",
    isFork: false,
    permission: "none",
    authoredCommits: 0,
    tokenValid,
  });
  try {
    const repo = await api.repository(token, input.githubRepoId);
    if (repo === null) return { facts: unavailable(true), repo: null };
    const authoredCommits = await api.countCommits(token, repo.full_name, input.login);
    return {
      facts: {
        ...base,
        fullName: repo.full_name,
        visibility: repo.private ? "private" : "public",
        isFork: repo.fork,
        permission: permissionOf(repo),
        authoredCommits,
        tokenValid: true,
      },
      repo,
    };
  } catch (error) {
    if (error instanceof TokenRevoked) return { facts: unavailable(false), repo: null };
    throw error;
  }
}
```

Add to `packages/server/src/index.ts`:

```ts
export {
  GitHubError,
  type GitHubApi,
  GitHubRepo,
  GitHubUser,
  githubApi,
  lastPage,
  TokenRevoked,
} from "./github/api.ts";
export { eligibilityFacts, type FactsInput, permissionOf } from "./github/facts.ts";
```

Also replace the inline `GitHubUser` schema and `fetch` in `routes/auth.ts` with `githubApi(deps.fetch, deps.github).user(token)` (catching `GitHubError`/`TokenRevoked` as the 502 failure).

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server
pnpm check
git add packages/server
git -c user.email=sean.may101@gmail.com commit -m "feat(server): read eligibility facts from GitHub as the signed-in user"
```

---

### Task 4: Object storage (filesystem and S3 SigV4)

**Files:**
- Create: `packages/server/src/objects/store.ts`, `packages/server/src/objects/fs-store.ts`, `packages/server/src/objects/sigv4.ts`, `packages/server/src/objects/s3-store.ts`
- Create: `packages/server/src/objects/objects.test.ts`, `packages/server/src/objects/sigv4.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces: `ObjectStore` (`put(key, body, contentType)`, `get(key)` → `{ body: Uint8Array; contentType: string } | null`, `list(prefix)` → `string[]` sorted, `delete(keys)`), `assertKey(key)`, `contentTypeFor(key)`, `copyPrefix(store, from, to)`, `fsObjectStore(root)`, `signV4(input)`, `s3ObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey, fetch, now })`, `objectStoreFor(config.objects, fetch)`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-objects
```

- [ ] **Step 2: Write the failing tests**

`packages/server/src/objects/sigv4.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signV4 } from "./sigv4.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const creds = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "auto",
  service: "s3",
  amzDate: "20261014T120000Z",
};
const sign = (method: string, path: string, body = "", extra: Record<string, string> = {}) =>
  signV4({
    ...creds,
    method,
    url: new URL(`https://acct.r2.cloudflarestorage.com${path}`),
    headers: { "x-amz-content-sha256": sha(body), "x-amz-date": creds.amzDate, ...extra },
  });

/** Expected values from the independent `aws4` library (scratch run, 2026-10-14). */
describe("SigV4 (spec 2 S12)", () => {
  const prefix =
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261014/auto/s3/aws4_request, SignedHeaders=";

  it("signs a GET", () => {
    expect(sign("GET", "/repowiki/sites/a/v1/index.html")).toBe(
      `${prefix}host;x-amz-content-sha256;x-amz-date, Signature=7156e101d48a00c951b38c25c5bd6037dbdcb5dd5dd3137d8643c2348f201c4b`,
    );
  });

  it("signs a PUT with its content type and length", () => {
    expect(
      sign("PUT", "/repowiki/exports/x.json", "hello", {
        "content-type": "application/json",
        "content-length": "5",
      }),
    ).toBe(
      `${prefix}content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=d1304fa89a19d1f92c57e0f1850309aade098e5f3bad0146243347aba4c14e4e`,
    );
  });

  it("signs a list with a query and a delete with an encoded key", () => {
    expect(sign("GET", "/repowiki?list-type=2&prefix=sites%2Fa%2F")).toBe(
      `${prefix}host;x-amz-content-sha256;x-amz-date, Signature=607662d1f3c643454dd638cad9e5d49483b29a98d3fd9277040cde3d8361a0b3`,
    );
    expect(sign("DELETE", "/repowiki/sites/a/v1/a%20b.html")).toBe(
      `${prefix}host;x-amz-content-sha256;x-amz-date, Signature=fbde1558d9653320f70506eab46eb16f5fe7bae0f37a95c0bafc7de80fb00fd1`,
    );
  });
});
```

`packages/server/src/objects/objects.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fsObjectStore } from "./fs-store.ts";
import { s3ObjectStore } from "./s3-store.ts";
import { assertKey, contentTypeFor, copyPrefix, type ObjectStore } from "./store.ts";

let root: string;
let store: ObjectStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "objects-"));
  store = fsObjectStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("object keys (spec 2 S12)", () => {
  it("refuse traversal, absolute paths, backslashes and empties", () => {
    for (const bad of ["", "/a", "a/../b", "..", "a\\b", "a//b", "a/./b", `a${"x".repeat(600)}`]) {
      expect(() => assertKey(bad), bad).toThrow();
    }
    expect(() => assertKey("sites/p/v1/wiki/index.html")).not.toThrow();
  });

  it("map extensions to content types", () => {
    expect(contentTypeFor("a/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("a/x.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("a/x.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("a/export.json")).toBe("application/json");
    expect(contentTypeFor("a/x.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("a/x.pf_index")).toBe("application/octet-stream");
  });
});

describe("the filesystem store (spec 2 S12)", () => {
  it("puts, gets, lists and deletes", async () => {
    await store.put("sites/p/v1/index.html", "<h1>x</h1>", "text/html; charset=utf-8");
    await store.put("sites/p/v1/wiki/a.html", "a", "text/html; charset=utf-8");
    await store.put("sites/q/v1/index.html", "q", "text/html; charset=utf-8");
    const got = await store.get("sites/p/v1/index.html");
    expect(Buffer.from(got?.body ?? []).toString()).toBe("<h1>x</h1>");
    expect(got?.contentType).toBe("text/html; charset=utf-8");
    expect(await store.get("sites/p/v1/missing.html")).toBeNull();
    expect(await store.list("sites/p/")).toEqual(["sites/p/v1/index.html", "sites/p/v1/wiki/a.html"]);
    await store.delete(["sites/p/v1/index.html"]);
    expect(await store.list("sites/p/")).toEqual(["sites/p/v1/wiki/a.html"]);
  });

  it("copies a prefix", async () => {
    await store.put("previews/p/r1/index.html", "x", "text/html; charset=utf-8");
    await store.put("previews/p/r1/wiki/a.html", "a", "text/html; charset=utf-8");
    expect(await copyPrefix(store, "previews/p/r1/", "sites/p/v1/")).toBe(2);
    expect(await store.list("sites/p/v1/")).toEqual(["sites/p/v1/index.html", "sites/p/v1/wiki/a.html"]);
  });
});

describe("the S3 store (spec 2 S12)", () => {
  const calls: { method: string; url: string; headers: Headers; body: string }[] = [];
  const objects = new Map<string, string>();
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? "" : Buffer.from(init.body as Uint8Array).toString();
    calls.push({ method: init?.method ?? "GET", url: url.href, headers, body });
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\/?/, ""));
    if (init?.method === "PUT") {
      objects.set(key, body);
      return new Response(null, { status: 200 });
    }
    if (init?.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const token = url.searchParams.get("continuation-token");
      const page = token === null ? keys.slice(0, 1) : keys.slice(1);
      const more = token === null && keys.length > 1;
      return new Response(
        `<?xml version="1.0"?><ListBucketResult>${page.map((k) => `<Contents><Key>${k.replaceAll("&", "&amp;")}</Key></Contents>`).join("")}<IsTruncated>${more}</IsTruncated>${more ? "<NextContinuationToken>t1</NextContinuationToken>" : ""}</ListBucketResult>`,
      );
    }
    const found = objects.get(key);
    return found === undefined
      ? new Response("<Error/>", { status: 404 })
      : new Response(found, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  const s3 = s3ObjectStore({
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "bucket",
    accessKeyId: "id",
    secretAccessKey: "secret",
    fetch: fake,
    now: () => new Date("2026-10-14T12:00:00Z"),
  });

  it("signs every request and round-trips objects", async () => {
    await s3.put("sites/p/v1/a b&c.html", "hi", "text/html; charset=utf-8");
    expect(calls[0]?.url).toBe("https://acct.r2.cloudflarestorage.com/bucket/sites/p/v1/a%20b%26c.html");
    expect(calls[0]?.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=id\/20261014\/auto\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(calls[0]?.headers.get("x-amz-date")).toBe("20261014T120000Z");
    const got = await s3.get("sites/p/v1/a b&c.html");
    expect(Buffer.from(got?.body ?? []).toString()).toBe("hi");
    expect(await s3.get("sites/p/v1/none.html")).toBeNull();
  });

  it("lists across continuation pages and deletes", async () => {
    await s3.put("sites/q/1.html", "1", "text/html; charset=utf-8");
    await s3.put("sites/q/2.html", "2", "text/html; charset=utf-8");
    expect(await s3.list("sites/q/")).toEqual(["sites/q/1.html", "sites/q/2.html"]);
    await s3.delete(["sites/q/1.html"]);
    expect(await s3.list("sites/q/")).toEqual(["sites/q/2.html"]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server/src/objects`
Expected: FAIL — cannot resolve the store modules.

- [ ] **Step 4: Write the implementation**

`packages/server/src/objects/store.ts`:

```ts
/** Where exports, previews and published sites live (spec 2 S12). */
export interface ObjectStore {
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  /** Every key under `prefix`, sorted. */
  list(prefix: string): Promise<string[]>;
  delete(keys: readonly string[]): Promise<void>;
}

const KEY = /^[A-Za-z0-9._~@+=-]+(?:\/[A-Za-z0-9 ._~@+=&-]+)*$/;

/** Refuse a key that could escape its prefix or the store root. */
export function assertKey(key: string): void {
  const ok =
    key.length > 0 &&
    key.length <= 512 &&
    KEY.test(key) &&
    key.split("/").every((segment) => segment !== "." && segment !== "..");
  if (!ok) throw new Error("invalid object key");
}

const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  xml: "application/xml",
  wasm: "application/wasm",
};

export function contentTypeFor(key: string): string {
  const ext = key.split(".").at(-1)?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

/** Copy every object under `from` to the same relative key under `to`; returns how many. */
export async function copyPrefix(store: ObjectStore, from: string, to: string): Promise<number> {
  const keys = await store.list(from);
  for (const key of keys) {
    const object = await store.get(key);
    if (object === null) continue;
    await store.put(`${to}${key.slice(from.length)}`, object.body, object.contentType);
  }
  return keys.length;
}
```

`packages/server/src/objects/fs-store.ts`:

```ts
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { assertKey, contentTypeFor, type ObjectStore } from "./store.ts";

/** Objects as files under `root` (development, demo, tests). */
export function fsObjectStore(root: string): ObjectStore {
  const pathOf = (key: string) => {
    assertKey(key);
    return join(root, ...key.split("/"));
  };
  return {
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
    async get(key) {
      try {
        return { body: await readFile(pathOf(key)), contentType: contentTypeFor(key) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async list(prefix) {
      let entries: string[];
      try {
        entries = await readdir(root, { recursive: true, withFileTypes: false } as never);
      } catch {
        return [];
      }
      const keys: string[] = [];
      for (const entry of entries) {
        const key = relative(root, join(root, entry)).split(sep).join("/");
        if (!key.startsWith(prefix)) continue;
        if ((await this.get(key)) !== null) keys.push(key);
      }
      return keys.sort();
    },
    async delete(keys) {
      for (const key of keys) await rm(pathOf(key), { force: true });
    },
  };
}
```

`packages/server/src/objects/sigv4.ts`:

```ts
import { createHash, createHmac } from "node:crypto";

export interface SignInput {
  method: string;
  url: URL;
  /** Lowercase names; `x-amz-date` and `x-amz-content-sha256` must be among them. */
  headers: Readonly<Record<string, string>>;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  amzDate: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const hmac = (key: Buffer | string, text: string) => createHmac("sha256", key).update(text).digest();

/** RFC 3986 encoding, as SigV4 wants it. */
const encode = (text: string) =>
  encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The Authorization header for an S3 request (AWS Signature Version 4, unsigned-payload not used). */
export function signV4(input: SignInput): string {
  const path = input.url.pathname
    .split("/")
    .map((segment) => encode(decodeURIComponent(segment)))
    .join("/");
  const query = [...input.url.searchParams]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const headers = { ...input.headers, host: input.url.host };
  const names = Object.keys(headers).map((n) => n.toLowerCase()).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${String(headers[n as keyof typeof headers]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const payload = input.headers["x-amz-content-sha256"] ?? sha256("");
  const canonical = [input.method, path, query, canonicalHeaders, signedHeaders, payload].join("\n");
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
```

`packages/server/src/objects/s3-store.ts`:

```ts
import { createHash } from "node:crypto";
import { signV4 } from "./sigv4.ts";
import { assertKey, type ObjectStore } from "./store.ts";

export interface S3Options {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch: typeof fetch;
  now: () => Date;
  region?: string;
}

const amzDate = (at: Date) => at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const unescapeXml = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");

/** R2 (or any S3 API) with path-style URLs, signed by hand (spec 2 S12). */
export function s3ObjectStore(options: S3Options): ObjectStore {
  const region = options.region ?? "auto";
  const objectUrl = (key: string) =>
    new URL(`${options.endpoint}/${options.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);

  async function send(method: string, url: URL, body?: Uint8Array, contentType?: string) {
    const payload = createHash("sha256").update(body ?? new Uint8Array()).digest("hex");
    const date = amzDate(options.now());
    const headers: Record<string, string> = {
      "x-amz-content-sha256": payload,
      "x-amz-date": date,
      ...(body === undefined ? {} : { "content-length": String(body.length), "content-type": contentType ?? "application/octet-stream" }),
    };
    const authorization = signV4({
      method,
      url,
      headers,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region,
      service: "s3",
      amzDate: date,
    });
    return options.fetch(url, {
      method,
      headers: { ...headers, authorization },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(30_000),
    });
  }

  return {
    async put(key, body, contentType) {
      assertKey(key);
      const bytes = typeof body === "string" ? Buffer.from(body) : body;
      const response = await send("PUT", objectUrl(key), bytes, contentType);
      if (!response.ok) throw new Error(`object store PUT failed: ${response.status}`);
    },
    async get(key) {
      assertKey(key);
      const response = await send("GET", objectUrl(key));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`object store GET failed: ${response.status}`);
      return {
        body: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
      };
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | null = null;
      for (let page = 0; page < 1000; page++) {
        const url = new URL(`${options.endpoint}/${options.bucket}`);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (token !== null) url.searchParams.set("continuation-token", token);
        const response = await send("GET", url);
        if (!response.ok) throw new Error(`object store LIST failed: ${response.status}`);
        const xml = await response.text();
        for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unescapeXml(match[1] ?? ""));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? unescapeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "")
          : null;
        if (!token) break;
      }
      return keys.sort();
    },
    async delete(keys) {
      for (const key of keys) {
        assertKey(key);
        const response = await send("DELETE", objectUrl(key));
        if (!response.ok && response.status !== 404) throw new Error(`object store DELETE failed: ${response.status}`);
      }
    },
  };
}
```

Add `objectStoreFor` to `packages/server/src/objects/store.ts`'s neighbour `packages/server/src/objects/open.ts`:

```ts
import type { Config } from "../config.ts";
import { fsObjectStore } from "./fs-store.ts";
import { s3ObjectStore } from "./s3-store.ts";
import type { ObjectStore } from "./store.ts";

export function objectStoreFor(objects: Config["objects"], fetchFn: typeof fetch): ObjectStore {
  return objects.kind === "fs"
    ? fsObjectStore(objects.root)
    : s3ObjectStore({ ...objects, fetch: fetchFn, now: () => new Date() });
}
```

Add to `packages/server/src/index.ts`:

```ts
export { fsObjectStore } from "./objects/fs-store.ts";
export { objectStoreFor } from "./objects/open.ts";
export { type S3Options, s3ObjectStore } from "./objects/s3-store.ts";
export { type SignInput, signV4 } from "./objects/sigv4.ts";
export { assertKey, contentTypeFor, copyPrefix, type ObjectStore } from "./objects/store.ts";
```

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server
pnpm check
git add packages/server
git -c user.email=sean.may101@gmail.com commit -m "feat(server): store objects on disk or in R2 with hand-signed SigV4"
```
