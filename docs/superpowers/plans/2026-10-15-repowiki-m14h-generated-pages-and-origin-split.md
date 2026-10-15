# M14h + M14i Generated-Only Pages and the Origin Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project page is always the generated content, reviewed and published by its author, with every wiki page public (M14h). Public pages live on `PUBLIC_ORIGIN` (`https://repowiki.app`), the signed-in app on `APP_ORIGIN` (`https://app.repowiki.app`), and previews on the pages origin behind short-lived capability URLs (M14i).

**Architecture:** `@repowiki/hosted` gains `generatedContent`, the one pure function that turns a generation (suggestions, facts), its export and the author's name into a revision's `content`; the server calls it when a worker succeeds. Revisions lose overrides and flags; reviews move to attestation 2. The server's listener dispatches by `Host` to an app and a pages app built from separate route sets; previews are served by the pages app at `/_preview/<token>/` from a `preview_tokens` table.

**Tech Stack:** TypeScript, zod, Postgres SQL migrations (PGlite in tests), vitest.

**Owner's rulings (2026-10-15):** recorded in ADR-0012, which this plan implements.

## Global Constraints

- No manual overrides and no hidden features anywhere: schema, store, routes, pages, export filtering.
- `@repowiki/hosted` stays pure (core and zod only; no clock, randomness or I/O).
- Shipped migrations are never edited; 0005–0007 are appended and must load rows written by M14g local runs (`hosted:local`).
- Tests never call the network or a model. Never log a token or secret. Token checks are constant-time; SQL is parameterized.
- The pages host never sets a cookie and ignores any `Cookie` header; the session cookie exists only on the app host.
- `INTERNAL_PORT` and `INTERNAL_URL` are unchanged.
- Stacked branches, each under ~300 changed lines (lockfiles, fixtures and cassettes excluded), in this order: `m14/generated-docs`, `m14/generated-content`, `m14/no-hidden-features`, `m14/review-v2`, `m14/generated-revisions`, `m14/app-origin`, `m14/preview-links`.
- Scope note (owner, later on 2026-10-15): the project page will be replaced by a biography profile in a follow-up milestone. No further work on highlight blurbs or the page's layout; the contribution stays one callable function (`generatedContribution`).
- `pnpm check` passes before every commit; commits use `git -c user.email=sean.may101@gmail.com commit`.

## Review Focus

1. **Labelling.** A generated contribution always carries "Generated from the git history at `<sha>`; not written by the author."; a version published before this change (no `contributionBy` in its `portfolio.json`) is never labelled generated.
2. **Documentation-like features** never lead the highlights or the "most of all" clause, and still appear in the wiki and facts.
3. **Stored rows from M14g.** After migrations 0005–0007 every revision parses, no version 1 review remains, and no preview of a rewritten revision can be published.
4. **Cookies by host.** A pages-host request carrying the session cookie is served exactly as a signed-out one; no pages-host reply has `Set-Cookie`.
5. **Preview tokens.** Only the SHA-256 is stored; an expired, unknown or other-revision token is 404; responses are `no-store`, `noindex`, `no-referrer`; the old `/preview/:id/:rev/` route is gone from both hosts.
6. **Production configuration** refuses a missing `APP_ORIGIN` or `PUBLIC_ORIGIN`, equal hosts, and any `*.fly.dev` origin.

---

### Task 1: ADR-0012, this plan and the spec notes

**Files:**
- Create: `docs/decisions/0012-generated-pages-and-own-origin.md`, this plan
- Modify: `docs/superpowers/specs/2026-10-14-repowiki-hosted-contract-design.md` (D2, D6, §5, §6.3, §6.4, §7.1, §8, §11), `docs/superpowers/specs/2026-10-14-repowiki-hosted-slice-design.md` (S6, S13, S14, §7, §14): one "Amended by ADR-0012" line each

- [ ] **Step 1:** `git switch -c m14/generated-docs`
- [ ] **Step 2:** Write the ADR, plan and notes; `pnpm check`; commit `docs(hosted): record generated-only pages and the origin split (ADR-0012)`

---

### Task 2: Generated content as one pure function

**Files:**
- Create: `packages/hosted/src/generated.ts`, `packages/hosted/src/generated.test.ts`
- Modify: `packages/hosted/src/content.ts` (`PortfolioContent`), `packages/hosted/src/index.ts`
- Modify: `packages/worker/src/suggestions.ts` (`plainWords` and the clause cut move to hosted; `taglineFrom` calls `firstClause(…, 90)`; the prompt asks for the third person)

**Interfaces:**
- Produces: `plainWords(markdown, max)`, `firstClause(text, max)`, `isDocumentation(page)`, `generatedHighlights(generation, exp)`, `contributionParagraph(name, facts, titles, docs)`, `generatedContent({ suggestions, facts, exp, authorName })` → `PortfolioContent`.

```ts
export const PortfolioContent = z.strictObject({
  tagline: plainText(90),
  summary: plainText(900),
  contribution: plainText(1200).refine((t) => t.trim() !== "", "empty contribution"),
  highlights: z.array(z.strictObject({ featureId: FeatureId, blurb: plainText(140) })).max(4),
});
```

- [ ] **Step 1:** branch `m14/generated-content`
- [ ] **Step 2: failing tests** — `firstClause` keeps the tagline cases of `suggestions.test.ts` at 90 and cuts a lead at 140; `isDocumentation` by prose-only languages and by name, never for a page with a code language and a plain title; `generatedHighlights` orders by the author's commits, keeps candidate order on ties, drops documentation-like and page-less candidates, takes 4, blurbs from the lead; `contributionParagraph` gives the ADR's sentence for a made-up author, drops the lines clause with no lines, words the zero-commit case, skips documentation-like features; `generatedContent` uses the model draft when non-empty and the paragraph otherwise, and passes `PortfolioContent`.
- [ ] **Step 3:** run `node node_modules/vitest/vitest.mjs run packages/hosted/src/generated.test.ts` — FAIL (module missing)
- [ ] **Step 4:** implement; worker imports `plainWords`/`firstClause` from hosted
- [ ] **Step 5:** `pnpm check`; commit `feat(hosted): generate a page's content from its generation and export`

---

### Task 3: Every page is public

**Files:**
- Modify: `packages/hosted/src/content.ts` (`Overrides` without `hiddenFeatureIds`), `entities.ts` (`RevisionFlag` without `hidden-missing`), `revisions.ts`, tests
- Modify: `packages/server/src/render/hosted-export.ts` (no hidden filtering; signature `hostedExport(exp)`), `render/portfolio.ts`, `routes/drafts.ts`, `routes/preview.ts`, `pages/project.ts`, tests, `e2e.test.ts`
- Create: `packages/server/src/db/migrations/0005-no-hidden-features.sql`, a migration test in `packages/server/src/store/drafts.test.ts`

- [ ] **Step 1:** branch `m14/no-hidden-features`
- [ ] **Step 2: failing tests** — `Overrides` refuses `hiddenFeatureIds`; `hostedExport` keeps every page, link and diagram line and still drops People, work in flight, runs and Wikipedia; the editor has no Hide column; a revision stored with `hiddenFeatureIds: ["x"]` and a `hidden-missing:x` flag loads after migrating, and its review and preview are gone.
- [ ] **Step 3:** run them — FAIL
- [ ] **Step 4:** implement; migration 0005 (SQL below) runs inside `migrate`'s transaction
- [ ] **Step 5:** `pnpm check`; commit `feat(server): publish every wiki page, with no hidden features`

```sql
DELETE FROM reviews r USING revisions v WHERE r.project_id = v.project_id AND r.revision = v.number
  AND jsonb_array_length(coalesce(v.body->'overrides'->'hiddenFeatureIds', '[]')) > 0;
DELETE FROM previews p USING revisions v WHERE … (same condition);
UPDATE revisions SET body = jsonb_set(body #- '{overrides,hiddenFeatureIds}', '{flags}', <flags without hidden-missing:*>)
  WHERE body->'overrides' ? 'hiddenFeatureIds';
```

---

### Task 3b: Attestation 2

**Files:** `packages/hosted/src/content.ts` (`ATTESTATIONS[2]`, `ATTESTATION_VERSION = 2`), `entities.ts` (`Review.attestationVersion: 2`), `packages/server/src/pages/project.ts`, `packages/server/src/db/migrations/0006-review-attestation-2.sql` (deletes version 1 reviews), tests.

- [ ] branch `m14/review-v2`; failing tests (the wording, a v1 review refused, a stored v1 review gone after 0006); implement; `pnpm check`; commit `feat(hosted): review attestation 2, for an author approving generated content`

---

### Task 4: Generated revisions and the review step

**Files:**
- Modify: `packages/hosted/src/content.ts` (drop `Overrides`, `EMPTY_OVERRIDES`; `entities.ts` (`DraftRevision { projectId, number, generationId, content, createdAt }`, drop `RevisionFlag`, drop `draft.save`), `revisions.ts` (`firstRevision(project, generation, content, now)`, `refreshRevision(project, latest, generation, content, now)`, `reviewRevision(latest, revision, now)`; no `saveRevision`), `publish.ts`, `refusals.ts` (drop `needs-review-flags`, `contribution-missing`), `policy.ts`, tests and fixtures
- Modify: `packages/server/src/routes/internal.ts` (succeed reads the export and the account, calls `generatedContent`), `routes/drafts.ts` (no `POST /projects/:id/revisions`), `pages/project.ts` (read-only content, attestation 2), `routes/preview.ts`, `render/portfolio.ts` (`PortfolioData.contributionBy: "author" | "generated"`, default `"author"`; the label), tests, `e2e.test.ts`, `local.e2e.test.ts`
- Create: `packages/server/src/db/migrations/0007-generated-revisions.sql`

- [ ] **Step 1:** branch `m14/generated-revisions`
- [ ] **Step 2: failing tests** — `firstRevision` stores the given content; a refresh carries nothing forward; `reviewRevision` records version 2; `publish` needs only latest, review, version and preview; the refusal set has 28 codes; succeed stores `generatedContent`'s result (the deterministic paragraph for an empty draft); the project page shows the content read-only with no form fields but the review and preview controls; the public page shows the label; a stored `portfolio.json` without `contributionBy` renders unlabelled; a legacy revision (overrides, flags, review, preview) loads after 0007 with content from its generation, and its review and preview are gone.
- [ ] **Step 3:** run them — FAIL
- [ ] **Step 4:** implement
- [ ] **Step 5:** `pnpm check`; commit `feat(server): make every project page the generated content, reviewed by its author`

---

### Task 5: Two origins routed by Host

**Files:**
- Modify: `packages/server/src/config.ts` (`appOrigin`, `publicOrigin` replace `origin`), `app.ts` (`createApp(deps, routes, { host })`; callback on `appOrigin`), `wiring.ts` (`routeSets` → `{ app, pages, worker }`; `byHost`), `http/session.ts` (`appOrigin`), `routes/drafts.ts` (public URL on `publicOrigin`), `render/portfolio.ts` and `pages/profile.ts` ("Made with RepoWiki" → `appOrigin`), `main.ts` (prints both URLs), `deploy/fly.server.toml`, tests, `test-browser.ts` (one jar per host)

**Interfaces:**
- Produces: `Config.appOrigin`, `Config.publicOrigin`; `byHost(config, { app, pages })` → `App`; `PAGES_CSP`, `appCsp(config)`.

- [ ] **Step 1:** branch `m14/app-origin`
- [ ] **Step 2: failing tests** — production refuses missing `APP_ORIGIN`, equal hosts, `https://x.fly.dev`; development defaults to `127.0.0.1` and `localhost` and refuses equal hosts; `byHost` sends the pages host only public routes (dashboard there is 404, profile on the app host is 404, unknown host 404, pages `/` 302 to the app); a pages request with the session cookie renders signed out and no pages reply sets a cookie; the CSPs differ by host; the e2e and local journeys use both hosts.
- [ ] **Step 3:** run them — FAIL
- [ ] **Step 4:** implement
- [ ] **Step 5:** `pnpm check`; commit `feat(server): serve public pages on their own origin, routed by host`

---

### Task 6: Previews on the pages origin at capability URLs

**Files:**
- Create: `packages/server/src/db/migrations/0008-preview-tokens.sql`, `packages/server/src/store/preview-tokens.ts`, its test
- Modify: `packages/server/src/routes/preview.ts` (`POST /projects/:id/preview/open`; `previewPageRoutes` for `/_preview/:token/*`; the old route removed), `pages/project.ts` (the open form), `render/portfolio.ts` (banner wording), `wiring.ts`, `packages/hosted/src/urls.ts` (`_preview` reserved), tests, `e2e.test.ts`

**Interfaces:**
- Produces: `PREVIEW_TOKEN_MS = 3_600_000`; `mintPreviewToken(q, { projectId, revision }, now)` → token; `previewByToken(q, token, now)` → `{ projectId, revision } | null`.

- [ ] **Step 1:** branch `m14/preview-links`
- [ ] **Step 2: failing tests** — minting stores only the hash and answers 303 to `PUBLIC_ORIGIN/_preview/<token>/`; another account's project is 404; the pages host serves the portfolio and wiki with the base rewritten, `no-store`, `noindex`, `no-referrer` and no cookie; an expired or unknown token is 404; `/preview/:id/:rev/` is 404 on both hosts; `_preview` is reserved.
- [ ] **Step 3:** run them — FAIL
- [ ] **Step 4:** implement
- [ ] **Step 5:** `pnpm check`; commit `feat(server): serve previews on the pages origin behind expiring links`

## After the plan: the runbook (controller)

DNS and certificates for `repowiki.app` and `app.repowiki.app` (both to the Fly app; `fly certs add` each), the GitHub OAuth app's homepage and callback URL moved to `https://app.repowiki.app/auth/github/callback`, `APP_ORIGIN` and `PUBLIC_ORIGIN` set; the Fly health check is `GET /healthz`, which needs no hostname.
