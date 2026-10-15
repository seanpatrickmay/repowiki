import { describe, expect, it } from "vitest";
import type { RouteRequest } from "../http/router.ts";
import { fakeEndpoints, GITHUB } from "./endpoints.ts";
import { FAKE_CODE, FAKE_TOKEN, FAKE_USER, fakeAuthorizeRoute, fakeGitHubFetch } from "./fake.ts";
import { authorizeUrl, exchangeCode } from "./oauth.ts";

const ORIGIN = "http://127.0.0.1:8787";
const CALLBACK = `${ORIGIN}/auth/github/callback`;
const endpoints = fakeEndpoints(ORIGIN);
const fake = fakeGitHubFetch(endpoints);
const client = { clientId: "c", clientSecret: "s", redirectUri: CALLBACK };

describe("GitHub OAuth (spec 2 S7)", () => {
  it("asks GitHub for no scope at all", () => {
    const url = new URL(authorizeUrl(GITHUB, "client-1", CALLBACK, "st"));
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-1",
      redirect_uri: CALLBACK,
      state: "st",
      scope: "",
      allow_signup: "true",
    });
  });

  it("exchanges a code GitHub accepts for its token, and nothing else", async () => {
    expect(await exchangeCode(fake, endpoints, { ...client, code: FAKE_CODE })).toBe(FAKE_TOKEN);
    expect(await exchangeCode(fake, endpoints, { ...client, code: "nope" })).toBeNull();
    const down = async () => new Response("oops", { status: 502 });
    expect(await exchangeCode(down, endpoints, { ...client, code: FAKE_CODE })).toBeNull();
    const garbage = async () => new Response("<html>", { status: 200 });
    expect(await exchangeCode(garbage, endpoints, { ...client, code: FAKE_CODE })).toBeNull();
  });
});

describe("the fake GitHub (spec 2 S18)", () => {
  it("answers the user only for its token", async () => {
    const as = (token: string) =>
      fake(`${endpoints.api}/user`, { headers: { authorization: `Bearer ${token}` } });
    expect(await (await as(FAKE_TOKEN)).json()).toEqual(FAKE_USER);
    expect((await as("revoked")).status).toBe(401);
    expect((await fake("https://api.github.com/user")).status).toBe(404);
  });

  it("approves at once, but only back to RepoWiki's own callback", async () => {
    const route = fakeAuthorizeRoute(CALLBACK);
    const visit = (query: Record<string, string>) =>
      route.handler({ query: new URLSearchParams(query) } as RouteRequest);
    const approved = await visit({ redirect_uri: CALLBACK, state: "st" });
    expect(approved.status).toBe(302);
    expect(approved.headers?.location).toBe(`${CALLBACK}?code=${FAKE_CODE}&state=st`);
    expect((await visit({ redirect_uri: "https://evil.example/", state: "st" })).status).toBe(400);
    expect((await visit({ state: "st" })).status).toBe(400);
  });
});
