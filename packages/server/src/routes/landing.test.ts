import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { landingRoutes } from "./landing.ts";
import { call, signedInCookie, testDeps } from "./test-app.ts";

let deps: Deps;
beforeAll(async () => {
  deps = await testDeps();
});
afterAll(async () => deps.db.close());

describe("the landing page (spec 2 §7)", () => {
  it("answers signed out with a sign-in link, and is what the health check reads", async () => {
    const reply = await call(createApp(deps, landingRoutes(deps)), { path: "/" });
    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain('href="/auth/github"');
  });

  it("sends a signed-in visitor on to the dashboard", async () => {
    const { cookie } = await signedInCookie(deps);
    const reply = await call(createApp(deps, landingRoutes(deps)), {
      path: "/",
      headers: { cookie },
    });
    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain('href="/dashboard"');
    // It names the visitor, so no shared cache may keep it.
    expect(reply.headers?.["cache-control"]).toBe("private, no-store");
  });
});
