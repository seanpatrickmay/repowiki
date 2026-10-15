import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { text } from "./http/server.ts";
import { call, testDeps } from "./routes/test-app.ts";

describe("createApp (spec 2 §4)", () => {
  it("dispatches to its routes with their parameters", async () => {
    const deps = await testDeps();
    const app = createApp(deps, [
      {
        method: "GET",
        pattern: "/hi/:name",
        handler: async (r) => text(200, `hi ${r.params.name}`),
      },
    ]);
    const reply = await call(app, { path: "/hi/sean" });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("hi sean");
    expect((await call(app, { method: "POST", path: "/hi/sean" })).status).toBe(405);
    await deps.db.close();
  });

  it("answers an unknown path with an escaped not-found page", async () => {
    const deps = await testDeps();
    const reply = await call(createApp(deps, []), { path: "/<b>x" });
    expect(reply.status).toBe(404);
    expect(String(reply.headers?.["content-type"])).toMatch(/^text\/html/);
    expect(String(reply.body)).toContain("Not found");
    expect(String(reply.body)).not.toContain("<b>");
    await deps.db.close();
  });

  it("serves the style sheet", async () => {
    const deps = await testDeps();
    const reply = await call(createApp(deps, []), { path: "/_app/style.css" });
    expect(reply.status).toBe(200);
    expect(reply.headers?.["content-type"]).toBe("text/css; charset=utf-8");
    expect(String(reply.body)).toContain("--accent");
    await deps.db.close();
  });

  it("mounts the fake GitHub's authorize page only when GitHub is fake", async () => {
    const path = "/_fake/github/login/oauth/authorize";
    const fake = await testDeps();
    expect((await call(createApp(fake, []), { path })).status).toBe(400);
    const real = await testDeps({
      config: { ...fake.config, github: { kind: "oauth", clientId: "c", clientSecret: "s" } },
    });
    expect((await call(createApp(real, []), { path })).status).toBe(404);
    await fake.db.close();
    await real.db.close();
  });
});
