import { isReservedHandle } from "@repowiki/hosted";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { SITE_PAGES, SITE_STYLE_PATH } from "../pages/site.ts";
import { siteRoutes } from "./site.ts";
import { call, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
beforeAll(async () => {
  deps = await testDeps();
  app = createApp(deps, siteRoutes(deps), { host: "pages" });
});
afterAll(async () => deps.db.close());

const body = async (path: string) => String((await call(app, { path })).body);

describe("the public site (readiness: marketing pages)", () => {
  it("serves the home page at the pages origin's root, cached briefly and the same for everyone", async () => {
    const reply = await call(app, { path: "/" });
    expect(reply.status).toBe(200);
    expect(reply.headers?.["cache-control"]).toBe("public, max-age=300");
    const home = String(reply.body);
    expect(home).toContain("Show recruiters what you actually built.");
    expect(home).toContain(`href="${deps.config.appOrigin}/auth/github"`);
    expect(home).toContain('href="/example"');
  });

  it("serves every page in the nav and footer, each with a title and the site's own style sheet", async () => {
    for (const path of Object.keys(SITE_PAGES)) {
      const reply = await call(app, { path });
      expect(reply.status, path).toBe(200);
      expect(String(reply.body), path).toContain(
        `<link rel="stylesheet" href="${SITE_STYLE_PATH}">`,
      );
      expect(String(reply.body), path).toMatch(
        /<title>[^<]+ · RepoWiki<\/title>|<title>RepoWiki<\/title>/,
      );
    }
    const css = await call(app, { path: SITE_STYLE_PATH });
    expect(css.headers?.["content-type"]).toBe("text/css; charset=utf-8");
    expect(String(css.body)).toContain("prefers-color-scheme: dark");
  });

  it("keeps the pages' strict CSP: no inline style or script anywhere", async () => {
    for (const path of Object.keys(SITE_PAGES)) {
      const html = await body(path);
      expect(html, path).not.toMatch(/style=|<style|<script/);
    }
  });

  it("says internship and co-op in that order, and never names the developer", async () => {
    for (const path of ["/", "/pro", "/questions"]) {
      const html = await body(path);
      expect(html, path).not.toMatch(/co-op and internship/i);
      expect(html, path).not.toMatch(/Sean|seanpatrickmay/);
    }
    expect(await body("/")).toMatch(/internship and co-op/i);
  });

  it("says beside every sign-in button that signing in accepts the Terms and the Privacy notice", async () => {
    for (const path of Object.keys(SITE_PAGES)) {
      const html = await body(path);
      const buttons =
        html.split(`class="button" href="${deps.config.appOrigin}/auth/github"`).length - 1;
      const notices = html.split('Signing in accepts the <a href="/terms">Terms</a>').length - 1;
      expect(notices, path).toBe(buttons);
    }
    expect(await body("/")).toContain("Signing in accepts");
  });

  it("shows both Pro prices and the Free rebuild", async () => {
    const pro = await body("/pro");
    expect(pro).toContain("$5 a month");
    expect(pro).toContain("$15 every 4 months");
    expect(await body("/questions")).toContain("rebuild it once");
  });

  it("links only to pages it serves, the legal pages among them", async () => {
    const links = new Set<string>();
    for (const path of Object.keys(SITE_PAGES)) {
      for (const [, href] of (await body(path)).matchAll(/href="(\/[^"]*)"/g))
        links.add(href ?? "");
    }
    for (const href of links) {
      if (href === "/example" || href.startsWith("/_app/")) continue;
      expect(Object.keys(SITE_PAGES), href).toContain(href);
    }
    expect([...links]).toEqual(expect.arrayContaining(["/terms", "/privacy", "/refunds"]));
  });

  it("states the refund rule and what is stored, in the words of the pages", async () => {
    const refunds = await body("/refunds");
    expect(refunds).toContain("within 7 days of your first payment");
    expect(refunds).toContain("support@repowiki.app");
    const privacy = await body("/privacy");
    expect(privacy).toContain("two cookies");
    expect(privacy).toMatch(/never sell/);
    for (const processor of ["GitHub", "Anthropic", "Stripe", "Fly.io", "Cloudflare", "Neon"]) {
      expect(privacy, processor).toContain(processor);
    }
    expect(await body("/terms")).toContain("Massachusetts");
  });

  it("reserves every site path, so no GitHub login can take it as a handle", () => {
    for (const path of [...Object.keys(SITE_PAGES), "/example"]) {
      if (path === "/") continue;
      expect(isReservedHandle(path.slice(1)), path).toBe(true);
    }
  });
});
