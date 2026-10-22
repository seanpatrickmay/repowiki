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

  it("refuses one flow's validly signed state with another flow's validly signed cookie", async () => {
    const stateOf = async () => setCookie(await call(app, { path: "/auth/github" }), "oauth_state");
    const a = (await stateOf()) ?? "";
    const b = (await stateOf()) ?? "";
    expect(a).not.toBe(b);
    const crossed = await call(app, {
      path: `/auth/github/callback?code=fake-code&state=${a}`,
      headers: { cookie: `oauth_state=${encodeURIComponent(b)}` },
    });
    expect(crossed.status).toBe(400);
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

  it("admits anyone new when the allowlist is *, which no GitHub login can be", async () => {
    const open = {
      ...deps,
      config: { ...deps.config, mode: "development" as const, signupAllowlist: ["*"] },
    };
    expect((await signInFlow(createApp(open, authRoutes(open)))).back.status).toBe(303);
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
    const out = await signOut({ origin: deps.config.appOrigin });
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
        origin: deps.config.appOrigin,
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

  it("answers 502 when GitHub cannot be reached at all", async () => {
    const down = (path: string): Deps => ({
      ...deps,
      fetch: async (input, init) => {
        if (String(input).includes(path)) throw new TypeError("fetch failed");
        return deps.fetch(input, init);
      },
    });
    for (const path of ["/login/oauth/access_token", "/api/user"]) {
      const broken = down(path);
      const { back } = await signInFlow(createApp(broken, authRoutes(broken)));
      expect(back.status, path).toBe(502);
      expect(String(back.body)).toContain("Sign-in failed");
    }
  });
});

describe("GitHub sign-in failures clear the state cookie (spec 2 S7)", () => {
  const cleared = (reply: Awaited<ReturnType<typeof call>>) =>
    [reply.headers?.["set-cookie"] ?? []].flat().some((c) => /^oauth_state=;.*Max-Age=0/.test(c));

  it("explains a sign-in the user cancelled on GitHub", async () => {
    const start = await call(app, { path: "/auth/github" });
    const state = setCookie(start, "oauth_state") ?? "";
    const reply = await call(app, {
      path: `/auth/github/callback?error=access_denied&state=${state}`,
      headers: { cookie: `oauth_state=${encodeURIComponent(state)}` },
    });
    expect(reply.status).toBe(400);
    expect(String(reply.body)).toContain("You cancelled the sign-in on GitHub.");
    expect(cleared(reply)).toBe(true);
  });

  it("clears it after a bad state and a refused code", async () => {
    const start = await call(app, { path: "/auth/github" });
    const state = setCookie(start, "oauth_state") ?? "";
    const cookie = { cookie: `oauth_state=${encodeURIComponent(state)}` };
    const bad = await call(app, { path: "/auth/github/callback?code=x&state=no", headers: cookie });
    expect(cleared(bad)).toBe(true);
    const refused = await call(app, {
      path: `/auth/github/callback?code=nope&state=${state}`,
      headers: cookie,
    });
    expect(refused.status).toBe(400);
    expect(cleared(refused)).toBe(true);
  });
});

describe("the GitHub avatar at sign-in (ADR-0013)", () => {
  const AVATAR = "https://avatars.githubusercontent.com/u/4242?v=4";
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

  /** The fake GitHub, its user carrying `avatar_url`, and its avatar host answering `answer`. */
  function avatarApp(answer: () => Response, now = deps.now) {
    let fetches = 0;
    const github = deps.fetch;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === AVATAR) {
        fetches += 1;
        return answer();
      }
      const reply = await github(input, init);
      if (!url.endsWith("/user")) return reply;
      return Response.json({ ...(await reply.json()), avatar_url: AVATAR });
    };
    const local = { ...deps, fetch: fetchFn, now };
    return { app: createApp(local, authRoutes(local)), fetches: () => fetches };
  }
  const stored = async () =>
    (await deps.db.query<{ body: { avatar?: unknown } }>("SELECT body FROM accounts"))[0]?.body
      .avatar;

  it("stores the avatar's bytes by hash, and fetches it again only once a week has passed", async () => {
    const { app: on, fetches } = avatarApp(() => new Response(PNG));
    expect((await signInFlow(on)).back.status).toBe(303);
    const avatar = (await stored()) as { sha256: string; fetchedAt: string };
    expect(avatar).toMatchObject({ contentType: "image/png", source: AVATAR });
    expect(avatar.fetchedAt).toBe(deps.now());
    expect(avatar.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await deps.objects.get(`avatars/${avatar.sha256}`))?.body).toEqual(PNG);
    await signInFlow(on);
    expect(fetches()).toBe(1);
    // GitHub's avatar URL never changes with the picture (review I2): a week on, it is fetched
    // again; the same bytes only move fetchedAt, new bytes are stored under their own hash.
    const WEEK_ON = "2026-10-21T12:00:01.000Z";
    const later = avatarApp(
      () => new Response(PNG),
      () => WEEK_ON,
    );
    await signInFlow(later.app);
    expect(later.fetches()).toBe(1);
    expect(await stored()).toEqual({ ...avatar, fetchedAt: WEEK_ON });
    const NEW = new Uint8Array([...PNG, 8]);
    const changed = avatarApp(
      () => new Response(NEW),
      () => "2026-10-29T12:00:00.000Z",
    );
    await signInFlow(changed.app);
    const next = (await stored()) as { sha256: string };
    expect(next.sha256).not.toBe(avatar.sha256);
    expect((await deps.objects.get(`avatars/${next.sha256}`))?.body).toEqual(NEW);
  });

  it("signs in without one when the avatar host fails, or sends something else", async () => {
    for (const answer of [
      () => new Response("down", { status: 500 }),
      () => new Response("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    ]) {
      const { app: on } = avatarApp(answer);
      expect((await signInFlow(on)).back.status).toBe(303);
      expect(await stored()).toBeUndefined();
    }
  });
});
