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

const local = (location: unknown) => {
  const url = new URL(String(location));
  return `${url.pathname}${url.search}`;
};

/** The demo's whole browser round trip: RepoWiki → fake GitHub → callback. */
async function signInFlow(
  on = app,
): Promise<{ session: string; back: Awaited<ReturnType<typeof call>> }> {
  const start = await call(on, { path: "/auth/github" });
  const state = setCookie(start, "oauth_state") ?? "";
  expect(new URL(String(start.headers?.location)).searchParams.get("state")).toBe(state);
  const approve = await call(on, { path: local(start.headers?.location) });
  expect(approve.status).toBe(302);
  expect(String(approve.headers?.location)).toMatch(
    /^http:\/\/127\.0\.0\.1:8787\/auth\/github\/callback\?/,
  );
  const back = await call(on, {
    path: local(approve.headers?.location),
    headers: { cookie: `oauth_state=${encodeURIComponent(state)}` },
  });
  return { session: setCookie(back, "session") ?? "", back };
}

describe("GitHub sign-in (spec 2 S7, S18)", () => {
  it("redirects to GitHub with a signed, short-lived state cookie and no scope", async () => {
    const start = await call(app, { path: "/auth/github" });
    expect(start.status).toBe(303);
    const authorize = new URL(String(start.headers?.location));
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "http://127.0.0.1:8787/_fake/github/login/oauth/authorize",
    );
    expect(authorize.searchParams.get("scope")).toBe("");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8787/auth/github/callback",
    );
    expect(setCookie(start, "oauth_state")).toMatch(/^[A-Za-z0-9_-]{43}\.\d+\.[A-Za-z0-9_-]{43}$/);
    const cookie = [start.headers?.["set-cookie"]].flat().join();
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("HttpOnly");
  });

  it("signs in, keeps the token encrypted, and starts a session", async () => {
    const { session, back } = await signInFlow();
    expect(back.status).toBe(303);
    expect(back.headers?.location).toBe("/dashboard");
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie(back, "oauth_state")).toBe("");
    const accounts = await deps.db.query<{ id: string; github_user_id: string }>(
      "SELECT id, github_user_id FROM accounts",
    );
    expect(accounts.map((a) => Number(a.github_user_id))).toEqual([FAKE_USER.id]);
    const id = accounts[0]?.id ?? "";
    expect(await readGitHubToken(deps.db, deps.config.tokenKey, id)).toBe("fake-token");
  });

  it("refuses a state that does not match the cookie, or no cookie, or a forged or expired one", async () => {
    const start = await call(app, { path: "/auth/github" });
    const state = setCookie(start, "oauth_state") ?? "";
    const back = (query: string, cookie?: string) =>
      call(app, {
        path: `/auth/github/callback?code=fake-code&${query}`,
        headers:
          cookie === undefined ? {} : { cookie: `oauth_state=${encodeURIComponent(cookie)}` },
      });
    expect((await back("state=forged", state)).status).toBe(400);
    expect((await back(`state=${state}`)).status).toBe(400);
    const [nonce, expires] = state.split(".");
    const forged = `${nonce}.${Number(expires) + 3600}.${"A".repeat(43)}`;
    expect((await back(`state=${forged}`, forged)).status).toBe(400);
    const later = { ...deps, now: () => "2026-10-14T12:10:01.000Z" };
    const lateApp = createApp(later, authRoutes(later));
    const late = await call(lateApp, {
      path: `/auth/github/callback?code=fake-code&state=${state}`,
      headers: { cookie: `oauth_state=${encodeURIComponent(state)}` },
    });
    expect(late.status).toBe(400);
    expect(await deps.db.query("SELECT * FROM sessions")).toEqual([]);
  });

  it("refuses a code GitHub will not exchange", async () => {
    const start = await call(app, { path: "/auth/github" });
    const state = setCookie(start, "oauth_state") ?? "";
    const bad = await call(app, {
      path: `/auth/github/callback?code=nope&state=${state}`,
      headers: { cookie: `oauth_state=${encodeURIComponent(state)}` },
    });
    expect(bad.status).toBe(400);
    expect(await deps.db.query("SELECT * FROM accounts")).toEqual([]);
  });

  it("turns away a new user the allowlist does not name, outside the demo", async () => {
    const strict = { ...deps, config: { ...deps.config, mode: "development" as const } };
    const { back } = await signInFlow(createApp(strict, authRoutes(strict)));
    expect(back.status).toBe(403);
    expect(String(back.body)).toContain("invite-only");
    expect(await deps.db.query("SELECT * FROM github_tokens")).toEqual([]);
    const invited = {
      ...strict,
      config: { ...strict.config, signupAllowlist: [FAKE_USER.login] },
    };
    expect((await signInFlow(createApp(invited, authRoutes(invited)))).back.status).toBe(303);
  });

  it("keeps a GitHub name that is missing or too long from breaking sign-in or a later one", async () => {
    for (const name of [null, "   ", "x".repeat(300)]) {
      const odd: Deps = {
        ...deps,
        fetch: async (input, init) => {
          const reply = await deps.fetch(input, init);
          if (!String(input).endsWith("/user")) return reply;
          return Response.json({ ...(await reply.json()), name });
        },
      };
      expect((await signInFlow(createApp(odd, authRoutes(odd)))).back.status).toBe(303);
      const [row] = await deps.db.query<{ name: string }>(
        "SELECT body->>'displayName' AS name FROM accounts",
      );
      expect(row?.name).toBe(name?.trim() ? "x".repeat(120) : FAKE_USER.login);
    }
  });

  it("signs out with a valid CSRF token and clears the cookie", async () => {
    const { session } = await signInFlow();
    const [row] = await deps.db.query<{ csrf: string }>("SELECT csrf FROM sessions");
    const signOut = (headers: Record<string, string>) =>
      call(app, {
        method: "POST",
        path: "/auth/signout",
        headers: {
          cookie: `session=${session}`,
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: `csrf=${row?.csrf}`,
      });
    expect((await signOut({ origin: "https://evil.example" })).status).toBe(403);
    expect(await deps.db.query("SELECT * FROM sessions")).toHaveLength(1);
    const out = await signOut({ origin: deps.config.origin });
    expect(out.status).toBe(303);
    expect(out.headers?.location).toBe("/");
    expect(setCookie(out, "session")).toBe("");
    expect(await deps.db.query("SELECT * FROM sessions")).toEqual([]);
  });

  it("does not renew the session cookie it is clearing on sign-out", async () => {
    const { session } = await signInFlow();
    const [row] = await deps.db.query<{ csrf: string }>("SELECT csrf FROM sessions");
    const later = { ...deps, now: () => "2026-10-20T12:00:00.000Z" };
    const out = await call(createApp(later, authRoutes(later)), {
      method: "POST",
      path: "/auth/signout",
      headers: {
        cookie: `session=${session}`,
        "content-type": "application/x-www-form-urlencoded",
        origin: deps.config.origin,
      },
      body: `csrf=${row?.csrf}`,
    });
    expect(out.status).toBe(303);
    expect([out.headers?.["set-cookie"]].flat()).toEqual([
      "session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly",
    ]);
  });
});

describe("GitHub sign-in when GitHub misbehaves (spec 2 S7)", () => {
  it("answers 502 when GitHub will not return the profile", async () => {
    const broken: Deps = {
      ...deps,
      fetch: async (input, init) =>
        String(input).endsWith("/user")
          ? new Response("oops", { status: 500 })
          : deps.fetch(input, init),
    };
    expect((await signInFlow(createApp(broken, authRoutes(broken)))).back.status).toBe(502);
    expect(await deps.db.query("SELECT * FROM accounts")).toEqual([]);
  });
});
