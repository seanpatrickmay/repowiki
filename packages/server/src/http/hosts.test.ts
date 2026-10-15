import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import { call } from "../routes/test-app.ts";
import { appCsp, byHost, PAGES_CSP } from "./hosts.ts";
import type { RouteRequest } from "./router.ts";
import type { App } from "./server.ts";

const config = loadConfig({ REPOWIKI_MODE: "demo", PORT: "9002" });
const APP = { host: "127.0.0.1:9002" };
const PAGES = { host: "localhost:9002" };

/** An app that says which host's app it is, echoes the Cookie it got, and tries to set one. */
const echo =
  (name: string): App =>
  async (request: RouteRequest) => ({
    status: 200,
    headers: { "content-type": "text/plain", "set-cookie": "session=x; Path=/" },
    body: `${name} ${request.headers.cookie ?? "no cookie"}`,
  });
const app = byHost(config, { app: echo("app"), pages: echo("pages") });

describe("routing by Host (ADR-0012)", () => {
  it("sends each origin's host to its own app, matching the host case-insensitively", async () => {
    expect(String((await call(app, { path: "/", headers: APP })).body)).toMatch(/^app /);
    expect(String((await call(app, { path: "/", headers: PAGES })).body)).toMatch(/^pages /);
    const upper = { host: "LOCALHOST:9002" };
    expect(String((await call(app, { path: "/", headers: upper })).body)).toMatch(/^pages /);
  });

  it("answers 404 for any other host, another port, or none", async () => {
    for (const host of ["evil.example", "127.0.0.1:9003", "localhost", ""]) {
      const reply = await call(app, { path: "/", headers: host === "" ? {} : { host } });
      expect(reply.status, host).toBe(404);
      expect(reply.headers?.["set-cookie"], host).toBeUndefined();
    }
  });

  it("gives the pages app no Cookie and lets it set none", async () => {
    const reply = await call(app, { path: "/", headers: { ...PAGES, cookie: "session=secret" } });
    expect(String(reply.body)).toBe("pages no cookie");
    expect(reply.headers?.["set-cookie"]).toBeUndefined();
    const own = await call(app, { path: "/", headers: { ...APP, cookie: "session=secret" } });
    expect(String(own.body)).toBe("app session=secret");
    expect(own.headers?.["set-cookie"]).toBeDefined();
  });

  it("lets the app's forms lead to the pages origin, for the open-preview redirect", async () => {
    const csp = (await call(app, { path: "/", headers: APP })).headers?.["content-security-policy"];
    expect(csp).toBe(appCsp(config));
    expect(appCsp(config)).toContain(`form-action 'self' ${config.publicOrigin}`);
    expect(appCsp(config)).toContain("default-src 'self'");
  });

  it("gives pages their own policy unless a reply sets one (a built site's)", async () => {
    expect(
      (await call(app, { path: "/", headers: PAGES })).headers?.["content-security-policy"],
    ).toBe(PAGES_CSP);
    expect(PAGES_CSP).toContain("form-action 'none'");
    const site: App = async () => ({
      status: 200,
      headers: { "content-security-policy": "default-src 'self'" },
      body: "",
    });
    const withSite = byHost(config, { app: echo("app"), pages: site });
    const reply = await call(withSite, { path: "/", headers: PAGES });
    expect(reply.headers?.["content-security-policy"]).toBe("default-src 'self'");
  });
});
