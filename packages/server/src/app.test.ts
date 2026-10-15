import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "./app.ts";
import { text } from "./http/server.ts";
import { currentSession } from "./http/session.ts";
import { call, testDeps } from "./routes/test-app.ts";
import { signIn } from "./store/accounts.ts";
import { createSession } from "./store/sessions.ts";

let deps: Deps;
beforeEach(async () => {
  deps = await testDeps();
});
afterEach(async () => deps.db.close());

describe("createApp (spec 2 §4)", () => {
  it("dispatches to its routes with their parameters", async () => {
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
  });

  it("answers an unknown path with an escaped not-found page", async () => {
    const reply = await call(createApp(deps, []), { path: "/<b>x" });
    expect(reply.status).toBe(404);
    expect(String(reply.headers?.["content-type"])).toMatch(/^text\/html/);
    expect(String(reply.body)).toContain("Not found");
    expect(String(reply.body)).not.toContain("<b>");
  });

  it("serves the style sheet", async () => {
    const reply = await call(createApp(deps, []), { path: "/_app/style.css" });
    expect(reply.status).toBe(200);
    expect(reply.headers?.["content-type"]).toBe("text/css; charset=utf-8");
    expect(String(reply.body)).toContain("--accent");
  });

  it("mounts the fake GitHub's authorize page only when GitHub is fake", async () => {
    const path = "/_fake/github/login/oauth/authorize";
    expect((await call(createApp(deps, []), { path })).status).toBe(400);
    const real: Deps = {
      ...deps,
      config: { ...deps.config, github: { kind: "oauth", clientId: "c", clientSecret: "s" } },
    };
    expect((await call(createApp(real, []), { path })).status).toBe(404);
  });

  it("re-issues the session cookie when the session slides, at most once a day (spec 2 S6)", async () => {
    await signIn(
      deps.db,
      { githubUserId: 1, login: "u1", displayName: "U", githubCreatedAt: "2019-01-01T00:00:00Z" },
      {
        newAccountId: "00000000-0000-4000-8000-0000000000a1",
        allowNew: () => true,
        now: deps.now(),
      },
    );
    const { token } = await createSession(
      deps.db,
      "00000000-0000-4000-8000-0000000000a1",
      deps.now(),
    );
    let clock = "2026-10-14T13:00:00.000Z";
    const reading: Deps = { ...deps, now: () => clock };
    const app = createApp(reading, [
      {
        method: "GET",
        pattern: "/me",
        handler: async (r) => {
          const session = await currentSession(reading.db, reading.config, r.headers, clock);
          return text(200, session?.account.login ?? "nobody");
        },
      },
    ]);
    const read = () => call(app, { path: "/me", headers: { cookie: `session=${token}` } });
    const soon = await read();
    expect(soon.body).toBe("u1");
    expect(soon.headers?.["set-cookie"]).toBeUndefined();
    clock = "2026-10-16T12:00:00.000Z";
    const later = await read();
    expect(later.headers?.["set-cookie"]).toEqual([
      `session=${token}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`,
    ]);
    expect((await read()).headers?.["set-cookie"]).toBeUndefined();
  });
});
