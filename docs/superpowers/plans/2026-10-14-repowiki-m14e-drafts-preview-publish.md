# M14e Drafts, Preview, Publish and Public Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The author's half of the journey and the reader's: the project page with job progress, the portfolio editor, review, a private preview of the exact site, publish and unpublish; then the public project page, its wiki and the profile, served signed out.

**Architecture:** A published version is a frozen tree in object storage: the wiki the site package builds from the hosted export (hidden features removed, People and in-flight work dropped), plus `portfolio.json`, the resolved portfolio layer. The preview is that tree under `previews/<projectId>/r<rev>/`; publishing copies it, unchanged, to `sites/<projectId>/v<n>/` after the Contract's `publish` checks the preview hash. The portfolio page is rendered from `portfolio.json` at request time, so its publish date can come from the version row while every word the author reviewed is in the hashed tree.

**Tech Stack:** TypeScript, the site package's `buildSite` (in a child process), `node:crypto`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-repowiki-hosted-slice-design.md` (S13, S14, §7, §9, §10). Contract §6.3, §6.4, §8, §9.

## Global Constraints

- Every mutating route: session, same-origin `Origin` and CSRF (`checkMutation`), a live or hour-old eligibility check as the Contract asks, one transaction that locks the project row, `authorize`, the Contract transition, writes, an audit event (S5).
- The site build runs in a child process (it calls `process.chdir` and sets environment variables), one at a time, under a 5-minute limit.
- Every author or generated string reaches HTML only through `escapeHtml`.
- Public responses: `Cache-Control: public, max-age=60`; preview responses: `Cache-Control: private, no-store`. Built-site responses carry `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` (Pagefind needs WebAssembly, Mermaid inline styles).
- The wiki's base is `/<handle>/<slug>/docs/` (the site's own routes already start with `wiki/`, so a `/wiki/` base would give `/wiki/wiki/<id>/`). Amend spec 2 S13 to say so in Task 3's commit.
- One branch per task, stacked on M14d: `m14/server-project-page`, `m14/server-render`, `m14/server-preview`, `m14/server-publish`.

## Review Focus

1. **A hidden feature reachable anyway** through a link token, a See also, an About claim, an edge or a diagram node: none survive in the hosted export. Pinned in Task 2.
2. **Publishing a revision whose preview was built before a later save**: refused by the Contract (`stale-revision` or `preview-mismatch`); the preview list shows which revision a preview is of. Pinned in Task 4.
3. **Another account's project id in any URL**: 404, never a different account's data. Pinned in Tasks 1, 3, 4.
4. **A login that equals an app path** (`projects`, `preview`, `internal`, `llm`): reserved, so it can never shadow an app route. Pinned in Task 4.
5. **A withdrawn page**: the portfolio, its wiki files and the profile entry answer 410 or drop out at once. Pinned in Task 4.

## Amendments from the plan review (binding: where they conflict with a task below, they win)

- **A1 (Tasks 3 and 4, Important): content-addressed previews.** A preview tree is written once at `previews/<projectId>/r<rev>/<siteHash>/` and never rewritten. `Preview.siteKey` is that key.
  - Rebuilding the same revision writes a new key and replaces the row.
  - `copyTree` recomputes `treeHash` over what it copied and refuses a mismatch with `preview-mismatch`, before the version row is written.
  - Tests: a preview whose stored file was changed after the hash cannot be published.
- **A2 (Task 1, Important): retry and refresh routes.**
  - `POST /projects/:id/jobs/:job/retry`: live eligibility, then in one transaction `authorize("job.retry")`, `retryJob`, `saveJob`, `revokeTokens`, `issueToken`. After commit, `runner.start`.
  - `POST /projects/:id/refresh` calls M14c's `startRefresh`, which Free refuses.
  - The page shows **Retry** only when the failed job's refusal is `REFUSALS[code].retryable` and attempts remain; otherwise it shows **Start over** (the `job.create` form, bounded by the month's budget).
  - Tests: retry of a retryable failure starts attempt 2 with the same cap; retry of `job-cost-cap` is refused.
- **A3 (Tasks 1 and 3, Important): limits on expensive and mutating requests.**
  - Add an in-memory limiter: 60 mutating requests a minute per session (spec 2 §10), answered 429. Apply it in `checkMutation` or one wrapper every POST route uses.
  - Allow one preview build in flight per account; a second answers 429 "A preview is already being built."
  - Tests for both.
- **A4 (Task 2): hidden features leave the manifest too.**
  - The site writes the whole export as `docs/export.json` and `llms.txt`, so hidden features must leave `manifest.features` and every manifest field that names them, as well as the pages.
  - The test checks `JSON.stringify(out)` including the manifest, and the built tree's `export.json` and `llms.txt`.
  - If the manifest schema makes removal impossible, say so as a ruling and stop publishing `export.json` and `llms.txt` from hosted sites instead: delete them from the tree before hashing.
- **A5 (Tasks 1 and 3): reads go through the policy too.**
  - `GET /projects/:id` calls `authorize("draft.read")`, and the preview routes call `authorize("preview.read")`, so an account being deleted is refused (spec 2 §13: every action through `authorize`).
- **A6 (all tasks): use the real M14a/M14b names.** M14a and M14b were built before this plan ran. Where this plan's calls differ, use what the code exports (e.g. `listen(app, { port, host })`, `fakeGitHubFetch(endpoints)`).

---

### Task 1: The project page, saving the portfolio layer, review and cancel

**Files:**
- Modify: `packages/server/src/store/drafts.ts` (reviews, previews, versions)
- Create: `packages/server/src/routes/live.ts`, `packages/server/src/pages/project.ts`, `packages/server/src/routes/drafts.ts`, `packages/server/src/routes/drafts.test.ts`
- Modify: `packages/server/src/routes/test-app.ts` (`generatedProject(deps)`), `packages/server/src/index.ts`

**Interfaces:**
- Consumes: M14c's `projectById`, `usageFor`, `jobsOf`, `jobById`, `saveJob`, `settleOpen`, `revokeTokens`, `latestRevision`, `generationById`, `saveRevision` (store), `saveProject`; M14b's `githubApi`, `eligibilityFacts`, `readGitHubToken`, `currentSession`, `checkMutation`; M14a's `activeHandle`, `appendAudit`; hosted `authorize`, `saveRevision` (as `reviseDraft`), `reviewRevision`, `cancelJob`, `ATTESTATIONS`, `REFUSALS`, `projectUrl`.
- Produces: store `reviewOf(q, projectId, revision)`, `saveReview(q, review)`, `previewOf(q, projectId, revision)`, `savePreview(q, preview)`, `versionOf(q, projectId, version)`, `saveVersion(q, version)`; `liveEligibility(deps, session, githubRepoId)` → `{ ok: true; facts; repo } | { ok: false; reply }`; `ownedProject(deps, session, id, forUpdate?, q?)`; `overridesFrom(form, generation)`; `projectPage(view)`; `draftRoutes(deps)`; `featureTitles(deps, generation)`; test helper `generatedProject(deps)` → `{ projectId, cookie, csrf, accountId }`.

Routes:

| Route | Action |
|---|---|
| `GET /projects/:id` | `draft.read`, `job.read` |
| `POST /projects/:id/revisions` | `draft.save` (fields `baseRevision`, `tagline`, `summary`, `contribution`, `highlight` × n, `blurb:<featureId>`, `hidden` × n) |
| `POST /projects/:id/review` | `draft.review` (fields `revision`, `attest=yes`) |
| `POST /projects/:id/jobs/:job/cancel` | `job.cancel` |

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-project-page
```

- [ ] **Step 2: Write the failing tests**

Add to `packages/server/src/routes/test-app.ts`:

```ts
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { internalRoutes } from "./internal.ts";

/** Test-only: a project whose first generation succeeded, so revision 1 exists. */
export async function generatedProject(
  deps: Deps,
): Promise<{ projectId: string; cookie: string; csrf: string; accountId: string }> {
  const job = await startedJob(deps);
  const app = createApp(deps, internalRoutes(deps));
  const auth = { authorization: `Bearer ${job.token}` };
  await call(app, { method: "POST", path: "/internal/job/lease", headers: auth });
  const exp = fixtureExport();
  await call(app, {
    method: "PUT",
    path: "/internal/job/export",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(exp),
  });
  const featureIds = [...new Set(exp.pages.map((p) => p.featureId))];
  const done = await call(app, {
    method: "POST",
    path: "/internal/job/succeed",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      suggestions: {
        tagline: "A tiny demo",
        summary: "It demonstrates RepoWiki.",
        contributionDraft: "I wrote the ingest code.",
        highlightCandidates: featureIds.slice(0, 1),
      },
      facts: {
        languages: [{ name: "Python", share: 1 }],
        indexedFiles: 3,
        featureIds,
        author: { commits: 2, totalCommits: 3, currentLines: 10, totalLines: 20, features: [] },
      },
      engineVersion: "test",
      models: ["claude-haiku-4-5"],
    }),
  });
  if (done.status !== 204) throw new Error(`succeed answered ${done.status}`);
  const { cookie, csrf, accountId } = await signedInCookie(deps);
  return { projectId: job.projectId, cookie, csrf, accountId };
}
```

(`signedInCookie` signs in the same fake user again: `signIn` returns the existing account and a new session. If `startedJob` already exposes the cookie, return that one instead.)

`packages/server/src/routes/drafts.test.ts`:

```ts
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { latestRevision, reviewOf } from "../store/drafts.ts";
import { jobsOf } from "../store/jobs.ts";
import { draftRoutes } from "./drafts.ts";
import { call, form, generatedProject, signedInCookie, startedJob, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let p: { projectId: string; cookie: string; csrf: string; accountId: string };
const featureIds = [...new Set(fixtureExport().pages.map((page) => page.featureId))];
const first = featureIds[0] ?? "";

const post = (path: string, body: string, cookie = p.cookie) =>
  call(app, { method: "POST", path, headers: form(cookie, deps.config.origin), body });

beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, draftRoutes(deps));
  p = await generatedProject(deps);
});
afterEach(async () => deps.db.close());

describe("the project page (spec 2 §7)", () => {
  it("shows the editor pre-filled from the suggestions, and the review declaration", async () => {
    const reply = await call(app, { path: `/projects/${p.projectId}`, headers: { cookie: p.cookie } });
    expect(reply.status).toBe(200);
    const body = String(reply.body);
    expect(body).toContain('value="A tiny demo"');
    expect(body).toContain("I wrote the ingest code.");
    expect(body).toContain(`name="hidden" value="${first}"`);
    expect(body).toContain("I reviewed this version.");
  });

  it("is a 404 for anyone but the owner", async () => {
    expect((await call(app, { path: `/projects/${p.projectId}` })).status).toBe(303);
    await deps.db.query("UPDATE projects SET account_id = account_id"); // no-op: same owner
    const other = await call(app, { path: "/projects/00000000-0000-4000-8000-00000000ffff", headers: { cookie: p.cookie } });
    expect(other.status).toBe(404);
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
        hiddenFeatureIds: [],
      },
    });
    expect(latest?.overrides.tagline).toBeUndefined();
  });

  it("refuses a stale base revision and markup, with the Contract's message", async () => {
    const stale = await post(`/projects/${p.projectId}/revisions`, `csrf=${p.csrf}&baseRevision=7&contribution=x`);
    expect(stale.status).toBe(409);
    const markup = await post(
      `/projects/${p.projectId}/revisions`,
      `csrf=${p.csrf}&baseRevision=1&contribution=${encodeURIComponent("<b>me</b>")}`,
    );
    expect(markup.status).toBe(400);
    expect((await latestRevision(deps.db, p.projectId))?.number).toBe(1);
  });
});

describe("review (Contract §6.3, §8)", () => {
  it("needs the declaration ticked and a contribution, then records the review", async () => {
    expect((await post(`/projects/${p.projectId}/review`, `csrf=${p.csrf}&revision=1&attest=yes`)).status).toBe(409);
    await post(`/projects/${p.projectId}/revisions`, `csrf=${p.csrf}&baseRevision=1&contribution=Mine.`);
    expect((await post(`/projects/${p.projectId}/review`, `csrf=${p.csrf}&revision=2`)).status).toBe(400);
    expect((await post(`/projects/${p.projectId}/review`, `csrf=${p.csrf}&revision=2&attest=yes`)).status).toBe(303);
    expect(await reviewOf(deps.db, p.projectId, 2)).toMatchObject({ revision: 2, attestationVersion: 1 });
  });
});

describe("cancel (Contract §6.1)", () => {
  it("cancels the owner's running job and revokes its token", async () => {
    const fresh = await testDeps();
    const job = await startedJob(fresh);
    const { cookie, csrf } = await signedInCookie(fresh);
    const freshApp = createApp(fresh, draftRoutes(fresh));
    const reply = await call(freshApp, {
      method: "POST",
      path: `/projects/${job.projectId}/jobs/${job.jobId}/cancel`,
      headers: form(cookie, fresh.config.origin),
      body: `csrf=${csrf}`,
    });
    expect(reply.status).toBe(303);
    expect((await jobsOf(fresh.db, job.projectId))[0]).toMatchObject({ status: "cancelled" });
    await fresh.db.close();
  });
});
```

(The 409 for an unreviewable revision is `contribution-missing`'s status in `REFUSALS`; if the table says otherwise, assert `REFUSALS["contribution-missing"].status`. The same goes for `stale-revision` and `invalid-input`.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server/src/routes/drafts.test.ts`
Expected: FAIL — cannot resolve `./drafts.ts`.

- [ ] **Step 4: Write the implementation**

Append to `packages/server/src/store/drafts.ts`:

```ts
import { Preview, PublishedVersion, Review } from "@repowiki/hosted";

async function one<T>(q: Queryable, sql: string, params: unknown[], schema: { parse(v: unknown): T }, what: string) {
  const rows = await q.query<{ body: unknown }>(sql, params);
  return rows[0] === undefined ? null : parsedBody(schema as never, rows[0].body, what) as T;
}

export const reviewOf = (q: Queryable, projectId: string, revision: number) =>
  one(q, "SELECT body FROM reviews WHERE project_id = $1 AND revision = $2", [projectId, revision], Review, "review");

/** One review per revision (S4); a second review of the same revision changes nothing. */
export async function saveReview(q: Queryable, review: Review): Promise<void> {
  const body = parsedBody(Review, review, "review");
  await q.query(
    "INSERT INTO reviews (project_id, revision, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING",
    [body.projectId, body.revision, asJson(body)],
  );
}

export const previewOf = (q: Queryable, projectId: string, revision: number) =>
  one(q, "SELECT body FROM previews WHERE project_id = $1 AND revision = $2", [projectId, revision], Preview, "preview");

/** A preview is rebuilt on request; the newest build of a revision replaces the last. */
export async function savePreview(q: Queryable, preview: Preview): Promise<void> {
  const body = parsedBody(Preview, preview, "preview");
  await q.query(
    `INSERT INTO previews (project_id, revision, body) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (project_id, revision) DO UPDATE SET body = excluded.body`,
    [body.projectId, body.revision, asJson(body)],
  );
}

export const versionOf = (q: Queryable, projectId: string, version: number) =>
  one(q, "SELECT body FROM published_versions WHERE project_id = $1 AND version = $2", [projectId, version], PublishedVersion, "published version");

/** Published versions are immutable (Contract §9): inserting an existing number is an error. */
export async function saveVersion(q: Queryable, version: PublishedVersion): Promise<void> {
  const body = parsedBody(PublishedVersion, version, "published version");
  await q.query("INSERT INTO published_versions (project_id, version, body) VALUES ($1, $2, $3::jsonb)", [
    body.projectId,
    body.version,
    asJson(body),
  ]);
}
```

(If `parsedBody`'s signature makes the generic `one` awkward, write the three getters out the way `generationById` is written; the behaviour is what matters.)

`packages/server/src/routes/live.ts`:

```ts
import type { EligibilityFacts, Project } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { type GitHubRepo, githubApi } from "../github/api.ts";
import { eligibilityFacts } from "../github/facts.ts";
import type { Reply } from "../http/router.ts";
import { redirect } from "../http/server.ts";
import type { Session } from "../http/session.ts";
import { pageSession, refusalPage } from "../pages/refusal.ts";
import { readGitHubToken } from "../store/github-tokens.ts";
import { projectById } from "../store/projects.ts";

/** A live eligibility check as the signed-in user (spec 2 S8), or the reply to send instead. */
export async function liveEligibility(
  deps: Deps,
  session: Session,
  githubRepoId: number,
): Promise<{ ok: true; facts: EligibilityFacts; repo: GitHubRepo | null } | { ok: false; reply: Reply }> {
  const token = await readGitHubToken(deps.db, deps.config.tokenKey, session.account.id);
  if (token === null) return { ok: false, reply: redirect("/auth/github") };
  const { facts, repo } = await eligibilityFacts(githubApi(deps.fetch, deps.github), token, {
    githubUserId: session.account.githubUserId,
    login: session.account.login,
    githubRepoId,
    now: deps.now(),
    indexedFiles: null,
  });
  return { ok: true, facts, repo };
}

/** The session's own project, or null: another account's id is indistinguishable from none (C10). */
export async function ownedProject(
  q: Queryable,
  session: Session,
  id: string,
  forUpdate = false,
): Promise<Project | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const project = await projectById(q, id, forUpdate);
  return project !== null && project.accountId === session.account.id ? project : null;
}

export { pageSession, refusalPage };
```

Add to `packages/server/src/pages/refusal.ts`:

```ts
import type { Session } from "../http/session.ts";

export const pageSession = (s: Session): PageSession => ({ csrf: s.csrf, login: s.account.login });
```

(and use it in `routes/projects.ts` in place of its local copy.)

`packages/server/src/pages/project.ts`:

```ts
import {
  ATTESTATIONS,
  type DraftRevision,
  type Generation,
  JOB_STEPS,
  type Job,
  type Preview,
  type Project,
  type PublishedVersion,
  REFUSALS,
  type Review,
} from "@repowiki/hosted";
import { escapeHtml, page, type PageSession } from "./layout.ts";

export interface ProjectView {
  project: Project;
  publicUrl: string;
  repoFullName: string | null;
  job: Job | null;
  revision: DraftRevision | null;
  generation: Generation | null;
  review: Review | null;
  preview: Preview | null;
  current: PublishedVersion | null;
  titles: ReadonlyMap<string, string>;
  session: PageSession;
}

const e = escapeHtml;
const hidden = (name: string, value: string | number) => `<input type="hidden" name="${e(name)}" value="${e(String(value))}">`;

function jobSection(v: ProjectView): string {
  const { job, project, session } = v;
  if (job === null) return "";
  const active = job.status === "queued" || job.status === "running";
  const steps = JOB_STEPS.map((step) => {
    const done = job.step !== null && JOB_STEPS.indexOf(step) < JOB_STEPS.indexOf(job.step);
    const now = job.step === step && active;
    return `<li class="${done ? "muted" : ""}">${now ? "<strong>" : ""}${e(step)}${now ? "</strong> …" : ""}</li>`;
  }).join("");
  const why = job.refusal === null ? "" : `<p class="notice">${e(REFUSALS[job.refusal].message)}</p>`;
  const cancel = active
    ? `<form method="post" action="/projects/${project.id}/jobs/${job.id}/cancel">${hidden("csrf", session.csrf)}<button class="secondary">Cancel</button></form>`
    : "";
  const again =
    !active && project.latestRevision === 0
      ? `<form method="post" action="/projects">${hidden("csrf", session.csrf)}${hidden("githubRepoId", project.githubRepoId)}<button>Try again</button></form>`
      : "";
  return `<section class="card"><h2>Generation: ${e(job.status)}</h2><ol>${steps}</ol>${why}${cancel}${again}</section>`;
}

function editor(v: ProjectView): string {
  const { revision, generation, project, session, titles } = v;
  if (revision === null || generation === null) return "";
  const o = revision.overrides;
  const s = generation.suggestions;
  const flags = revision.flags.length === 0 ? "" : `<p class="notice">Check these before review: ${revision.flags.map(e).join(", ")}</p>`;
  const featureRows = generation.facts.featureIds
    .map((id) => {
      const lit = o.highlights.find((h) => h.featureId === id);
      return `<tr><td>${e(titles.get(id) ?? id)}</td>
<td><input type="checkbox" name="highlight" value="${e(id)}"${lit ? " checked" : ""}> <input name="blurb:${e(id)}" maxlength="140" value="${e(lit?.blurb ?? "")}" aria-label="Highlight text"></td>
<td><input type="checkbox" name="hidden" value="${e(id)}"${o.hiddenFeatureIds.includes(id) ? " checked" : ""}></td></tr>`;
    })
    .join("");
  return `<section class="card"><h2>Portfolio (revision ${revision.number})</h2>${flags}
<form method="post" action="/projects/${project.id}/revisions">${hidden("csrf", session.csrf)}${hidden("baseRevision", revision.number)}
<label for="tagline">Tagline</label><input id="tagline" name="tagline" maxlength="90" value="${e(o.tagline ?? s.tagline)}">
<label for="summary">Summary</label><textarea id="summary" name="summary" maxlength="900">${e(o.summary ?? s.summary)}</textarea>
<label for="contribution">Your contribution</label><p class="muted">Required to publish. Describe your own work; the suggestion is only a start.</p>
<textarea id="contribution" name="contribution" maxlength="1200">${e(o.contribution || s.contributionDraft)}</textarea>
<table><thead><tr><th>Feature</th><th>Highlight (up to 4)</th><th>Hide</th></tr></thead><tbody>${featureRows}</tbody></table>
<button>Save</button></form></section>`;
}

function reviewSection(v: ProjectView): string {
  const { revision, review, project, session } = v;
  if (revision === null) return "";
  if (review !== null && review.revision === revision.number) {
    return `<section class="card"><h2>Review</h2><p>You reviewed revision ${revision.number}.</p></section>`;
  }
  return `<section class="card"><h2>Review</h2><form method="post" action="/projects/${project.id}/review">${hidden("csrf", session.csrf)}${hidden("revision", revision.number)}
<label><input type="checkbox" name="attest" value="yes"> ${e(ATTESTATIONS[1])}</label><button>Record review</button></form></section>`;
}

function publishSection(v: ProjectView): string {
  const { revision, preview, project, session, current, publicUrl } = v;
  if (revision === null) return "";
  const live =
    project.state === "published"
      ? `<p>Live at <a href="${e(publicUrl)}">${e(publicUrl)}</a> (version ${project.currentVersion}).</p>
<form method="post" action="/projects/${project.id}/unpublish">${hidden("csrf", session.csrf)}<button class="secondary">Unpublish</button></form>`
      : "";
  const build = `<form method="post" action="/projects/${project.id}/preview">${hidden("csrf", session.csrf)}${hidden("revision", revision.number)}<button class="secondary">Build preview of revision ${revision.number}</button></form>`;
  const ready =
    preview !== null && preview.revision === revision.number
      ? `<p><a href="/preview/${project.id}/${revision.number}/">Open the preview</a></p>
<form method="post" action="/projects/${project.id}/publish">${hidden("csrf", session.csrf)}${hidden("revision", revision.number)}${hidden("expectedVersion", current?.version ?? project.currentVersion)}${hidden("previewHash", preview.siteHash)}<button>Publish revision ${revision.number}</button></form>`
      : `<p class="muted">Build a preview of the latest revision before publishing.</p>`;
  return `<section class="card"><h2>Preview and publish</h2>${live}${build}${ready}</section>`;
}

/** The author's working page for one project (spec 2 §7). */
export function projectPage(v: ProjectView): string {
  const active = v.job !== null && (v.job.status === "queued" || v.job.status === "running");
  const refresh = active ? '<meta http-equiv="refresh" content="3">' : "";
  const repo = v.repoFullName === null ? "" : `<p class="muted">${e(v.repoFullName)}</p>`;
  return page({
    title: v.project.slug,
    body: `${refresh}<h1>${e(v.project.slug)}</h1>${repo}<p class="muted">State: ${e(v.project.state)}</p>${jobSection(v)}${editor(v)}${reviewSection(v)}${publishSection(v)}`,
    session: v.session,
  });
}
```

(A `<meta>` in `<body>` is honoured by browsers; if lint or a test objects, add an optional `head` field to `page()` and pass it there.)

`packages/server/src/routes/drafts.ts`:

```ts
import { WikiExport } from "@repowiki/core";
import {
  authorize,
  cancelJob,
  type Generation,
  projectUrl,
  reviewRevision,
  saveRevision as reviseDraft,
} from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { readForm } from "../http/body.ts";
import type { Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { checkMutation, currentSession, type Session } from "../http/session.ts";
import { projectPage } from "../pages/project.ts";
import { activeHandle } from "../store/accounts.ts";
import { appendAudit } from "../store/audit.ts";
import {
  generationById,
  latestRevision,
  previewOf,
  reviewOf,
  saveReview,
  saveRevision,
  versionOf,
} from "../store/drafts.ts";
import { jobById, jobsOf, revokeTokens, saveJob, settleOpen } from "../store/jobs.ts";
import { saveProject, usageFor } from "../store/projects.ts";
import { liveEligibility, ownedProject, pageSession, refusalPage } from "./live.ts";

const titleCache = new Map<string, ReadonlyMap<string, string>>();

/** Feature titles from a generation's export, cached by export key (the export never changes). */
export async function featureTitles(deps: Deps, generation: Generation): Promise<ReadonlyMap<string, string>> {
  const cached = titleCache.get(generation.exportKey);
  if (cached) return cached;
  const object = await deps.objects.get(generation.exportKey);
  const titles = new Map<string, string>();
  if (object !== null) {
    const exp = WikiExport.parse(JSON.parse(new TextDecoder().decode(object.body)));
    for (const f of exp.manifest.features) titles.set(f.id, f.title);
  }
  if (titleCache.size > 200) titleCache.clear();
  titleCache.set(generation.exportKey, titles);
  return titles;
}

/** The editor's form as the Contract's overrides input; a field equal to its suggestion is omitted. */
export function overridesFrom(form: URLSearchParams, generation: Generation): unknown {
  const s = generation.suggestions;
  const text = (name: string) => (form.get(name) ?? "").replace(/\r\n?/g, "\n").trim();
  const tagline = text("tagline");
  const summary = text("summary");
  return {
    ...(tagline === "" || tagline === s.tagline ? {} : { tagline }),
    ...(summary === "" || summary === s.summary ? {} : { summary }),
    contribution: text("contribution"),
    highlights: form
      .getAll("highlight")
      .slice(0, 10)
      .map((featureId) => ({ featureId, blurb: text(`blurb:${featureId}`) })),
    hiddenFeatureIds: form.getAll("hidden").slice(0, 500),
  };
}

async function audit(tx: Queryable, deps: Deps, action: string, id: string, outcome: string) {
  await appendAudit(tx, {
    id: deps.newId(),
    actor: "author",
    action,
    target: { entity: "project", id },
    outcome: outcome as never,
    createdAt: deps.now(),
  });
}

export function draftRoutes(deps: Deps): Route[] {
  const signedIn = async (headers: Record<string, unknown>) =>
    currentSession(deps.db, deps.config, headers as never, deps.now());

  /** One draft mutation: live facts, then a transaction that locks the project (S5). */
  async function mutate(
    session: Session,
    projectId: string,
    action: "draft.save" | "draft.review",
    apply: (tx: Queryable, ctx: { project: NonNullable<Awaited<ReturnType<typeof ownedProject>>> }) => Promise<{ ok: true } | { ok: false; code: string }>,
  ) {
    const owned = await ownedProject(deps.db, session, projectId);
    if (owned === null) return refusalPage("not-found", pageSession(session));
    const live = await liveEligibility(deps, session, owned.githubRepoId);
    if (!live.ok) return live.reply;
    const result = await deps.db.transaction(async (tx) => {
      const project = await ownedProject(tx, session, projectId, true);
      if (project === null) return { ok: false as const, code: "not-found" };
      const usage = await usageFor(tx, session.account.id, deps.now());
      const verdict = authorize(action, { now: deps.now(), caller: { kind: "account", account: session.account }, project, facts: live.facts, usage });
      if (!verdict.ok) return verdict;
      const applied = await apply(tx, { project });
      if (applied.ok) await audit(tx, deps, action, project.id, "allowed");
      return applied;
    });
    if (!result.ok) {
      await deps.db.transaction((tx) => audit(tx, deps, action, projectId, result.code));
      return refusalPage(result.code as never, pageSession(session), `/projects/${projectId}`);
    }
    return redirect(`/projects/${projectId}`);
  }

  return [
    {
      method: "GET",
      pattern: "/projects/:id",
      handler: async (request) => {
        const session = await signedIn(request.headers);
        if (session === null) return redirect("/auth/github");
        const project = await ownedProject(deps.db, session, request.params.id ?? "");
        if (project === null) return refusalPage("not-found", pageSession(session));
        const [jobs, revision, handle] = await Promise.all([
          jobsOf(deps.db, project.id),
          latestRevision(deps.db, project.id),
          activeHandle(deps.db, session.account.id),
        ]);
        const generation = revision === null ? null : await generationById(deps.db, revision.generationId);
        const repo = await deps.db.query<{ full_name: string }>(
          "SELECT body->>'fullName' AS full_name FROM repositories WHERE github_repo_id = $1",
          [project.githubRepoId],
        );
        return html(
          200,
          projectPage({
            project,
            publicUrl: projectUrl(deps.config.origin, handle ?? session.account.login, project.slug),
            repoFullName: repo[0]?.full_name ?? null,
            job: jobs[0] ?? null,
            revision,
            generation,
            review: revision === null ? null : await reviewOf(deps.db, project.id, revision.number),
            preview: revision === null ? null : await previewOf(deps.db, project.id, revision.number),
            current: project.currentVersion === 0 ? null : await versionOf(deps.db, project.id, project.currentVersion),
            titles: generation === null ? new Map() : await featureTitles(deps, generation),
            session: pageSession(session),
          }),
        );
      },
    },
    {
      method: "POST",
      pattern: "/projects/:id/revisions",
      handler: async (request) => {
        const session = await signedIn(request.headers);
        const form = await readForm(request.raw);
        checkMutation(deps.config, request.headers, session, form.get("csrf"));
        const baseRevision = Number(form.get("baseRevision"));
        return mutate(session, request.params.id ?? "", "draft.save", async (tx, { project }) => {
          const latest = await latestRevision(tx, project.id);
          const generation = latest === null ? null : await generationById(tx, latest.generationId);
          if (latest === null || generation === null) return { ok: false, code: "invalid-transition" };
          const revised = reviseDraft(project, latest, generation, baseRevision, overridesFrom(form, generation), deps.now());
          if (!revised.ok) return revised;
          await saveRevision(tx, revised.value.revision);
          await saveProject(tx, revised.value.project);
          return { ok: true };
        });
      },
    },
    {
      method: "POST",
      pattern: "/projects/:id/review",
      handler: async (request) => {
        const session = await signedIn(request.headers);
        const form = await readForm(request.raw);
        checkMutation(deps.config, request.headers, session, form.get("csrf"));
        if (form.get("attest") !== "yes") return refusalPage("invalid-input", pageSession(session), `/projects/${request.params.id}`);
        const revision = Number(form.get("revision"));
        return mutate(session, request.params.id ?? "", "draft.review", async (tx, { project }) => {
          const latest = await latestRevision(tx, project.id);
          if (latest === null) return { ok: false, code: "invalid-transition" };
          const review = reviewRevision(latest, revision, deps.now());
          if (!review.ok) return review;
          await saveReview(tx, review.value);
          return { ok: true };
        });
      },
    },
    {
      method: "POST",
      pattern: "/projects/:id/jobs/:job/cancel",
      handler: async (request) => {
        const session = await signedIn(request.headers);
        const form = await readForm(request.raw);
        checkMutation(deps.config, request.headers, session, form.get("csrf"));
        const projectId = request.params.id ?? "";
        const outcome = await deps.db.transaction(async (tx) => {
          const project = await ownedProject(tx, session, projectId, true);
          const job = project === null ? null : await jobById(tx, request.params.job ?? "", true);
          if (project === null || job === null || job.projectId !== project.id) return "not-found" as const;
          const verdict = authorize("job.cancel", { now: deps.now(), caller: { kind: "account", account: session.account }, project });
          if (!verdict.ok) return verdict.code;
          const cancelled = cancelJob(await settleOpen(tx, job), deps.now());
          if (!cancelled.ok) return cancelled.code;
          await saveJob(tx, cancelled.value);
          await revokeTokens(tx, job.id);
          await audit(tx, deps, "job.cancel", project.id, "allowed");
          return "allowed" as const;
        });
        if (outcome !== "allowed") return refusalPage(outcome, pageSession(session), `/projects/${projectId}`);
        return redirect(`/projects/${projectId}`);
      },
    },
  ];
}
```

(`checkMutation` throws `HttpError` for a missing session or a bad token, so `session` is non-null after it; if its return type does not narrow, use its return value. `refusalPage` takes a `RefusalCode`; cast where the code comes from a Contract result.)

Add to `packages/server/src/index.ts`:

```ts
export {
  generationById,
  latestRevision,
  previewOf,
  reviewOf,
  saveGeneration,
  savePreview,
  saveReview,
  saveRevision,
  saveVersion,
  versionOf,
} from "./store/drafts.ts";
export { projectPage, type ProjectView } from "./pages/project.ts";
export { draftRoutes, featureTitles, overridesFrom } from "./routes/drafts.ts";
export { liveEligibility, ownedProject } from "./routes/live.ts";
```

(replacing the earlier `store/drafts.ts` export line).

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server
pnpm check
git add packages/server
git -c user.email=sean.may101@gmail.com commit -m "feat(server): add the project page, the portfolio editor, review and cancel"
```

---

### Task 2: The hosted export, the portfolio layer and tree hashing (pure)

**Files:**
- Create: `packages/server/src/render/hosted-export.ts`, `packages/server/src/render/hosted-export.test.ts`
- Create: `packages/server/src/render/portfolio.ts`, `packages/server/src/render/portfolio.test.ts`
- Create: `packages/server/src/render/tree.ts`, `packages/server/src/render/tree.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: core `WikiExport`; hosted `Generation`, `DraftRevision`, `Facts`; `escapeHtml`.
- Produces: `hostedExport(exp, hiddenFeatureIds)` → `WikiExport`; `PortfolioData` (schema/type), `portfolioData({ generation, revision, exp, repoFullName })`, `portfolioHtml(data, { base, publishedAt, preview })`, `CHECKED_STATEMENT(sha)`; `TreeFile`, `treeHash(files)`, `readTree(dir)`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-render
```

- [ ] **Step 2: Write the failing tests**

`packages/server/src/render/hosted-export.test.ts`:

```ts
import { WikiExport } from "@repowiki/core";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { hostedExport } from "./hosted-export.ts";

const exp = WikiExport.parse(fixtureExport());
const ids = [...new Set(exp.pages.map((p) => p.featureId))];
const hidden = ids[0] ?? "";

describe("the hosted export (spec 2 S10, S13; Contract §8)", () => {
  it("is a valid export with no trace of a hidden feature outside the manifest", () => {
    const out = hostedExport(exp, [hidden]);
    expect(() => WikiExport.parse(out)).not.toThrow();
    expect(out.pages.map((p) => p.featureId)).not.toContain(hidden);
    expect(Object.keys(out.history)).not.toContain(hidden);
    const { manifest: _m, ...rest } = out;
    const text = JSON.stringify(rest);
    expect(text).not.toContain(`[[${hidden}]]`);
    expect(text).not.toContain(`[[${hidden}|`);
    expect(text).not.toContain(`"${hidden}"`);
  });

  it("drops People, work in flight, run costs and Wikipedia summaries", () => {
    const out = hostedExport(exp, []);
    expect(out.people).toBeNull();
    expect(out.inflight).toBeNull();
    expect(out.runs).toEqual([]);
    expect(out.wikipedia).toEqual({});
    expect(out.pages).toHaveLength(exp.pages.length);
  });

  it("keeps a linked page's words when its link goes", () => {
    const linked = exp.pages.find((p) => JSON.stringify(p).includes(`[[${hidden}`));
    if (linked === undefined) return; // the fixture links nothing to this page
    const out = hostedExport(exp, [hidden]);
    const after = out.pages.find((p) => p.featureId === linked.featureId);
    expect(JSON.stringify(after)).not.toContain(`[[${hidden}`);
  });
});
```

(If the fixture has no page linking to `hidden`, extend the test with a page whose claim text contains `[[${hidden}]]` built from `makeRevision` in `@repowiki/core/test-fixtures`, so the link-removal path runs.)

`packages/server/src/render/portfolio.test.ts`:

```ts
import { WikiExport } from "@repowiki/core";
import type { DraftRevision, Generation } from "@repowiki/hosted";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { CHECKED_STATEMENT, PortfolioData, portfolioData, portfolioHtml } from "./portfolio.ts";

const exp = WikiExport.parse(fixtureExport());
const ids = [...new Set(exp.pages.map((p) => p.featureId))];
const SHA = "c".repeat(40);
const generation = {
  id: "00000000-0000-4000-8000-000000000001",
  jobId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  commitSha: SHA,
  exportKey: "exports/x-1.json",
  exportHash: "d".repeat(64),
  suggestions: { tagline: "Suggested tagline", summary: "Suggested summary.", contributionDraft: "Draft.", highlightCandidates: [] },
  facts: {
    languages: [{ name: "Python", share: 0.75 }],
    indexedFiles: 12,
    featureIds: ids,
    author: { commits: 3, totalCommits: 4, currentLines: 50, totalLines: 100, features: [] },
  },
  engineVersion: "t",
  models: ["claude-haiku-4-5"],
  spentUsdMicros: 0,
  createdAt: "2026-10-14T12:00:00.000Z",
} as Generation;
const revision = {
  projectId: generation.projectId,
  number: 2,
  generationId: generation.id,
  overrides: {
    summary: "My <summary> & more.",
    contribution: "I built it.",
    highlights: [{ featureId: ids[0] ?? "", blurb: "The core." }],
    hiddenFeatureIds: [],
  },
  flags: [],
  source: "author",
  createdAt: "2026-10-14T12:00:00.000Z",
} as DraftRevision;

describe("the portfolio layer (Contract §8)", () => {
  it("resolves overrides over suggestions and names highlights by title", () => {
    const data = portfolioData({ generation, revision, exp, repoFullName: "demo-dev/demo-repo" });
    expect(PortfolioData.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({
      tagline: "Suggested tagline",
      summary: "My <summary> & more.",
      contribution: "I built it.",
      repo: { fullName: "demo-dev/demo-repo", commitSha: SHA },
      highlights: [{ featureId: ids[0], blurb: "The core." }],
    });
  });

  it("renders the seven parts in order, escaped, with the checked statement verbatim", () => {
    const data = portfolioData({ generation, revision, exp, repoFullName: "demo-dev/demo-repo" });
    const page = portfolioHtml(data, { base: "/demo-dev/demo-repo/", publishedAt: "2026-10-15T09:00:00.000Z", preview: false });
    expect(page).toContain("My &lt;summary&gt; &amp; more.");
    expect(page).not.toContain("<summary>");
    expect(page).toContain(`https://github.com/demo-dev/demo-repo/tree/${SHA}`);
    expect(page).toContain("Author-reviewed");
    expect(page).toContain("3 of 4 commits");
    expect(page).toContain(`/demo-dev/demo-repo/docs/wiki/${ids[0]}/`);
    expect(page).toContain(escapeOnce(CHECKED_STATEMENT(SHA)));
    const order = ["<header", 'id="summary"', 'id="glance"', 'id="contribution"', 'id="highlights"', 'id="wiki"', 'id="checked"'];
    const at = order.map((marker) => page.indexOf(marker));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("says it is a preview, and gives no publish date, before publishing", () => {
    const data = portfolioData({ generation, revision, exp, repoFullName: "demo-dev/demo-repo" });
    const page = portfolioHtml(data, { base: "/preview/p/2/", publishedAt: null, preview: true });
    expect(page).toContain("Preview");
    expect(page).toContain("/preview/p/2/docs/");
  });
});

function escapeOnce(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
```

`packages/server/src/render/tree.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTree, treeHash } from "./tree.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("tree hashing (spec 2 S13)", () => {
  it("is independent of file order and changes with any path or byte", () => {
    const a = [{ path: "a.html", bytes: enc("A") }, { path: "b/c.css", bytes: enc("C") }];
    const reordered = [a[1], a[0]] as typeof a;
    expect(treeHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(treeHash(reordered)).toBe(treeHash(a));
    expect(treeHash([{ path: "a.html", bytes: enc("B") }, a[1] as (typeof a)[number]])).not.toBe(treeHash(a));
    expect(treeHash([{ path: "z.html", bytes: enc("A") }, a[1] as (typeof a)[number]])).not.toBe(treeHash(a));
  });

  it("reads a directory as posix paths with a prefix, skipping the site marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-"));
    mkdirSync(join(dir, "x"));
    writeFileSync(join(dir, "x", "1.txt"), "1");
    writeFileSync(join(dir, ".repowiki-site"), "m");
    expect(readTree(dir, "docs/").map((f) => f.path)).toEqual(["docs/x/1.txt"]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server/src/render`
Expected: FAIL — cannot resolve `./hosted-export.ts`, `./portfolio.ts`, `./tree.ts`.

- [ ] **Step 4: Write the implementation**

`packages/server/src/render/hosted-export.ts`:

```ts
import { WikiExport } from "@repowiki/core";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The export a hosted site is built from (spec 2 S10, S13; Contract §8): hidden features leave
 * the pages, history, every link, See also, About claim, edge and diagram; People, work in flight,
 * run costs and Wikipedia summaries are dropped. Throws when no valid export remains.
 */
export function hostedExport(exp: WikiExport, hiddenFeatureIds: readonly string[]): WikiExport {
  const hidden = new Set(hiddenFeatureIds);
  const titles = new Map(exp.manifest.features.map((f) => [f.id as string, f.title]));
  const link =
    hidden.size === 0
      ? null
      : new RegExp(`\\[\\[(${[...hidden].map(escapeRe).join("|")})(?:\\|([^\\]]+))?\\]\\]`, "g");
  const node =
    hidden.size === 0 ? null : new RegExp(`(^|[^a-z0-9-])(${[...hidden].map(escapeRe).join("|")})($|[^a-z0-9-])`);

  /** Strings lose links to hidden pages; string lists lose hidden ids; diagrams lose their lines. */
  const scrub = (value: Json, key: string): Json => {
    if (typeof value === "string") {
      if (key === "diagram" && node !== null) {
        return value
          .split("\n")
          .filter((line) => !node.test(line))
          .join("\n");
      }
      return link === null ? value : value.replace(link, (_m, id: string, label?: string) => label ?? titles.get(id) ?? id);
    }
    if (Array.isArray(value)) {
      const kept = value.filter((item) => !(typeof item === "string" && hidden.has(item)));
      return kept.map((item) => scrub(item, key));
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
    }
    return value;
  };

  const architecture = exp.architecture.map((article) => {
    const scrubbed = scrub(article as unknown as Json, "") as unknown as (typeof exp.architecture)[number];
    const edges = scrubbed.edges.filter((edge) => !hidden.has(edge.from) && !hidden.has(edge.to));
    const dropped = new Set<string>();
    const sections = scrubbed.sections
      .map((section) => ({
        ...section,
        claims: section.claims.filter((claim) => {
          const bare = claim.supports.length === 0 && claim.citations.length === 0 && claim.pages.length === 0;
          if (bare) dropped.add(claim.id);
          return !bare;
        }),
      }))
      .map((section) => ({
        ...section,
        claims: section.claims
          .map((claim) => ({ ...claim, supports: claim.supports.filter((id) => !dropped.has(id)) }))
          .filter((claim) => section.key !== "lead" || claim.supports.length > 0),
      }))
      .filter((section) => section.claims.length > 0);
    return { ...scrubbed, edges, sections, diagram: scrubbed.diagram?.trim() ? scrubbed.diagram : null };
  });

  const pages = exp.pages.filter((p) => !hidden.has(p.featureId)).map((p) => scrub(p as unknown as Json, "") as unknown as typeof p);
  const history = Object.fromEntries(
    Object.entries(exp.history)
      .filter(([id]) => !hidden.has(id))
      .map(([id, revisions]) => [id, revisions.map((r) => scrub(r as unknown as Json, "") as unknown as typeof r)]),
  );
  const base = { ...exp, pages, history, people: null, inflight: null, runs: [], wikipedia: {} };
  const withArticle = WikiExport.safeParse({ ...base, architecture });
  if (withArticle.success) return withArticle.data;
  return WikiExport.parse({ ...base, architecture: [] });
}
```

(Read `ArchitectureClaim`'s fields in `packages/core/src/architecture.ts` and `Claim` in `claim.ts`: the code above assumes `id`, `supports`, `citations` and `pages`. A lead claim is identified by its section key `lead`; if the schema marks leads another way, use that. The article's `basis` holds page revision ids, not feature ids; drop the hidden features' page revision ids from it as well:
`basis: scrubbed.basis.filter((id) => !hiddenRevisionIds.has(id))`, where `hiddenRevisionIds` collects `id` over `exp.history[hidden]`. If the site lists manifest features without pages as links, also remove hidden features from `manifest.features` and the manifest fields that name them, keeping `WikiExport.parse` green — Task 3's build test shows whether that is needed.)

`packages/server/src/render/portfolio.ts`:

```ts
import { GitSha, type WikiExport } from "@repowiki/core";
import { type DraftRevision, Facts, type Generation } from "@repowiki/hosted";
import { z } from "zod";
import { escapeHtml as e } from "../pages/layout.ts";

/** Contract §8 (7), verbatim. */
export const CHECKED_STATEMENT = (sha: string) =>
  `Citations resolve to commit ${sha} with matching content hashes. Whether the cited code supports each claim is not verified automatically.`;

/** The resolved portfolio layer, stored as `portfolio.json` in every preview and version. */
export const PortfolioData = z.strictObject({
  title: z.string().min(1).max(120),
  tagline: z.string().max(90),
  summary: z.string().max(900),
  contribution: z.string().min(1).max(1200),
  repo: z.strictObject({ fullName: z.string().min(3), commitSha: GitSha }),
  facts: Facts,
  titles: z.record(z.string(), z.string()),
  highlights: z.array(z.strictObject({ featureId: z.string(), title: z.string(), blurb: z.string() })).max(4),
  hasAbout: z.boolean(),
});
export type PortfolioData = z.infer<typeof PortfolioData>;

export function portfolioData(input: {
  generation: Generation;
  revision: DraftRevision;
  exp: WikiExport;
  repoFullName: string;
}): PortfolioData {
  const { generation, revision, exp } = input;
  const o = revision.overrides;
  const hidden = new Set(o.hiddenFeatureIds);
  const titles = Object.fromEntries(
    exp.manifest.features.filter((f) => generation.facts.featureIds.includes(f.id)).map((f) => [f.id, f.title]),
  );
  return PortfolioData.parse({
    title: exp.architecture.at(-1)?.title ?? input.repoFullName.split("/")[1] ?? input.repoFullName,
    tagline: o.tagline ?? generation.suggestions.tagline,
    summary: o.summary ?? generation.suggestions.summary,
    contribution: o.contribution,
    repo: { fullName: input.repoFullName, commitSha: generation.commitSha },
    facts: generation.facts,
    titles,
    highlights: o.highlights
      .filter((h) => !hidden.has(h.featureId))
      .map((h) => ({ featureId: h.featureId, title: titles[h.featureId] ?? h.featureId, blurb: h.blurb })),
    hasAbout: exp.architecture.length > 0,
  });
}

const STYLE = `:root{color-scheme:light dark;--bg:#fdfdfb;--fg:#1d2125;--muted:#5a6470;--line:#d9dde1;--accent:#1f5fa8}@media(prefers-color-scheme:dark){:root{--bg:#111417;--fg:#e8ecef;--muted:#9aa5b0;--line:#2c3238;--accent:#7fb2ec}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 Georgia,"Times New Roman",serif}main{max-width:46rem;margin:0 auto;padding:2rem max(16px,env(safe-area-inset-left)) 4rem}h1{font-size:2.2rem;line-height:1.15;margin:.2rem 0}h2{font:600 .8rem/1.2 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:2.5rem 0 .75rem}a{color:var(--accent)}.tagline{font-size:1.2rem;color:var(--muted);margin:.25rem 0 1rem}.meta{font:14px/1.5 system-ui,sans-serif;color:var(--muted)}.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 .6rem;margin-left:.5rem}.bar{display:flex;height:.6rem;border-radius:4px;overflow:hidden;background:var(--line)}.bar span{background:var(--accent)}.bar span+span{opacity:.6}dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;font:15px/1.5 system-ui,sans-serif}dt{color:var(--muted)}.cards{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))}.cards a{display:block;border:1px solid var(--line);border-radius:8px;padding:1rem;text-decoration:none;color:var(--fg)}.cards strong{display:block;color:var(--accent)}.checked{font:14px/1.5 system-ui,sans-serif;color:var(--muted);border-top:1px solid var(--line);padding-top:1rem}.preview{font:600 14px system-ui,sans-serif;background:var(--accent);color:var(--bg);padding:.4rem 1rem;text-align:center}`;

const paragraphs = (text: string) =>
  text
    .split(/\n[ \t]*\n/)
    .map((p) => `<p>${e(p.trim())}</p>`)
    .join("");
const percent = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

/** The public project page (Contract §8), its seven parts in order; `base` ends with "/". */
export function portfolioHtml(
  data: PortfolioData,
  options: { base: string; publishedAt: string | null; preview: boolean },
): string {
  const { facts, repo } = data;
  const docs = `${options.base}docs/`;
  const date = options.publishedAt === null ? "Not published yet" : `Published ${options.publishedAt.slice(0, 10)}`;
  const languages = facts.languages.map((l) => `${e(l.name)} ${Math.round(l.share * 100)}%`).join(" · ") || "—";
  const a = facts.author;
  const featureRows = a.features
    .map((f) => `<dt>${e(data.titles[f.featureId] ?? f.featureId)}</dt><dd>${f.commits} commits · ${f.currentLines} current lines</dd>`)
    .join("");
  const highlights = data.highlights
    .map((h) => `<a href="${e(`${docs}wiki/${h.featureId}/`)}"><strong>${e(h.title)}</strong>${e(h.blurb)}</a>`)
    .join("");
  const repoUrl = `https://github.com/${repo.fullName}/tree/${repo.commitSha}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(data.title)}</title><meta name="description" content="${e(data.tagline)}"><style>${STYLE}</style></head><body>${options.preview ? `<div class="preview">Preview: only you can see this page</div>` : ""}<main>
<header><h1>${e(data.title)}</h1><p class="tagline">${e(data.tagline)}</p><p class="meta"><a href="${e(repoUrl)}">${e(repo.fullName)} at ${e(repo.commitSha.slice(0, 7))}</a> · ${e(date)}<span class="badge">Author-reviewed</span></p></header>
<section id="summary"><h2>Summary</h2>${paragraphs(data.summary)}</section>
<section id="glance"><h2>At a glance</h2><dl><dt>Languages</dt><dd>${languages}</dd><dt>Size</dt><dd>${facts.indexedFiles} files indexed · ${facts.featureIds.length} features</dd>${data.hasAbout ? `<dt>Architecture</dt><dd><a href="${e(`${docs}special/about/`)}">How the parts fit together, with the diagram</a></dd>` : ""}</dl></section>
<section id="contribution"><h2>My contribution</h2>${paragraphs(data.contribution)}<p class="meta">From the git history at this commit: ${a.commits} of ${a.totalCommits} commits (${percent(a.commits, a.totalCommits)}%) and ${a.currentLines} of ${a.totalLines} current lines (${percent(a.currentLines, a.totalLines)}%).</p>${featureRows ? `<dl>${featureRows}</dl>` : ""}</section>
<section id="highlights"><h2>Highlights</h2>${highlights ? `<div class="cards">${highlights}</div>` : `<p class="meta">No highlights chosen.</p>`}</section>
<section id="wiki"><h2>The wiki</h2><p><a href="${e(docs)}">Read the full source-linked wiki</a></p></section>
<section id="checked" class="checked"><h2>What is checked</h2><p>${e(CHECKED_STATEMENT(repo.commitSha))}</p></section>
</main></body></html>`;
}
```

`packages/server/src/render/tree.ts`:

```ts
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface TreeFile {
  path: string;
  bytes: Uint8Array;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** SHA-256 over every file's path and SHA-256, sorted by path (spec 2 S13). */
export function treeHash(files: readonly TreeFile[]): string {
  const lines = files
    .map((f) => `${f.path}\0${sha256(f.bytes)}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(lines.join(""));
}

/** Every file under `dir` as `prefix` + its posix path, sorted; the site's build marker is left out. */
export function readTree(dir: string, prefix = ""): TreeFile[] {
  const files: TreeFile[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === ".repowiki-site") continue;
    const full = join(entry.parentPath, entry.name);
    files.push({ path: `${prefix}${relative(dir, full).split(sep).join("/")}`, bytes: readFileSync(full) });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}
```

Add to `packages/server/src/index.ts`:

```ts
export { hostedExport } from "./render/hosted-export.ts";
export { CHECKED_STATEMENT, PortfolioData, portfolioData, portfolioHtml } from "./render/portfolio.ts";
export { readTree, type TreeFile, treeHash } from "./render/tree.ts";
```

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server/src/render
pnpm check
git add packages/server
git -c user.email=sean.may101@gmail.com commit -m "feat(server): build the hosted export, the portfolio layer and tree hashes"
```

---

### Task 3: Building and serving a preview

**Files:**
- Create: `packages/server/src/render/site-child.ts`, `packages/server/src/render/build.ts`, `packages/server/src/render/build.test.ts`
- Create: `packages/server/src/routes/preview.ts`, `packages/server/src/routes/preview.test.ts`
- Modify: `packages/server/src/index.ts`, `docs/superpowers/specs/2026-10-14-repowiki-hosted-slice-design.md` (S13: the `/docs/` base, `portfolio.json`, the rewrite on preview)

**Interfaces:**
- Consumes: Task 2; Task 1's `ownedProject`, `previewOf`, `savePreview`, `latestRevision`, `generationById`, `featureTitles`; `ObjectStore`, `contentTypeFor`; hosted `authorize`.
- Produces: `SITE_BUILD_TIMEOUT_MS`, `buildTree({ exp, base, repoUrl, portfolio })` → `{ files: TreeFile[]; hash }`, `renderQueue` (one build at a time); `previewKey(projectId, revision)`; `servePreviewFile(objects, prefix, rest, from, to)`; `previewRoutes(deps)` (`POST /projects/:id/preview`, `GET /preview/:id/:rev/*`); `SITE_CSP`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-preview
```

- [ ] **Step 2: Write the failing tests**

`packages/server/src/render/build.test.ts`:

```ts
import { WikiExport } from "@repowiki/core";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { buildTree } from "./build.ts";
import { hostedExport } from "./hosted-export.ts";
import { treeHash } from "./tree.ts";

const exp = WikiExport.parse(fixtureExport());
const hidden = exp.pages[0]?.featureId ?? "";
const portfolio = new TextEncoder().encode('{"title":"x"}');

describe("buildTree (spec 2 S13)", () => {
  it(
    "builds the wiki under docs/ with the public base, adds portfolio.json, and hashes the tree",
    async () => {
      const out = await buildTree({
        exp: hostedExport(exp, [hidden]),
        base: "/demo-dev/demo-repo/docs/",
        repoUrl: "https://github.com/demo-dev/demo-repo",
        portfolio,
      });
      const paths = out.files.map((f) => f.path);
      expect(paths).toContain("portfolio.json");
      expect(paths).toContain("docs/index.html");
      expect(paths.some((p) => p.startsWith("docs/wiki/"))).toBe(true);
      expect(paths.some((p) => p.includes(`/wiki/${hidden}/`))).toBe(false);
      const home = new TextDecoder().decode(out.files.find((f) => f.path === "docs/index.html")?.bytes);
      expect(home).toContain("/demo-dev/demo-repo/docs/");
      expect(home).not.toContain(`/wiki/${hidden}/`);
      expect(out.hash).toBe(treeHash(out.files));
    },
    180_000,
  );
});
```

`packages/server/src/routes/preview.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { previewOf } from "../store/drafts.ts";
import { previewRoutes, servePreviewFile } from "./preview.ts";
import { call, form, generatedProject, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let p: { projectId: string; cookie: string; csrf: string };

beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, previewRoutes(deps));
  p = await generatedProject(deps);
});
afterEach(async () => deps.db.close());

describe("servePreviewFile (spec 2 S13)", () => {
  it("rewrites the public base in text files only", async () => {
    await deps.objects.put("previews/p/r1/docs/index.html", '<a href="/demo-dev/demo-repo/docs/wiki/x/">x</a>', "text/html; charset=utf-8");
    await deps.objects.put("previews/p/r1/docs/a.png", new Uint8Array([1, 2]), "image/png");
    const page = await servePreviewFile(deps.objects, "previews/p/r1/", "docs/", "/demo-dev/demo-repo/", "/preview/p/1/");
    expect(String(page?.body)).toContain('href="/preview/p/1/docs/wiki/x/"');
    expect((await servePreviewFile(deps.objects, "previews/p/r1/", "docs/a.png", "/a/", "/b/"))?.body).toEqual(new Uint8Array([1, 2]));
    expect(await servePreviewFile(deps.objects, "previews/p/r1/", "docs/../../x", "/a/", "/b/")).toBeNull();
  });
});

describe("previews (spec 2 §7, S13)", () => {
  it(
    "builds the latest revision's preview, then serves its portfolio and wiki to the owner only",
    async () => {
      await call(app, {
        method: "POST",
        path: `/projects/${p.projectId}/revisions`,
        headers: form(p.cookie, deps.config.origin),
        body: `csrf=${p.csrf}&baseRevision=1&contribution=Mine.`,
      });
      const built = await call(app, {
        method: "POST",
        path: `/projects/${p.projectId}/preview`,
        headers: form(p.cookie, deps.config.origin),
        body: `csrf=${p.csrf}&revision=1`,
      });
      expect(built.status).toBe(303);
      const preview = await previewOf(deps.db, p.projectId, 1);
      expect(preview?.siteHash).toMatch(/^[0-9a-f]{64}$/);
      const home = await call(app, { path: `/preview/${p.projectId}/1/`, headers: { cookie: p.cookie } });
      expect(home.status).toBe(200);
      expect(String(home.body)).toContain("Preview: only you can see this page");
      expect(home.headers?.["cache-control"]).toBe("private, no-store");
      const wiki = await call(app, { path: `/preview/${p.projectId}/1/docs/`, headers: { cookie: p.cookie } });
      expect(wiki.status).toBe(200);
      expect(String(wiki.body)).toContain(`/preview/${p.projectId}/1/docs/`);
      expect((await call(app, { path: `/preview/${p.projectId}/1/` })).status).toBe(404);
    },
    240_000,
  );
});
```

(The first revision in `generatedProject` has an empty contribution; a preview does not need a contribution, only publishing does. Building revision 1 after saving revision 2 above is deliberate: the route builds whatever revision is asked for if it is the latest — change the body to `revision=2` if the route refuses a non-latest revision, which is the stricter and better behaviour; then assert on revision 2.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server/src/render/build.test.ts packages/server/src/routes/preview.test.ts`
Expected: FAIL — cannot resolve `./build.ts`, `./preview.ts`.

- [ ] **Step 4: Write the implementation**

`packages/server/src/render/site-child.ts`:

```ts
import { buildSite } from "@repowiki/site";

/** Builds one site in its own process: buildSite changes the cwd and environment (spec 2 S13). */
const [exportFile, outDir, repoUrl, base] = process.argv.slice(2);
if (exportFile === undefined || outDir === undefined || repoUrl === undefined || base === undefined) {
  process.stderr.write("usage: site-child.ts <export> <out> <repo-url> <base>\n");
  process.exit(2);
}
buildSite(exportFile, outDir, repoUrl, { inflight: false, base }).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
```

`packages/server/src/render/build.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WikiExport } from "@repowiki/core";
import { readTree, type TreeFile, treeHash } from "./tree.ts";

export const SITE_BUILD_TIMEOUT_MS = 5 * 60_000;
const CHILD = fileURLToPath(new URL("./site-child.ts", import.meta.url));

let queue: Promise<unknown> = Promise.resolve();

/** Runs builds one at a time in this process (spec 2 S13). */
export function renderQueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

function runChild(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? tmpdir() },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), SITE_BUILD_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`site build failed: ${stderr.trim().split("\n").at(-1) ?? code}`));
    });
  });
}

/** The tree of a preview or version: the built wiki under docs/, plus portfolio.json (S13). */
export async function buildTree(input: {
  exp: WikiExport;
  base: string;
  repoUrl: string;
  portfolio: Uint8Array;
}): Promise<{ files: TreeFile[]; hash: string }> {
  return renderQueue(async () => {
    const work = mkdtempSync(join(tmpdir(), "repowiki-render-"));
    try {
      const exportFile = join(work, "export.json");
      const outDir = join(work, "site");
      writeFileSync(exportFile, JSON.stringify(input.exp));
      await runChild([exportFile, outDir, input.repoUrl, input.base]);
      const files = [...readTree(outDir, "docs/"), { path: "portfolio.json", bytes: input.portfolio }];
      return { files, hash: treeHash(files) };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}
```

(`buildSite` refuses an output directory that holds the export or is the cwd; `site/` beside `export.json` in a fresh temporary directory satisfies both. It runs Astro, which resolves `packages/site`'s own files from its source location, so the child works from any cwd.)

`packages/server/src/routes/preview.ts`:

```ts
import { WikiExport } from "@repowiki/core";
import { authorize } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import { readForm } from "../http/body.ts";
import type { Reply, Route } from "../http/router.ts";
import { redirect } from "../http/server.ts";
import { checkMutation, currentSession } from "../http/session.ts";
import { assertKey, contentTypeFor, type ObjectStore } from "../objects/store.ts";
import { buildTree } from "../render/build.ts";
import { hostedExport } from "../render/hosted-export.ts";
import { PortfolioData, portfolioData, portfolioHtml } from "../render/portfolio.ts";
import { activeHandle } from "../store/accounts.ts";
import { appendAudit } from "../store/audit.ts";
import { generationById, latestRevision, previewOf, savePreview } from "../store/drafts.ts";
import { ownedProject, pageSession, refusalPage } from "./live.ts";

/** Built-site responses (Pagefind needs WebAssembly; Mermaid sets inline styles). */
export const SITE_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const previewKey = (projectId: string, revision: number) => `previews/${projectId}/r${revision}/`;

const TEXT = /^(text\/|application\/(json|javascript|xml))/;

/**
 * One file of a stored tree; directories serve their index.html. Text files have the public base
 * `from` rewritten to `to`, so a preview's links stay inside the preview (spec 2 S13).
 */
export async function servePreviewFile(
  objects: ObjectStore,
  prefix: string,
  rest: string,
  from: string,
  to: string,
): Promise<{ body: string | Uint8Array; contentType: string } | null> {
  const path = rest === "" || rest.endsWith("/") ? `${rest}index.html` : rest;
  const key = `${prefix}${path}`;
  try {
    assertKey(key);
  } catch {
    return null;
  }
  const object = (await objects.get(key)) ?? (path.includes(".") ? null : await objects.get(`${key}/index.html`));
  if (object === null) return null;
  if (!TEXT.test(object.contentType)) return { body: object.body, contentType: object.contentType };
  return { body: new TextDecoder().decode(object.body).replaceAll(from, to), contentType: object.contentType };
}

export function previewRoutes(deps: Deps): Route[] {
  return [
    {
      method: "POST",
      pattern: "/projects/:id/preview",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request.headers, deps.now());
        const form = await readForm(request.raw);
        checkMutation(deps.config, request.headers, session, form.get("csrf"));
        const project = await ownedProject(deps.db, session, request.params.id ?? "");
        if (project === null) return refusalPage("not-found", pageSession(session));
        const verdict = authorize("preview.read", { now: deps.now(), caller: { kind: "account", account: session.account }, project });
        if (!verdict.ok) return refusalPage(verdict.code, pageSession(session));
        const latest = await latestRevision(deps.db, project.id);
        const revision = Number(form.get("revision"));
        if (latest === null || latest.number !== revision) return refusalPage("stale-revision", pageSession(session), `/projects/${project.id}`);
        const generation = await generationById(deps.db, latest.generationId);
        const stored = generation === null ? null : await deps.objects.get(generation.exportKey);
        if (generation === null || stored === null) return refusalPage("invalid-transition", pageSession(session));
        const exp = WikiExport.parse(JSON.parse(new TextDecoder().decode(stored.body)));
        const repo = await deps.db.query<{ full_name: string }>(
          "SELECT body->>'fullName' AS full_name FROM repositories WHERE github_repo_id = $1",
          [project.githubRepoId],
        );
        const repoFullName = repo[0]?.full_name ?? exp.repo;
        const handle = (await activeHandle(deps.db, session.account.id)) ?? session.account.login;
        const data = latest.overrides.contribution.trim() === ""
          ? { ...portfolioData({ generation, revision: { ...latest, overrides: { ...latest.overrides, contribution: generation.suggestions.contributionDraft || "Not written yet." } }, exp, repoFullName }) }
          : portfolioData({ generation, revision: latest, exp, repoFullName });
        const tree = await buildTree({
          exp: hostedExport(exp, latest.overrides.hiddenFeatureIds),
          base: `/${handle}/${project.slug}/docs/`,
          repoUrl: `https://github.com/${repoFullName}`,
          portfolio: new TextEncoder().encode(JSON.stringify(data)),
        });
        const prefix = previewKey(project.id, revision);
        await deps.objects.delete(await deps.objects.list(prefix));
        for (const file of tree.files) await deps.objects.put(`${prefix}${file.path}`, file.bytes, contentTypeFor(file.path));
        await deps.db.transaction(async (tx) => {
          await savePreview(tx, { projectId: project.id, revision, siteKey: prefix, siteHash: tree.hash, createdAt: deps.now() });
          await appendAudit(tx, {
            id: deps.newId(),
            actor: "author",
            action: "preview.build",
            target: { entity: "project", id: project.id },
            outcome: "allowed",
            createdAt: deps.now(),
          });
        });
        return redirect(`/projects/${project.id}`);
      },
    },
    {
      method: "GET",
      pattern: "/preview/:id/:rev/*",
      handler: async (request): Promise<Reply> => {
        const session = await currentSession(deps.db, deps.config, request.headers, deps.now());
        const notFound: Reply = { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" }, body: "Not found" };
        if (session === null) return notFound;
        const project = await ownedProject(deps.db, session, request.params.id ?? "");
        const revision = Number(request.params.rev);
        const preview = project === null || !Number.isInteger(revision) ? null : await previewOf(deps.db, project.id, revision);
        if (project === null || preview === null) return notFound;
        const rest = request.params["*"] ?? "";
        const headers = { "cache-control": "private, no-store", "content-security-policy": SITE_CSP };
        if (rest === "") {
          const stored = await deps.objects.get(`${preview.siteKey}portfolio.json`);
          if (stored === null) return notFound;
          const data = PortfolioData.parse(JSON.parse(new TextDecoder().decode(stored.body)));
          const body = portfolioHtml(data, { base: `/preview/${project.id}/${revision}/`, publishedAt: null, preview: true });
          return { status: 200, headers: { ...headers, "content-type": "text/html; charset=utf-8" }, body };
        }
        const handle = (await activeHandle(deps.db, session.account.id)) ?? session.account.login;
        const file = await servePreviewFile(deps.objects, preview.siteKey, rest, `/${handle}/${project.slug}/`, `/preview/${project.id}/${revision}/`);
        if (file === null) return notFound;
        return { status: 200, headers: { ...headers, "content-type": file.contentType }, body: file.body };
      },
    },
  ];
}
```

(Ruling to ledger: a revision with no contribution still previews, with the draft or "Not written yet." standing in; publishing refuses it through the Contract, so nothing unreviewed goes live. `createApp` sets its own CSP on HTML replies: make it keep a route's `content-security-policy` when the reply sets one. If `/preview/:id/:rev/*` does not match the bare `/preview/:id/:rev/` path with an empty rest, add a second route for `/preview/:id/:rev` that redirects to the slash form.)

In `docs/superpowers/specs/2026-10-14-repowiki-hosted-slice-design.md`, replace S13's ruling text with:

```markdown
| S13 | Preview | Ruling: the server renders a preview for the latest revision on request: the generation's export with hidden features removed (from `pages`, `history`, every link and See also, and the About article's claims, edges and diagram, as the export schema requires) and People, work in flight and run costs dropped, built by the site package's `buildSite` in a child process with base `/<handle>/<slug>/docs/`, plus `portfolio.json`, the resolved portfolio layer. The tree is stored at `previews/<projectId>/r<rev>/`; its hash is SHA-256 over every file's path and SHA-256, sorted. The portfolio page is rendered from `portfolio.json` per request, so a version's publish date comes from its row while every word the author reviewed is in the hashed tree. The preview is served privately at `/preview/<projectId>/<rev>/` with the public base rewritten in text files; publishing copies the stored bytes unchanged. Builds run one at a time. — `buildSite` needs no network and runs no repository code; the export is RepoWiki's own validated data. — Cost if wrong: a large wiki takes tens of seconds and memory; moving renders onto the job runner is the fix. |
```

Add to `packages/server/src/index.ts`:

```ts
export { buildTree, renderQueue, SITE_BUILD_TIMEOUT_MS } from "./render/build.ts";
export { previewKey, previewRoutes, SITE_CSP, servePreviewFile } from "./routes/preview.ts";
```

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server
pnpm check
git add packages/server docs/superpowers/specs/2026-10-14-repowiki-hosted-slice-design.md
git -c user.email=sean.may101@gmail.com commit -m "feat(server): build the exact site a revision will publish and preview it privately"
```

---

### Task 4: Publish, unpublish, public pages and the profile

**Files:**
- Create: `packages/server/src/routes/publish.ts`, `packages/server/src/routes/publish.test.ts`
- Create: `packages/server/src/routes/public.ts`, `packages/server/src/routes/public.test.ts`, `packages/server/src/pages/profile.ts`
- Create: `packages/server/src/routes/reserved.test.ts`
- Modify: `packages/hosted/src/urls.ts` (reserve `internal`, `llm`, `preview`, `projects`), `packages/hosted/src/urls.test.ts`, `docs/superpowers/specs/2026-10-14-repowiki-hosted-contract-design.md` (§9 reserved list), `packages/server/src/index.ts`

**Interfaces:**
- Consumes: Tasks 1–3; hosted `publish`, `unpublish`, `authorize`, `lookupHandle` (through M14a's `resolveHandle`), `isReservedHandle`, `profileUrl`; M14a `accountById`, `resolveHandle`; `projectsOf`.
- Produces: `publishRoutes(deps)` (`POST /projects/:id/publish`, `POST /projects/:id/unpublish`); `publicRoutes(deps)` (`GET /:handle`, `GET /:handle/:slug`, `GET /:handle/:slug/*`), registered last; `profilePage(input)`; `copyTree(objects, from, to)`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-publish
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/hosted/src/urls.test.ts`:

```ts
describe("app paths are reserved handles (spec 2 §7)", () => {
  it("reserves every top-level path the server routes", () => {
    for (const name of ["internal", "llm", "preview", "projects"]) expect(isReservedHandle(name)).toBe(true);
  });
});
```

`packages/server/src/routes/reserved.test.ts`:

```ts
import { isReservedHandle } from "@repowiki/hosted";
import { describe, expect, it } from "vitest";
import { authRoutes } from "./auth.ts";
import { draftRoutes } from "./drafts.ts";
import { internalRoutes } from "./internal.ts";
import { llmRoutes } from "./llm.ts";
import { previewRoutes } from "./preview.ts";
import { projectRoutes } from "./projects.ts";
import { publishRoutes } from "./publish.ts";
import { testDeps } from "./test-app.ts";

describe("no handle can shadow an app route (Contract §9)", () => {
  it("every app route's first segment is a reserved handle", async () => {
    const deps = await testDeps();
    const routes = [authRoutes, projectRoutes, draftRoutes, internalRoutes, llmRoutes, previewRoutes, publishRoutes].flatMap((r) => r(deps));
    const first = new Set(routes.map((r) => r.pattern.split("/")[1] ?? "").filter((s) => s !== "" && !s.startsWith(":")));
    expect([...first].filter((s) => !isReservedHandle(s))).toEqual([]);
    await deps.db.close();
  });
});
```

(Use the route factory names M14a–c actually export; add any app route module that exists, such as a health route.)

`packages/server/src/routes/publish.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { previewOf, versionOf } from "../store/drafts.ts";
import { projectById } from "../store/projects.ts";
import { draftRoutes } from "./drafts.ts";
import { previewRoutes } from "./preview.ts";
import { publishRoutes } from "./publish.ts";
import { call, form, generatedProject, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let p: { projectId: string; cookie: string; csrf: string };
const post = (path: string, body: string) =>
  call(app, { method: "POST", path, headers: form(p.cookie, deps.config.origin), body: `csrf=${p.csrf}&${body}` });

async function ready(): Promise<string> {
  await post(`/projects/${p.projectId}/revisions`, "baseRevision=1&contribution=Mine.");
  await post(`/projects/${p.projectId}/review`, "revision=2&attest=yes");
  await post(`/projects/${p.projectId}/preview`, "revision=2");
  return (await previewOf(deps.db, p.projectId, 2))?.siteHash ?? "";
}

beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, [...draftRoutes(deps), ...previewRoutes(deps), ...publishRoutes(deps)]);
  p = await generatedProject(deps);
});
afterEach(async () => deps.db.close());

describe("publish (Contract §6.4)", () => {
  it(
    "copies the previewed tree unchanged to version 1 and marks the project published",
    async () => {
      const hash = await ready();
      const reply = await post(`/projects/${p.projectId}/publish`, `revision=2&expectedVersion=0&previewHash=${hash}`);
      expect(reply.status).toBe(303);
      expect(await projectById(deps.db, p.projectId)).toMatchObject({ state: "published", currentVersion: 1 });
      const version = await versionOf(deps.db, p.projectId, 1);
      expect(version).toMatchObject({ revision: 2, siteHash: hash, siteKey: `sites/${p.projectId}/v1/` });
      const copied = await deps.objects.list(`sites/${p.projectId}/v1/`);
      const previewed = await deps.objects.list(`previews/${p.projectId}/r2/`);
      expect(copied.length).toBe(previewed.length);
      const again = await post(`/projects/${p.projectId}/publish`, `revision=2&expectedVersion=0&previewHash=${hash}`);
      expect(again.status).toBe(303);
      expect((await projectById(deps.db, p.projectId))?.currentVersion).toBe(1);
    },
    240_000,
  );

  it(
    "refuses a preview hash the author did not see, and an unreviewed revision",
    async () => {
      await ready();
      expect((await post(`/projects/${p.projectId}/publish`, `revision=2&expectedVersion=0&previewHash=${"0".repeat(64)}`)).status).toBe(409);
      await post(`/projects/${p.projectId}/revisions`, "baseRevision=2&contribution=Changed.");
      const hash = (await previewOf(deps.db, p.projectId, 2))?.siteHash ?? "";
      expect((await post(`/projects/${p.projectId}/publish`, `revision=2&expectedVersion=0&previewHash=${hash}`)).status).toBe(409);
      expect((await projectById(deps.db, p.projectId))?.state).toBe("draft");
    },
    240_000,
  );

  it(
    "unpublishes at once",
    async () => {
      const hash = await ready();
      await post(`/projects/${p.projectId}/publish`, `revision=2&expectedVersion=0&previewHash=${hash}`);
      expect((await post(`/projects/${p.projectId}/unpublish`, "")).status).toBe(303);
      expect(await projectById(deps.db, p.projectId)).toMatchObject({ state: "withdrawn", withdrawReason: "author" });
    },
    240_000,
  );
});
```

(Use `REFUSALS[code].status` for the 409s if the table gives `preview-mismatch` or `stale-revision` another status.)

`packages/server/src/routes/public.test.ts`:

```ts
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { previewOf } from "../store/drafts.ts";
import { draftRoutes } from "./drafts.ts";
import { previewRoutes } from "./preview.ts";
import { publicRoutes } from "./public.ts";
import { publishRoutes } from "./publish.ts";
import { call, form, generatedProject, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let p: { projectId: string; cookie: string; csrf: string };
const post = (path: string, body: string) =>
  call(app, { method: "POST", path, headers: form(p.cookie, deps.config.origin), body: `csrf=${p.csrf}&${body}` });

beforeAll(async () => {
  deps = await testDeps();
  app = createApp(deps, [...draftRoutes(deps), ...previewRoutes(deps), ...publishRoutes(deps), ...publicRoutes(deps)]);
  p = await generatedProject(deps);
  await post(`/projects/${p.projectId}/revisions`, "baseRevision=1&contribution=Mine.");
  await post(`/projects/${p.projectId}/review`, "revision=2&attest=yes");
  await post(`/projects/${p.projectId}/preview`, "revision=2");
  const hash = (await previewOf(deps.db, p.projectId, 2))?.siteHash ?? "";
  await post(`/projects/${p.projectId}/publish`, `revision=2&expectedVersion=0&previewHash=${hash}`);
}, 240_000);
afterEach(() => undefined);

describe("public pages (spec 2 S14; Contract §9)", () => {
  it("serves the portfolio page signed out, cached for 60 seconds", async () => {
    const reply = await call(app, { path: "/demo-dev/demo-repo" });
    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain("Mine.");
    expect(String(reply.body)).toContain("Author-reviewed");
    expect(String(reply.body)).toMatch(/Published 20\d\d-\d\d-\d\d/);
    expect(reply.headers?.["cache-control"]).toBe("public, max-age=60");
  });

  it("serves the published wiki's files and 404s for anything else", async () => {
    const home = await call(app, { path: "/demo-dev/demo-repo/docs/" });
    expect(home.status).toBe(200);
    expect(home.headers?.["content-security-policy"]).toContain("wasm-unsafe-eval");
    expect((await call(app, { path: "/demo-dev/demo-repo/docs/nope.html" })).status).toBe(404);
    expect((await call(app, { path: "/demo-dev/demo-repo/portfolio.json" })).status).toBe(404);
    expect((await call(app, { path: "/demo-dev/nope" })).status).toBe(404);
  });

  it("lists published projects on the profile", async () => {
    const reply = await call(app, { path: "/demo-dev" });
    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain('href="/demo-dev/demo-repo"');
  });

  it("answers 410 for a withdrawn page and drops it from the profile", async () => {
    await post(`/projects/${p.projectId}/unpublish`, "");
    expect((await call(app, { path: "/demo-dev/demo-repo" })).status).toBe(410);
    expect((await call(app, { path: "/demo-dev/demo-repo/docs/" })).status).toBe(410);
    expect(String((await call(app, { path: "/demo-dev" })).body)).not.toContain('href="/demo-dev/demo-repo"');
    await deps.db.close();
  });

  it("is a 404 for an unknown handle", async () => {
    // runs after close in file order only if reordered; keep it before the 410 test if it fails
  });
});
```

(Delete the empty last test, or move an unknown-handle check — `GET /nobody-here` → 404 — above the withdrawal test.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/hosted/src/urls.test.ts packages/server/src/routes/publish.test.ts packages/server/src/routes/public.test.ts packages/server/src/routes/reserved.test.ts`
Expected: FAIL — the four app paths are not reserved; cannot resolve `./publish.ts`, `./public.ts`.

- [ ] **Step 4: Write the implementation**

In `packages/hosted/src/urls.ts`, add `"internal"`, `"llm"`, `"preview"` and `"projects"` to `RESERVED_HANDLES` (alphabetical with the rest). In the Contract spec §9's reserved list, add the same four names.

`packages/server/src/routes/publish.ts`:

```ts
import { authorize, publish, unpublish } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { readForm } from "../http/body.ts";
import type { Route } from "../http/router.ts";
import { redirect } from "../http/server.ts";
import { checkMutation, currentSession } from "../http/session.ts";
import { contentTypeFor, type ObjectStore } from "../objects/store.ts";
import { appendAudit } from "../store/audit.ts";
import { latestRevision, previewOf, reviewOf, saveVersion, versionOf } from "../store/drafts.ts";
import { saveProject, usageFor } from "../store/projects.ts";
import { liveEligibility, ownedProject, pageSession, refusalPage } from "./live.ts";

/** Copy a stored tree byte for byte (Contract §6.4: publish promotes the exact preview). */
export async function copyTree(objects: ObjectStore, from: string, to: string): Promise<number> {
  const keys = await objects.list(from);
  for (const key of keys) {
    const object = await objects.get(key);
    if (object === null) throw new Error(`preview file vanished: ${key}`);
    await objects.put(`${to}${key.slice(from.length)}`, object.body, object.contentType || contentTypeFor(key));
  }
  return keys.length;
}

async function audit(tx: Queryable, deps: Deps, action: string, id: string, outcome: string) {
  await appendAudit(tx, { id: deps.newId(), actor: "author", action, target: { entity: "project", id }, outcome: outcome as never, createdAt: deps.now() });
}

export function publishRoutes(deps: Deps): Route[] {
  return [
    {
      method: "POST",
      pattern: "/projects/:id/publish",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request.headers, deps.now());
        const form = await readForm(request.raw);
        checkMutation(deps.config, request.headers, session, form.get("csrf"));
        const id = request.params.id ?? "";
        const owned = await ownedProject(deps.db, session, id);
        if (owned === null) return refusalPage("not-found", pageSession(session));
        const live = await liveEligibility(deps, session, owned.githubRepoId);
        if (!live.ok) return live.reply;
        const revision = Number(form.get("revision"));
        const expectedVersion = Number(form.get("expectedVersion"));
        const previewHash = String(form.get("previewHash") ?? "");
        const result = await deps.db.transaction(async (tx) => {
          const project = await ownedProject(tx, session, id, true);
          if (project === null) return { ok: false as const, code: "not-found" as const };
          const usage = await usageFor(tx, session.account.id, deps.now());
          const verdict = authorize("project.publish", { now: deps.now(), caller: { kind: "account", account: session.account }, project, facts: live.facts, usage });
          if (!verdict.ok) return verdict;
          const latest = await latestRevision(tx, project.id);
          if (latest === null) return { ok: false as const, code: "invalid-transition" as const };
          const published = publish({
            project,
            latest,
            review: Number.isInteger(revision) ? await reviewOf(tx, project.id, revision) : null,
            preview: Number.isInteger(revision) ? await previewOf(tx, project.id, revision) : null,
            current: project.currentVersion === 0 ? null : await versionOf(tx, project.id, project.currentVersion),
            revision,
            expectedVersion,
            previewHash,
            authorization: live.facts,
            now: deps.now(),
          });
          if (!published.ok) return published;
          if (!published.value.created) return { ok: true as const };
          const preview = await previewOf(tx, project.id, revision);
          if (preview === null) return { ok: false as const, code: "preview-mismatch" as const };
          // A version key is consumed only when this transaction commits; a failed commit leaves
          // files under a key nobody serves, which the next publish of that number overwrites.
          await copyTree(deps.objects, preview.siteKey, published.value.version.siteKey);
          await saveVersion(tx, published.value.version);
          await saveProject(tx, published.value.project);
          await audit(tx, deps, "project.publish", project.id, "allowed");
          return { ok: true as const };
        });
        if (!result.ok) {
          await deps.db.transaction((tx) => audit(tx, deps, "project.publish", id, result.code));
          return refusalPage(result.code, pageSession(session), `/projects/${id}`);
        }
        return redirect(`/projects/${id}`);
      },
    },
    {
      method: "POST",
      pattern: "/projects/:id/unpublish",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request.headers, deps.now());
        const form = await readForm(request.raw);
        checkMutation(deps.config, request.headers, session, form.get("csrf"));
        const id = request.params.id ?? "";
        const result = await deps.db.transaction(async (tx) => {
          const project = await ownedProject(tx, session, id, true);
          if (project === null) return { ok: false as const, code: "not-found" as const };
          const verdict = authorize("project.unpublish", { now: deps.now(), caller: { kind: "account", account: session.account }, project });
          if (!verdict.ok) return verdict;
          const next = unpublish(project, deps.now());
          if (!next.ok) return next;
          await saveProject(tx, next.value);
          await audit(tx, deps, "project.unpublish", project.id, "allowed");
          return { ok: true as const };
        });
        if (!result.ok) return refusalPage(result.code, pageSession(session), `/projects/${id}`);
        return redirect(`/projects/${id}`);
      },
    },
  ];
}
```

(The tree copy happens inside the transaction's callback so the version row is written only after its files exist; `pg` keeps the transaction open across the awaits. For a large wiki this holds the project row lock for the copy's duration, which only blocks that author's own edits.)

`packages/server/src/pages/profile.ts`:

```ts
import { escapeHtml as e } from "./layout.ts";

export interface ProfileEntry {
  slug: string;
  title: string;
  tagline: string;
  publishedAt: string;
}

/** `/<handle>`: the author's published projects (Contract §9), newest first. */
export function profilePage(input: { handle: string; displayName: string; entries: readonly ProfileEntry[] }): string {
  const cards = input.entries
    .map((p) => `<li><a href="/${e(input.handle)}/${e(p.slug)}"><strong>${e(p.title)}</strong></a><p>${e(p.tagline)}</p><p class="meta">Published ${e(p.publishedAt.slice(0, 10))}</p></li>`)
    .join("");
  const style = `:root{color-scheme:light dark;--bg:#fdfdfb;--fg:#1d2125;--muted:#5a6470;--accent:#1f5fa8}@media(prefers-color-scheme:dark){:root{--bg:#111417;--fg:#e8ecef;--muted:#9aa5b0;--accent:#7fb2ec}}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 Georgia,serif}main{max-width:46rem;margin:0 auto;padding:2rem max(16px,env(safe-area-inset-left)) 4rem}a{color:var(--accent)}ul{list-style:none;padding:0;display:grid;gap:1.5rem}.meta{font:14px system-ui,sans-serif;color:var(--muted)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(input.displayName)}</title><style>${style}</style></head><body><main><h1>${e(input.displayName)}</h1><p class="meta">@${e(input.handle)} · project pages made with RepoWiki</p>${cards ? `<ul>${cards}</ul>` : "<p>No published projects.</p>"}</main></body></html>`;
}
```

`packages/server/src/routes/public.ts`:

```ts
import { authorize, type Project } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Reply, Route } from "../http/router.ts";
import { profilePage } from "../pages/profile.ts";
import { PortfolioData, portfolioHtml } from "../render/portfolio.ts";
import { accountById, resolveHandle } from "../store/accounts.ts";
import { versionOf } from "../store/drafts.ts";
import { projectsOf } from "../store/projects.ts";
import { SITE_CSP, servePreviewFile } from "./preview.ts";

const PUBLIC = { "cache-control": "public, max-age=60" };
const text = (status: number, body: string): Reply => ({
  status,
  headers: { ...PUBLIC, "content-type": "text/plain; charset=utf-8" },
  body,
});

/** Signed-out reads (spec 2 S14), registered after every app route. */
export function publicRoutes(deps: Deps): Route[] {
  /** The handle's account, a redirect, or the reply for a gone or missing handle. */
  async function owner(handle: string, rest: string) {
    const found = await resolveHandle(deps.db, handle.toLowerCase());
    if (found.kind === "redirect") return { reply: { status: 301, headers: { ...PUBLIC, location: `/${found.to}${rest}` } } as Reply };
    if (found.kind === "gone") return { reply: text(410, "This page was removed.") };
    if (found.kind === "missing") return { reply: text(404, "Not found") };
    const account = await accountById(deps.db, found.accountId);
    if (account === null) return { reply: text(404, "Not found") };
    return { account, handle: found.handle };
  }

  async function published(handle: string, slug: string, rest: string) {
    const who = await owner(handle, `/${slug}${rest}`);
    if ("reply" in who) return who;
    const project = (await projectsOf(deps.db, who.account.id)).find((p) => p.slug === slug);
    if (project === undefined) return { reply: text(404, "Not found") };
    const verdict = authorize("public.read", { now: deps.now(), caller: { kind: "anonymous" }, project, ownerStatus: who.account.status });
    if (!verdict.ok) return { reply: verdict.code === "withdrawn" ? text(410, "The author withdrew this page.") : text(404, "Not found") };
    const version = await versionOf(deps.db, project.id, project.currentVersion);
    if (version === null) return { reply: text(404, "Not found") };
    return { project: project as Project, version, handle: who.handle };
  }

  return [
    {
      method: "GET",
      pattern: "/:handle",
      handler: async (request) => {
        const who = await owner(request.params.handle ?? "", "");
        if ("reply" in who) return who.reply;
        if (who.account.status !== "active") return text(410, "This page was removed.");
        const entries = [];
        for (const project of await projectsOf(deps.db, who.account.id)) {
          if (project.state !== "published") continue;
          const version = await versionOf(deps.db, project.id, project.currentVersion);
          const stored = version === null ? null : await deps.objects.get(`${version.siteKey}portfolio.json`);
          if (version === null || stored === null) continue;
          const data = PortfolioData.parse(JSON.parse(new TextDecoder().decode(stored.body)));
          entries.push({ slug: project.slug, title: data.title, tagline: data.tagline, publishedAt: version.publishedAt });
        }
        entries.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
        return {
          status: 200,
          headers: { ...PUBLIC, "content-type": "text/html; charset=utf-8" },
          body: profilePage({ handle: who.handle, displayName: who.account.displayName ?? who.handle, entries }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/:handle/:slug",
      handler: async (request) => {
        const found = await published(request.params.handle ?? "", request.params.slug ?? "", "");
        if ("reply" in found) return found.reply;
        const stored = await deps.objects.get(`${found.version.siteKey}portfolio.json`);
        if (stored === null) return text(404, "Not found");
        const data = PortfolioData.parse(JSON.parse(new TextDecoder().decode(stored.body)));
        return {
          status: 200,
          headers: { ...PUBLIC, "content-type": "text/html; charset=utf-8", "content-security-policy": SITE_CSP },
          body: portfolioHtml(data, { base: `/${found.handle}/${found.project.slug}/`, publishedAt: found.version.publishedAt, preview: false }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/:handle/:slug/*",
      handler: async (request) => {
        const rest = request.params["*"] ?? "";
        if (rest === "") return { status: 301, headers: { ...PUBLIC, location: `/${request.params.handle}/${request.params.slug}` } };
        const found = await published(request.params.handle ?? "", request.params.slug ?? "", `/${rest}`);
        if ("reply" in found) return found.reply;
        if (!rest.startsWith("docs/")) return text(404, "Not found");
        const file = await servePreviewFile(deps.objects, found.version.siteKey, rest, "", "");
        if (file === null) return text(404, "Not found");
        return { status: 200, headers: { ...PUBLIC, "content-type": file.contentType, "content-security-policy": SITE_CSP }, body: file.body };
      },
    },
  ];
}
```

(`servePreviewFile` with an empty `from` must not rewrite: guard `if (from === "")` before `replaceAll`, since `replaceAll("", "")` is a no-op but cheap to skip. Check the field names `account.status` and `account.displayName` against the Contract's `Account` schema. A request for `/<handle>/<slug>/` with a trailing slash reaches the `*` route with an empty rest and is redirected to the canonical URL.)

Wire the routes in `packages/server/src/app.ts` or `main.ts` (wherever the route lists are joined) with `publicRoutes` last.

Add to `packages/server/src/index.ts`:

```ts
export { profilePage, type ProfileEntry } from "./pages/profile.ts";
export { publicRoutes } from "./routes/public.ts";
export { copyTree, publishRoutes } from "./routes/publish.ts";
```

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/hosted packages/server
pnpm check
git add packages/hosted packages/server docs/superpowers/specs/2026-10-14-repowiki-hosted-contract-design.md
git -c user.email=sean.may101@gmail.com commit -m "feat(server): publish the previewed tree, unpublish, and serve project pages and profiles"
```
