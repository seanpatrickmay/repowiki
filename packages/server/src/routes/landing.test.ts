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
  it("sends a signed-out visitor to the public home page (ADR-0016)", async () => {
    const reply = await call(createApp(deps, landingRoutes(deps)), { path: "/" });
    expect(reply).toMatchObject({
      status: 302,
      headers: { location: `${deps.config.publicOrigin}/` },
    });
  });

  it.each(["/terms", "/privacy", "/refunds"])(
    "sends %s on to the public site, where the legal pages live",
    async (path) => {
      const reply = await call(createApp(deps, landingRoutes(deps)), { path });
      expect(reply).toMatchObject({
        status: 301,
        headers: { location: `${deps.config.publicOrigin}${path}` },
      });
    },
  );

  it("sends a signed-in visitor on to the dashboard", async () => {
    const { cookie } = await signedInCookie(deps);
    const reply = await call(createApp(deps, landingRoutes(deps)), {
      path: "/",
      headers: { cookie },
    });
    expect(reply).toMatchObject({ status: 302, headers: { location: "/dashboard" } });
  });
});
