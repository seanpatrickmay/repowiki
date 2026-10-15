import { REFUSALS } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { latestRevision, reviewOf } from "../store/drafts.ts";
import { draftRoutes } from "./drafts.ts";
import { call, form, generatedProject, otherCookie, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let p: { projectId: string; cookie: string; csrf: string; accountId: string };

const post = (path: string, body: string, cookie = p.cookie) =>
  call(app, { method: "POST", path, headers: form(cookie, deps.config.appOrigin), body });
const page = (cookie = p.cookie) =>
  call(app, { path: `/projects/${p.projectId}`, headers: { cookie } });

beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, draftRoutes(deps));
  p = await generatedProject(deps);
});
afterEach(async () => deps.db.close());

describe("the project page (spec 2 §7)", () => {
  it("shows the generated content read-only, labelled, with the review declaration", async () => {
    const reply = await page();
    expect(reply.status).toBe(200);
    const body = String(reply.body);
    expect(body).toContain("A tiny demo");
    expect(body).toContain("I wrote the ingest code.");
    expect(body).toContain("Generated from the git history at");
    // Nothing on the page is author-written (ADR-0012): no editor and no hide control.
    for (const name of ["tagline", "summary", "contribution", "highlight", "hidden"]) {
      expect(body).not.toContain(`name="${name}"`);
    }
    expect(body).not.toContain("<textarea");
    expect(body).toContain("I reviewed this version. It describes my project and my part in it");
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

describe("no author edits (ADR-0012)", () => {
  it("has no route that saves a revision", async () => {
    const reply = await post(
      `/projects/${p.projectId}/revisions`,
      `csrf=${p.csrf}&baseRevision=1&contribution=x`,
    );
    expect(reply.status).toBe(404);
    expect((await latestRevision(deps.db, p.projectId))?.number).toBe(1);
  });
});

describe("review (Contract §6.3, ADR-0012)", () => {
  it("needs the declaration ticked, then records attestation 2 for the latest revision", async () => {
    const review = `/projects/${p.projectId}/review`;
    expect((await post(review, `csrf=${p.csrf}&revision=1`)).status).toBe(400);
    const stale = await post(review, `csrf=${p.csrf}&revision=2&attest=yes`);
    expect(stale.status).toBe(REFUSALS["stale-revision"].status);
    expect((await post(review, `csrf=${p.csrf}&revision=1&attest=yes`)).status).toBe(303);
    expect(await reviewOf(deps.db, p.projectId, 1)).toMatchObject({
      revision: 1,
      attestationVersion: 2,
    });
    expect(String((await page()).body)).toContain("You reviewed revision 1.");
  });

  it("refuses another account's project as not found, and a missing CSRF token", async () => {
    const other = await otherCookie(deps);
    const review = `/projects/${p.projectId}/review`;
    const reply = await post(review, `csrf=${other.csrf}&revision=1&attest=yes`, other.cookie);
    expect(reply.status).toBe(404);
    expect((await post(review, "revision=1&attest=yes")).status).toBe(403);
    expect(await reviewOf(deps.db, p.projectId, 1)).toBeNull();
  });
});
