import { REFUSALS } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { latestRevision, reviewOf } from "../store/drafts.ts";
import { draftRoutes } from "./drafts.ts";
import {
  call,
  FIXTURE_FEATURES,
  form,
  generatedProject,
  otherCookie,
  testDeps,
} from "./test-app.ts";

let deps: Deps;
let app: App;
let p: { projectId: string; cookie: string; csrf: string; accountId: string };
const first = FIXTURE_FEATURES[0] ?? "";

const post = (path: string, body: string, cookie = p.cookie) =>
  call(app, { method: "POST", path, headers: form(cookie, deps.config.origin), body });
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
    // Every wiki page is public: there is no hide control (ADR-0012).
    expect(body).not.toContain('name="hidden"');
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

describe("saving the portfolio layer (Contract §6.3)", () => {
  it("saves overrides as a new revision and omits fields equal to the suggestion", async () => {
    const reply = await post(
      `/projects/${p.projectId}/revisions`,
      new URLSearchParams([
        ["csrf", p.csrf],
        ["baseRevision", "1"],
        ["tagline", "A tiny demo"],
        ["summary", "My own summary."],
        ["contribution", "I wrote the ingest step."],
        ["highlight", first],
        [`blurb:${first}`, "Reads the files."],
      ]).toString(),
    );
    expect(reply.status).toBe(303);
    const latest = await latestRevision(deps.db, p.projectId);
    expect(latest).toMatchObject({
      number: 2,
      source: "author",
      overrides: {
        summary: "My own summary.",
        contribution: "I wrote the ingest step.",
        highlights: [{ featureId: first, blurb: "Reads the files." }],
      },
    });
    expect(latest?.overrides.tagline).toBeUndefined();
  });

  it("refuses a stale base revision and markup, with the Contract's status", async () => {
    const path = `/projects/${p.projectId}/revisions`;
    const stale = await post(path, `csrf=${p.csrf}&baseRevision=7&contribution=x`);
    expect(stale.status).toBe(REFUSALS["stale-revision"].status);
    const markup = encodeURIComponent("<b>me</b>");
    const bad = await post(path, `csrf=${p.csrf}&baseRevision=1&contribution=${markup}`);
    expect(bad.status).toBe(REFUSALS["invalid-input"].status);
    expect((await latestRevision(deps.db, p.projectId))?.number).toBe(1);
  });

  it("refuses another account's project as not found, and a missing CSRF token", async () => {
    const other = await otherCookie(deps);
    const path = `/projects/${p.projectId}/revisions`;
    const reply = await post(
      path,
      `csrf=${other.csrf}&baseRevision=1&contribution=x`,
      other.cookie,
    );
    expect(reply.status).toBe(404);
    expect((await post(path, "baseRevision=1&contribution=x")).status).toBe(403);
    expect((await latestRevision(deps.db, p.projectId))?.number).toBe(1);
  });
});

describe("review (Contract §6.3, §8)", () => {
  it("needs the declaration ticked and a contribution, then records the review", async () => {
    const review = `/projects/${p.projectId}/review`;
    const empty = await post(review, `csrf=${p.csrf}&revision=1&attest=yes`);
    expect(empty.status).toBe(REFUSALS["contribution-missing"].status);
    await post(
      `/projects/${p.projectId}/revisions`,
      `csrf=${p.csrf}&baseRevision=1&contribution=Mine.`,
    );
    expect((await post(review, `csrf=${p.csrf}&revision=2`)).status).toBe(400);
    expect((await post(review, `csrf=${p.csrf}&revision=2&attest=yes`)).status).toBe(303);
    expect(await reviewOf(deps.db, p.projectId, 2)).toMatchObject({
      revision: 2,
      attestationVersion: 1,
    });
    expect(String((await page()).body)).toContain("You reviewed revision 2.");
  });
});
