# M14j The Biography Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An author's public presence is two kinds of page: a Wikipedia-style biography at `PUBLIC_ORIGIN/<handle>`, generated from their published projects, and each project's wiki at `PUBLIC_ORIGIN/<handle>/<slug>/`. The separate project page goes.

**Architecture:** `@repowiki/hosted` gains `BiographyEntry` (one project's stored facts and text), `biographyEntry` (made from a generation, its revision and its export) and `biography` (the article as structured, cited sentences: pure templates, no model). The server stores the entry as `entry.json` beside the wiki in every preview and version tree, renders the biography per request from the published entries (`render/biography.ts`), serves its style sheet and the account's avatar from the pages origin, and builds each wiki with base `/<handle>/<slug>/` and an `author` link back.

**Tech Stack:** TypeScript, zod, Postgres SQL migrations (PGlite in tests), Astro (the site), vitest.

**Owner's rulings (2026-10-15):** recorded in ADR-0013, which this plan implements.

## Global Constraints

- `@repowiki/hosted` stays pure (core and zod only; no clock, randomness or I/O).
- Every rendered string goes through `escapeHtml`, generated text and repository names included.
- The templates never use a pronoun (he, she, they, him, his, her, hers, their, them).
- Pages load nothing from GitHub: the avatar is stored and served from the pages origin.
- Shipped migrations are never edited; 0009 and 0010 are appended.
- Tests never call the network or a model. Never log a token or secret.
- Stacked branches, each near ~300 changed lines (lockfiles, fixtures and cassettes excluded), in this order: `m14/bio-docs`, `m14/bio-model`, `m14/bio-render`, `m14/bio-routes`, `m14/bio-content`, `m14/bio-wiki-link`, `m14/bio-avatar`, `m14/bio-local-avatar`.
- `pnpm check` passes before every commit; commits use `git -c user.email=sean.may101@gmail.com commit`.

## Review Focus

1. **No pronouns, no hand-written words.** Every template sentence is built from entries; the pronoun test covers one, two, three and many projects, with and without display names and languages.
2. **Citations.** Every marker resolves to a numbered reference and every reference has a backlink.
3. **Exactly what was previewed.** A version's biography section comes only from its own `entry.json`.
4. **Lifecycle.** Unpublish, withdrawal and takedown drop a project from the next biography response; no published project means 404.
5. **Avatar safety.** Only `avatars.githubusercontent.com`, at most 1 MB, PNG/JPEG/GIF/WebP by magic bytes, never a failed sign-in; served only while referenced.
6. **Preview links** stay inside the preview, both ways.

---

### Task 1: ADR-0013, this plan and the spec notes

**Files:**
- Create: `docs/decisions/0013-biography-profile.md`, this plan
- Modify: the Contract spec (D6, §8, §9) and spec 2 (S13, S14, §7): one "Amended by ADR-0013" line each

- [ ] **Step 1:** `git switch -c m14/bio-docs`
- [ ] **Step 2:** Write the ADR, plan and notes; `pnpm check`; commit `docs(hosted): record the biography profile (ADR-0013)`

---

### Task 2: The biography as pure templates

**Files:**
- Create: `packages/hosted/src/biography.ts`, `packages/hosted/src/biography.test.ts`
- Modify: `packages/hosted/src/index.ts`

**Interfaces:**
- Produces: `BiographyEntry` (zod), `biographyEntry({ generation, contribution, exp, repoFullName })`, `nounPhrase(lead, title)`, `surnameOf(displayName, login)`, `biography({ person, projects, newestPublish })` → `Biography` (title, infobox, lead, works, career periods, languages, references, navbox groups, categories), where text is a list of runs: `{ text } | { link, text } | { bold } | { cite: url }`.

- [ ] **Step 1:** Failing tests: entry from the fixture export (dates, article count, lead); noun phrase cut; surname rules; lead for one, two and many projects; ordering newest first; years active and "present"; languages and categories; career periods; references numbered once per URL; no pronoun over many inputs; every citation resolves.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(hosted): generate the biography from published entries`

---

### Task 3: Rendering the biography

**Files:**
- Create: `packages/server/src/render/biography.ts`, `packages/server/src/render/biography.test.ts`, `packages/server/src/pages/biography-style.ts`, its test

**Interfaces:**
- Produces: `biographyHtml(bio, { avatarUrl, appOrigin, preview, self })`, `BIOGRAPHY_STYLE`, `BIOGRAPHY_STYLE_PATH = "/_app/biography.css"`.

- [ ] **Step 1:** Failing tests: section order as in the mockup; every run escaped; each `[n]` marker links to `#ref-n` and each reference backlinks; the style sheet's tokens equal the site's `:root` tokens.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(server): render the biography page and its style sheet`

---

### Task 4: Routes: the biography and wikis at the project's root

**Files:**
- Modify: `packages/server/src/render/build.ts` (tree: `site/` + `entry.json`), `routes/preview.ts`, `routes/public.ts`, `app.ts`, `index.ts`, `packages/hosted/src/urls.ts` (`projectUrl` ends in "/")
- Create: `packages/server/src/db/migrations/0009-biography-trees.sql`
- Delete: `render/portfolio.ts`, `pages/profile.ts`, `pages/public-style.ts` and their tests

- [ ] **Step 1:** Failing tests: `/<handle>` is the biography (404 with none published); `/<handle>/<slug>/` serves the wiki; `/docs/` paths 404; preview `/_preview/<t>/` is the biography and `/_preview/<t>/<slug>/` the wiki, links rewritten both ways; migration 0009 returns published projects to draft and drops previews and tokens.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(server): serve the biography at the handle and each wiki at its project`

---

### Task 5: Content is the contribution only

**Files:**
- Modify: `packages/hosted/src/content.ts`, `generated.ts`, `packages/server/src/pages/project.ts`, `routes/drafts.ts`, `routes/projects.ts` (dashboard link)
- Create: `packages/server/src/db/migrations/0010-contribution-only.sql`

- [ ] **Step 1:** Failing tests: `PortfolioContent` is `{ contribution }`; migration 0010 strips old revisions and deletes their reviews; the project page shows no tagline, summary or highlights; the dashboard links to the biography once a project is published.
- [ ] **Step 2:** Implement; `pnpm check`; commit `refactor(hosted): keep only the contribution in a revision's content`

---

### Task 6: Each wiki links to its author

**Files:**
- Modify: `packages/site/src/build.ts`, `layouts/Layout.astro`, `pages/index.astro`, `urls.ts`; `packages/server/src/render/site-child.ts`, `render/build.ts`, `routes/preview.ts`

- [ ] **Step 1:** Failing tests: with `author`, the nav and welcome box link to it under no base rewriting; without it, the built site is byte-identical to before; the preview rewrites the author link to the preview's biography.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(site): link a hosted wiki back to its author's biography`

---

### Task 7: The avatar

**Files:**
- Create: `packages/server/src/github/avatar.ts`, its test
- Modify: `packages/hosted/src/entities.ts` (`Account.avatar`), `packages/server/src/github/api.ts` (`avatar_url`), `routes/auth.ts`, `store/accounts.ts`, `routes/public.ts` (serve), `render/biography.ts`

- [ ] **Step 1:** Failing tests: magic bytes; size cap; wrong host refused; unchanged URL not refetched; failure keeps the old avatar and signs in; served only while referenced, immutable cache; silhouette otherwise.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(server): store the GitHub avatar at sign-in and serve it from the pages origin`

---

### Task 8: The avatar in local mode

**Files:**
- Modify: `packages/server/src/github/profile.ts`, `github/fake.ts`, `scripts/hosted-profile.ts`

- [ ] **Step 1:** Failing tests: the snapshot records the avatar URL and saves the bytes; the profile's fake GitHub answers that URL.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(server): carry the avatar through a local profile snapshot`

---

### Task 9: Look at it

- [ ] Render a fixture account with three or more projects over two years; screenshot at 1280 and 390 pixels with headless Chrome; compare with the approved mockup.
