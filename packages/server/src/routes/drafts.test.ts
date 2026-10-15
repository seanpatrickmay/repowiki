import { REFUSALS } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { draftRoutes } from "./drafts.ts";
import { call, FIXTURE_FEATURES, generatedProject, otherCookie, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let p: { projectId: string; cookie: string; csrf: string; accountId: string };
const first = FIXTURE_FEATURES[0] ?? "";

const page = (cookie = p.cookie) =>
  call(app, { path: `/projects/${p.projectId}`, headers: { cookie } });

beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, draftRoutes(deps));
  p = await generatedProject(deps);
});
afterEach(async () => deps.db.close());

describe("the project page (spec 2 §7)", () => {
  it("shows the editor pre-filled from the suggestions, and the review declaration", async () => {
    const reply = await page();
    expect(reply.status).toBe(200);
    const body = String(reply.body);
    expect(body).toContain('value="A tiny demo"');
    expect(body).toContain("I wrote the ingest code.");
    expect(body).toContain(`name="hidden" value="${first}"`);
    expect(body).toContain("I reviewed this version.");
    expect(body).not.toContain("style=");
    expect(body).not.toContain("<style");
  });

  it("is a 404 for another account, and sends a signed-out visitor to sign in", async () => {
    expect((await call(app, { path: `/projects/${p.projectId}` })).status).toBe(303);
    const other = await otherCookie(deps);
    expect((await page(other.cookie)).status).toBe(404);
    const missing = await call(app, {
      path: "/projects/00000000-0000-4000-8000-00000000ffff",
      headers: { cookie: p.cookie },
    });
    expect(missing.status).toBe(404);
  });

  it("reads through the policy: an account being deleted is refused (A5)", async () => {
    await deps.db.query(
      "UPDATE accounts SET body = jsonb_set(body, '{status}', '\"deleting\"') WHERE id = $1",
      [p.accountId],
    );
    expect((await page()).status).toBe(REFUSALS["account-deleting"].status);
  });
});
