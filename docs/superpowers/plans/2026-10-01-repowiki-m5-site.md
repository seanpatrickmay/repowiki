# RepoWiki M5 (Site) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/site`, a static Astro reader that renders a validated `WikiExport` as a Wikipedia-style wiki. It has articles (lead, contents, sections, infobox, numbered references, See also), redirect, disambiguation and alias pages, View history with old revisions and diffs, hover previews, a Main Page (featured article, Did you know..., recently updated, feature map), Random article, All articles and Pagefind search. M5 is done when the site is browsable locally with `pnpm site:build --export <dir>` and then `pnpm site:preview --export <dir>`, or with `pnpm site:demo`.

**Architecture:** The site reads only the JSON export. It validates the export with `@repowiki/core`'s `WikiExport` before Astro starts, so a bad export fails the build with the file and field named. All logic lives in small typed `.ts` modules: the site model, inline renderer, references, and the article, history, diff and Main Page views. Each module is unit-tested directly. The `.astro` files are thin templates over those views, because `tsc` does not check `.astro` files. Output is static. Pagefind indexes the built HTML, Mermaid and the Pagefind UI ship with the site, and nothing is fetched from the network at build time or in the browser. Astro telemetry is turned off. Golden HTML snapshots and a link-integrity crawl run against a site built from a fixture export in a child process.

**Tech Stack:** As in M1 and M2 (Node 24, pnpm 10.15.0, TypeScript 7.0.2, Biome 2.5.15, Vitest 5.0.3, zod 4.6.5), plus `astro 7.3.5`, `pagefind 1.5.2` and `mermaid 12.0.0`, with `lodash-es` overridden to `4.18.1`.

**Spec:** `docs/superpowers/specs/2026-09-30-repowiki-v1-design.md`. The relevant parts are §3 (F01, F02, F03, F06, F10, F12, F13, F26), §4 (the site package and `serve`), §5 (data model and rules 1, 2 and 5), §6.3 (the out-of-date banner), §7.3, §8 and §11 (M5). This plan also carries out the **M5 (site)** items of issue #53.

**Verification note:** before this plan was committed, all 18 tasks were applied in order to a throwaway clone at `82650cd`, the tip of `m2/final-review-fixes`, where `pnpm check` gives 325 tests. Every code block in this plan is generated from those 18 commits, and each commit passed `pnpm check`. The run ended at 451 tests (325 existing + 126 new); each task's last step gives its own count. The generated plan was then applied a second time, mechanically, from its own text alone (every create, replace, append and pnpm command, in order) to a fresh branch at `82650cd`. After each of the 18 tasks the tree matched the verified commit byte for byte, golden snapshots and lockfile included, and `pnpm check` gave the same count. The tracker dry run showed 18 `create`, 18 `link` and 1 `close`. `pnpm audit` reported no known vulnerabilities after each dependency change. The built fixture site was then served with `pnpm site:preview` and driven in headless Chrome 154 over the DevTools protocol. Results:
- Mermaid drew the article diagram and the Main Page feature map, and the map's nodes were links to `/wiki/deliverables/` and `/wiki/signals/`.
- Hovering "deliverable records" showed the Deliverables preview card (lead plus "2 files · 410 lines · Python · last commit 20 February 2026") and set `aria-describedby`. The card hid again when the pointer left.
- `/wiki/legacy-signals/` landed on `/wiki/signals/?redirectedfrom=Legacy%20signals` and showed "(Redirected from Legacy signals)".
- Eight visits to `/random/` reached both active articles.
- Searching "pipeline" returned Signal ingestion and Deliverables. Both match through their "Also known as" aliases.
- There were no console errors and no off-site requests.

Screenshots, described:
- **Desktop article, light:** serif title over a rule, a grey infobox floated right, a boxed numbered Contents, serif section heads with rules, a yellow "This section may be out of date." box, superscript [n] markers, and a light Mermaid flowchart under Data flow.
- **Dark:** the same page in light-on-dark, with the diagram redrawn in Mermaid's dark theme.
- **390 px phone:** the nav moves into a row under the header, and the infobox goes full width above the lead.
- **Main Page:** a welcome banner, three boxes (featured article, Did you know..., Recently updated), and the feature map below them.

The trial surfaced eight fixes, all folded into the tasks:
- Biome rewrites `\uE000` escapes into literal invisible characters, so the inline renderer builds its placeholders with `String.fromCharCode` (Task 7).
- Astro inlines small scripts into the HTML, so `vite.build.assetsInlineLimit: 0` keeps snapshots free of minified code (Task 5).
- Pagefind's `page_count` counts every HTML file it reads, not only search results. The CLI therefore reports "HTML pages", and the search test reads `pagefind-entry.json` (Tasks 5 and 18).
- Article links to redirect and disambiguation ids would fail the link crawl until those pages exist. Routes therefore widen in Task 11, not Task 7.
- Mermaid picked its theme once at load, so diagrams now redraw when the color scheme changes (Task 17).
- Browsers requested `/favicon.ico` and got a 404, so the shell declares a `data:,` icon (Task 6).
- `mermaid` pulls `lodash-es 4.17.23`, which carries GHSA-r5fr-rjxr-66jc (high) and GHSA-f23m-r3pf-42rh (moderate). A workspace override pins `4.18.1` (Task 17).
- `astro`'s optional `sharp` ships an LGPL-3.0 libvips binary and the site has no images, so `sharp` is excluded (Task 5).

## Global Constraints

- Node `>=24`. pnpm is pinned with `"packageManager": "pnpm@10.15.0"`.
- Dependency versions are pinned exactly, and every `pnpm add` uses `--save-exact`. New in M5: `astro 7.3.5`, `pagefind 1.5.2` and `mermaid 12.0.0` in `packages/site`, plus `zod 4.6.5`, which is already reviewed, and the override `lodash-es: 4.18.1`. Run `pnpm audit` after every dependency change; it must print `No known vulnerabilities found`. The review is in the **Dependency review** section below.
- ESM only. Relative imports use the `.ts` extension. No `enum` or `namespace`. TypeScript packages have no build step; the only build is `astro build` in `packages/site`.
- `.astro` files hold markup only. Any logic worth testing goes in a typed `.ts` module, because `pnpm typecheck` does not see `.astro` files. Browser code lives in `packages/site/src/client/*.ts`, starts with `/// <reference lib="dom" />`, and is imported from a `<script>` tag.
- The site reads the export only, never the SQLite store. `loadExport()` validates the export with `WikiExport` before anything renders.
- No network. Tests and builds never touch the network. `buildSite()` and `previewSite()` set `ASTRO_TELEMETRY_DISABLED=1`. Nothing loads from a CDN. The preview server binds `127.0.0.1:4321`.
- Everything in the export is untrusted text. It reaches HTML only through `escapeHtml()`, `renderInline()` or Astro's own `{expression}` escaping. `set:html` is used only on strings built by the site's own renderers.
- Reader-facing dates are commit dates (spec §5 rule 5). They are formatted from the date written in the string, never through the build machine's time zone.
- Page URLs are `/wiki/<id>/`, `/wiki/<id>/history/`, `/wiki/<id>/history/<n>/` and `/wiki/<id>/diff/<n>/`, where `n` is the 1-based position in the feature's history, oldest first. Feature ids and alias slugs are kebab-case, at most 64 characters.
- RepoWiki never writes inside a repo it documents. The default output directory is `site/` next to the export, in `~/.repowiki/<repo>/` or the `--out` directory.
- Tests are co-located `*.test.ts` files. Every test that needs built HTML goes in `packages/site/src/site.test.ts`, which builds the fixture site once in `beforeAll`. Golden snapshots live in `packages/site/src/__snapshots__/`. The task that introduces or changes them writes them with `-u`, and you read the result before committing. Biome ignores them.
- Commits follow Conventional Commits with a scope. Author: `seanpatrickmay <sean.may101@gmail.com>`. Never `Co-Authored-By`, never `--no-verify`.
- `pnpm check` passes before every commit.
- One task = one branch = one PR, under ~300 changed lines. Do not count `pnpm-lock.yaml`, `seed.json`, `test-fixtures.ts`, `test-site.ts` or `__snapshots__/`. Branches are named `m5/short-description`. The PR body starts with `Closes #<ticket>`.
- Merge with `gh pr merge --merge --delete-branch --author-email sean.may101@gmail.com` (merge commits only; ADR-0002).
- Biome style: 2-space indent, double quotes, semicolons, line width 100. If lint fails only on formatting, run `pnpm format`. Every code block below is already in Biome format.
- How to read the edit steps:
  - **Append** means add the block at the end of the file, after one blank line. For `.gitignore` and `pnpm-workspace.yaml`, add it directly, with no blank line.
  - **Replace … with …** pairs are exact text. Each "Replace" block occurs exactly once in the file. Apply the pairs in order.
  - **"`path`:"** creates the file with exactly the block's content. **"Replace `path` with:"** overwrites the whole file.

### Ship procedure (last step of every task)

```bash
git push -u origin HEAD
gh pr create --title "<PR title given in the task>" --body "Closes #<ticket>

<one-paragraph summary>

- [x] pnpm check passes locally"
gh pr checks --watch --fail-fast
gh pr merge --merge --delete-branch --author-email sean.may101@gmail.com
git switch main && git pull --ff-only
```

Look up ticket numbers by title (after Task 1 has seeded them):
`gh issue list --state all --search "in:title \"<ticket title>\"" --json number --jq '.[0].number'`

## Review Focus

1. **Claim text that contains HTML, `<script>`, quotes or the renderer's own placeholder characters** must render as literal text. The only markup allowed is the supported subset. *Tests: Task 7 (`renderInline`), Task 10 (built article).*
2. **Citation paths with spaces, `#` or `%`, and repo URLs with a trailing slash or a non-http scheme**: each path segment is percent-encoded, and `--repo-url javascript:...` is refused. *Tests: Task 4 (`parseSiteArgs`), Task 8 (`codeUrl`, `citationHtml`), Task 10 (built permalink).*
3. **Ids and aliases that collide or point nowhere.** An alias slug never shadows a feature id. A slug shared by two features becomes a disambiguation page. A link to an id with no page renders as plain text. No built page links to a missing page or anchor, and every preview link has a preview file. *Tests: Task 7, Task 11 (`wikiRoutes` unique slugs), Task 5 (the link crawl, which re-runs in every later task), Task 15.*
4. **A build machine in another time zone or locale** produces the same dates and numbers: the commit's own calendar date, and en-US digit grouping. *Tests: Task 9 (`formatDate` across offsets, `formatNumber`).*
5. **An old or hand-edited export**, such as `schemaVersion` 1, a broken parent chain, or a claim so long its diff table would be huge. The build stops with a message that names the file and the field, and the diff falls back instead of allocating the table. *Tests: Task 3, Task 4, Task 5, Task 12 (`MAX_DIFF_CELLS`).*

## Spec deltas made by this plan

These are recorded in the spec in the same commit as this plan:
- **FeatureId (§5):** a lowercase kebab-case slug of at most 64 characters (`FEATURE_ID_MAX_LENGTH`), because ids become URL path segments and file names. There is **no store migration**. The rule in `CLAUDE.md` asks for one only when a schema change rejects previously stored bodies. No feature-id producer has shipped (M3's manifest step is the first), so no store holds a real feature id, let alone one over 64 characters. Task 2 checks that M3 has not merged first. This resolves #53's second M5 item.
- **Export history (§5):** `WikiExport.history` holds every stored `Revision` body per feature, oldest first, instead of metadata only. The last entry is the feature's page, and parent links form a chain. `SCHEMA_VERSION` becomes 2. The reader computes diffs from the bodies. The export is a file, not a stored body, so no store migration is needed. This resolves #53's first M5 item.
- **Claim text (§5):** the markdown subset is `**bold**`, `*italic*` and `` `code` `` plus the link tokens `[[id]]`, `[[id|label]]`, `[[wp:Title]]` and `[[wp:Title|label]]`. Everything else is shown literally, HTML-escaped.
- **Reader (§4):** `pnpm site:build --export <file|dir> [--out <dir>] [--repo-url <url>]`, `pnpm site:preview (--export <file|dir> | --out <dir>)` and `pnpm site:demo`. Code citations link to `<repo-url>/blob/<sha>/<path>#L<start>-L<end>` (GitHub-style) when `--repo-url` is given; otherwise they are plain text. There is no embedded code view, because the export carries no source. `serve` in the later `cli` package wraps these.
- **Aliases (§7.3, F01):** every alias gets `/wiki/<alias-slug>/`. That page redirects to its feature, or is a disambiguation page when two features share the slug. Feature ids win over alias slugs. Aliases are searchable through the infobox's "Also known as" row.
- **Main Page and browsing (§7.3, F12):** the featured article and the start of Did you know... rotate by the head sha, so one export always shows the same page. Did you know... shows up to 5 `hook` claims as "... that <claim>?". Recently updated shows 5 pages by commit date. Random article picks in the browser from the active articles.
- **Diagrams (§7.3, F10):** the browser renders `Revision.diagram` with locally bundled Mermaid (`securityLevel: "strict"`), at the top of Data flow, or after the lead when the page has no Data flow section. The Main Page feature map is computed from See also edges between active articles.
- **Wikipedia hover previews (F13):** these need the Wikipedia summary cache, which M4 produces, in the export. M5 renders `[[wp:Title]]` as an outbound link and leaves the preview to M4. Owner follow-up: add this to #53 under M4.
- **Testing (§8):** golden snapshots render from a fixture *export* (`packages/site/src/test-fixtures.ts`, built from the core fixtures), since the site never reads the store.

## Dependency review

| Package | Version | License | Weekly downloads (2026-09-23..29) | Maintenance | Verdict |
|---|---|---|---|---|---|
| `astro` | 7.3.5 | MIT | 7,239,625 | Astro core team; last publish 2026-09-24 | Adopt. Its optional `sharp` (Apache-2.0, with an LGPL-3.0 libvips binary) is excluded with `ignoredOptionalDependencies`, since the site has no images. `esbuild`'s postinstall is ignored, because its platform binary ships as an optional dependency. |
| `pagefind` | 1.5.2 | MIT | 2,286,786 | Pagefind (CloudCannon); last publish 2026-04-12 | Adopt. Platform binaries come through optional dependencies; there is no postinstall. |
| `mermaid` | 12.0.0 | MIT | 19,240,964 | mermaid-js org; last publish 2026-09-10 | Adopt with the override `lodash-es: 4.18.1`. `chevrotain 11.1.2` pins `lodash-es 4.17.23`, which carries GHSA-r5fr-rjxr-66jc (high) and GHSA-f23m-r3pf-42rh (moderate). With the override, diagrams render and `pnpm audit` is clean. Transitive licenses outside MIT/ISC/BSD/Apache: `elkjs` EPL-2.0, `dompurify` MPL-2.0 OR Apache-2.0, `khroma` (MIT in its repo, no license field). All are used unmodified, so they are acceptable. |
| `zod` | 4.6.5 | MIT | (reviewed in M1) | | Adopt, at the same version as core. |

## Out of scope for M5

- `llms.txt` and writing the export belong to the `export` step (M4/cli).
- The `serve` CLI verb belongs to the `cli` package.
- Wikipedia link checking and summaries belong to M4.
- Screenshots (F11) are later.

---

## File map

```
scripts/tracker/seed.json                      + M5 tickets (Task 1)
packages/core/src/feature.ts                   FEATURE_ID_MAX_LENGTH (Task 2)
packages/core/src/export.ts, version.ts        history = Revision[]; SCHEMA_VERSION 2 (Task 3)
packages/engine/src/store/export.ts            buildExport exports full history (Task 3)
packages/site/
  package.json                                 @repowiki/site (Tasks 4, 5, 17)
  src/load.ts        loadExport, ExportError, resolveExportFile           (Task 4)
  src/args.ts        parseSiteArgs, UsageError                            (Task 4)
  src/test-fixtures.ts  fixtureExport()                                   (Task 4)
  src/build.ts       buildSite, previewSite                               (Task 5)
  src/cli.ts         `site build|preview` entry                           (Task 5)
  src/demo.ts        `pnpm site:demo`                                     (Task 5)
  src/site.ts        getSite(): the build's SiteModel                      (Tasks 5, 7)
  src/test-site.ts   runCli, buildFixtureSite, htmlFiles, brokenLinks     (Task 5)
  src/site.test.ts   every built-HTML test                                (Tasks 5-18)
  src/layouts/Layout.astro   page shell                                   (Tasks 5, 6, 15-18)
  src/styles/wiki.css        stylesheet, one block per task               (Tasks 6, 10, 11, 13-18)
  src/urls.ts, model.ts, inline.ts   URLs, SiteModel, renderInline        (Task 7)
  src/references.ts  footnotes and citation links                         (Task 8)
  src/format.ts, article.ts  dates, numbers, articleView                  (Task 9)
  src/routes.ts      wikiRoutes                                           (Tasks 10, 11)
  src/components/Article.astro, PageTabs.astro, Diagram.astro             (Tasks 10, 13, 17)
  src/pages/wiki/[slug]/index.astro            article/redirect/dab pages  (Tasks 10, 11, 13)
  src/summary.ts     leadSummary                                          (Task 11)
  src/diff.ts        diffSequence, wordDiffHtml, revisionDiff             (Task 12)
  src/history.ts     historyRows, oldRevisionNotice, revisionLabelHtml    (Tasks 13, 14)
  src/pages/wiki/[slug]/history/index.astro, history/[n].astro, diff/[n].astro  (Tasks 13, 14)
  src/preview.ts, pages/api/preview/[slug].json.ts, client/preview.ts     (Task 15)
  src/main-page.ts, pages/index.astro, pages/random.astro, pages/special/all-pages.astro (Task 16)
  src/feature-map.ts, client/mermaid.ts                                   (Task 17)
  src/pages/search.astro, client/search.ts                                (Task 18)
```

---

### Task 1: M5 tickets in the tracker

**Files:**
- Modify: `scripts/tracker/seed.json` (append to `issues`)

**Interfaces:**
- Produces: GitHub issues `[M5] …` that Tasks 2–18 close.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/tracker-tickets
```

- [ ] **Step 2: Append these entries to the end of the `issues` array in `scripts/tracker/seed.json`**

Add a comma after the closing `}` of the current last entry, then paste the following. It is already in Biome format.

```json
    {
      "key": "M5-1",
      "title": "[M5] tracker: M5 tickets",
      "labels": ["v1", "type:task", "area:infra"],
      "parent": "F19",
      "closed": true,
      "body": "**Deliverable:** M5 tickets in seed.json.\n\n**Done when:** the seed creates M5-1..M5-18. Plan: docs/superpowers/plans/2026-10-01-repowiki-m5-site.md Task 1."
    },
    {
      "key": "M5-2",
      "title": "[M5] core: cap feature ids at 64 characters",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F26",
      "body": "**Deliverable:** FeatureId max length 64 and FEATURE_ID_MAX_LENGTH (issue #53). No store migration: no stored body holds a feature id yet.\n\n**Done when:** the length tests pass. Plan Task 2."
    },
    {
      "key": "M5-3",
      "title": "[M5] core: export full revision bodies in history",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F06",
      "body": "**Deliverable:** WikiExport.history holds every Revision body with parent-chain checks; SCHEMA_VERSION 2; buildExport fills it (issue #53).\n\n**Done when:** core and store export tests pass. Plan Task 3."
    },
    {
      "key": "M5-4",
      "title": "[M5] site: package, export loading and arguments",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F12",
      "body": "**Deliverable:** packages/site with pinned astro/pagefind/zod, loadExport (fails loudly) and parseSiteArgs.\n\n**Done when:** load and args tests pass. Plan Task 4."
    },
    {
      "key": "M5-5",
      "title": "[M5] site: Astro build, Pagefind and the site CLI",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F12",
      "body": "**Deliverable:** buildSite/previewSite, pnpm site:build / site:preview / site:demo, the fixture build helper and the link-integrity check.\n\n**Done when:** the fixture site builds offline and a bad export fails the build. Plan Task 5."
    },
    {
      "key": "M5-6",
      "title": "[M5] site: page shell and stylesheet",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F12",
      "body": "**Deliverable:** header, nav, footer, skip link; system fonts, Wikipedia-like scale, dark mode, phone width.\n\n**Done when:** shell tests pass. Plan Task 6."
    },
    {
      "key": "M5-7",
      "title": "[M5] site: site model and inline renderer",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F02",
      "body": "**Deliverable:** buildSiteModel (routes, alias slugs) and renderInline (escaping, bold/italic/code, [[id]] and [[wp:Title]] links).\n\n**Done when:** model and inline tests pass. Plan Task 7."
    },
    {
      "key": "M5-8",
      "title": "[M5] site: references and code citation links",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F03",
      "body": "**Deliverable:** numbered references with shared numbers and back-links; path:Lstart-end@sha permalinks from --repo-url.\n\n**Done when:** reference tests pass. Plan Task 8."
    },
    {
      "key": "M5-9",
      "title": "[M5] site: article view",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F04",
      "body": "**Deliverable:** articleView: lead, TOC, sections, stale banners, See also, references, infobox, commit dates.\n\n**Done when:** article view tests pass. Plan Task 9."
    },
    {
      "key": "M5-10",
      "title": "[M5] site: article pages",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F04",
      "body": "**Deliverable:** /wiki/<id>/ article pages with infobox and references; first golden snapshot.\n\n**Done when:** article page tests pass. Plan Task 10."
    },
    {
      "key": "M5-11",
      "title": "[M5] site: redirect, disambiguation and alias pages",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F01",
      "body": "**Deliverable:** pages for redirect and disambiguation features and for alias slugs; Redirected-from note.\n\n**Done when:** redirect tests pass. Plan Task 11."
    },
    {
      "key": "M5-12",
      "title": "[M5] site: revision diff",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F06",
      "body": "**Deliverable:** diffSequence, wordDiffHtml and revisionDiff over claim text.\n\n**Done when:** diff tests pass. Plan Task 12."
    },
    {
      "key": "M5-13",
      "title": "[M5] site: revision history and old revisions",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F06",
      "body": "**Deliverable:** View history pages dated by commitDate, old-revision pages, page tabs.\n\n**Done when:** history tests pass. Plan Task 13."
    },
    {
      "key": "M5-14",
      "title": "[M5] site: diffs between revisions",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F06",
      "body": "**Deliverable:** /wiki/<id>/diff/<n>/ pages and prev links in history.\n\n**Done when:** diff page tests pass. Plan Task 14."
    },
    {
      "key": "M5-15",
      "title": "[M5] site: hover previews",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F12",
      "body": "**Deliverable:** /api/preview/<id>.json (lead + infobox facts) and the hover/focus preview script.\n\n**Done when:** every data-preview link has a preview file. Plan Task 15."
    },
    {
      "key": "M5-16",
      "title": "[M5] site: Main Page, Random article and All articles",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F12",
      "body": "**Deliverable:** featured article, Did you know (hook claims), recently updated, /random/, /special/all-pages/.\n\n**Done when:** Main Page tests pass. Plan Task 16."
    },
    {
      "key": "M5-17",
      "title": "[M5] site: diagrams and feature map",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F10",
      "body": "**Deliverable:** bundled Mermaid rendering of Revision.diagram and a clickable Main Page feature map.\n\n**Done when:** diagram tests pass and Mermaid loads only on demand. Plan Task 17."
    },
    {
      "key": "M5-18",
      "title": "[M5] site: Pagefind search and local browse check",
      "labels": ["v1", "type:task", "area:site"],
      "parent": "F12",
      "body": "**Deliverable:** header search box and /search/ with the Pagefind UI; the M5 exit check.\n\n**Done when:** search tests pass and pnpm site:demo is browsable locally. Plan Task 18."
    }
```

- [ ] **Step 3: Verify, commit, ship**

Run: `pnpm check && pnpm tracker:seed --dry-run | grep -E '^(create|link|close)'`
Expected: `pnpm check` passes with the same test count as `main`. The dry run lists exactly 18 `create`, 18 `link` and 1 `close` line, all for M5 keys.

```bash
git add scripts/tracker/seed.json
git commit -m "chore(tracker): add M5 tickets"
```

Ship. PR title: `chore(tracker): add M5 tickets`. There is no `Closes` line, since the tickets don't exist yet.

- [ ] **Step 4: Seed from `main` after the merge**

```bash
pnpm tracker:seed --project 2
pnpm tracker:seed --dry-run | grep -cE '^(create|link|close)'   # expect 0
```

---

### Task 2: Cap feature ids at 64 characters

**Ticket:** `[M5] core: cap feature ids at 64 characters`

**Files:**
- Modify: `packages/core/src/feature.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/feature.test.ts`

**Interfaces:**
- Produces: `FEATURE_ID_MAX_LENGTH = 64`, exported from `@repowiki/core`. `FeatureId` rejects longer ids with the message `feature ids are at most 64 characters`.

- [ ] **Step 1: Branch, and confirm no feature-id producer has shipped**

```bash
git switch -c m5/feature-id-length
test ! -e packages/engine/src/manifest && echo "no manifest producer yet"
```

Expected: `no manifest producer yet`. If `packages/engine/src/manifest` exists, M3 has shipped and stores may hold real feature ids. In that case, stop and ask the owner: the cap then needs a store migration (CLAUDE.md), and this plan's "no migration" decision no longer holds.

- [ ] **Step 2: Write the failing tests**

In `packages/core/src/feature.test.ts`:

Replace:
```ts
import { describe, expect, it } from "vitest";
import { Feature, FeatureId } from "./feature.ts";
import { makeFeature, SHA_A, SHA_B } from "./test-fixtures.ts";
```
with:
```ts
import { describe, expect, it } from "vitest";
import { FEATURE_ID_MAX_LENGTH, Feature, FeatureId } from "./feature.ts";
import { makeFeature, SHA_A, SHA_B } from "./test-fixtures.ts";
```

Replace:
```ts
  );
});
```
with:
```ts
  );

  it("accepts an id of exactly FEATURE_ID_MAX_LENGTH characters", () => {
    expect(FEATURE_ID_MAX_LENGTH).toBe(64);
    expect(FeatureId.safeParse(`a-${"b".repeat(62)}`).success).toBe(true);
  });

  it("rejects an id one character longer, with a message naming the limit", () => {
    const result = FeatureId.safeParse(`a-${"b".repeat(63)}`);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("feature ids are at most 64 characters");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/feature.test.ts`
Expected: FAIL, 2 failed. `FEATURE_ID_MAX_LENGTH` is `undefined`, and the 65-character id is still accepted.

- [ ] **Step 4: Implement**

In `packages/core/src/feature.ts`:

Replace:
```ts
import { GitSha } from "./primitives.ts";
```
with:
```ts
import { GitSha } from "./primitives.ts";

/** Feature ids become URL path segments and file names in the reader site, so they are capped. */
export const FEATURE_ID_MAX_LENGTH = 64;
```

Replace:
```ts
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "feature ids are lowercase kebab-case slugs");
```
with:
```ts
  .string()
  .max(FEATURE_ID_MAX_LENGTH, `feature ids are at most ${FEATURE_ID_MAX_LENGTH} characters`)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "feature ids are lowercase kebab-case slugs");
```

In `packages/core/src/index.ts`:

Replace:
```ts
export { HistoryEntry, WikiExport } from "./export.ts";
export { Feature, FeatureId, FeatureStatus, LineageEvent } from "./feature.ts";
export { Manifest, MemberId, Membership } from "./manifest.ts";
```
with:
```ts
export { HistoryEntry, WikiExport } from "./export.ts";
export {
  FEATURE_ID_MAX_LENGTH,
  Feature,
  FeatureId,
  FeatureStatus,
  LineageEvent,
} from "./feature.ts";
export { Manifest, MemberId, Membership } from "./manifest.ts";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS, with 2 more tests than `main` (327 in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/core
git commit -m "feat(core): cap feature ids at 64 characters"
```

Ship. PR title: `feat(core): cap feature ids at 64 characters`. In the PR body, state the migration decision: no store holds a feature id yet, because no producer has shipped, so the cap cannot reject a stored body.

---

### Task 3: Export full revision bodies in history

**Ticket:** `[M5] core: export full revision bodies in history`

**Files:**
- Modify: `packages/core/src/export.ts` (whole file), `packages/core/src/version.ts`, `packages/core/src/index.ts`, `packages/engine/src/store/export.ts` (whole file)
- Test: `packages/core/src/export.test.ts` (whole file), `packages/core/src/index.test.ts`, `packages/engine/src/store/export.test.ts`

**Interfaces:**
- Produces: `WikiExport.history: Record<FeatureId, Revision[]>`. It holds every stored revision body, oldest first. The last entry has the page's id, `history[i].parentId === history[i - 1].id`, `history[0].parentId === null`, every revision's `featureId` equals its key, and every key has a page. `SCHEMA_VERSION === 2`. `HistoryEntry` is removed from `@repowiki/core`. `buildExport()` fills `history` from `store.listHistory()`.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/export-history
```

- [ ] **Step 2: Write the failing tests**

Replace `packages/core/src/export.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { WikiExport } from "./export.ts";
import type { Revision } from "./revision.ts";
import { makeManifest, makeRevision, SHA_B } from "./test-fixtures.ts";

const first = makeRevision();
const second = makeRevision({ id: "rev-2", parentId: "rev-1", reason: "update", sha: SHA_B });

function makeExport(overrides: Partial<WikiExport> = {}): WikiExport {
  return {
    schemaVersion: 2,
    repo: "next-chief-of-staff",
    head: SHA_B,
    exportedAt: "2026-09-30T21:00:00Z",
    manifest: makeManifest(),
    pages: [second],
    history: { signals: [first, second] },
    ...overrides,
  };
}

function messages(wiki: unknown): string[] {
  const result = WikiExport.safeParse(wiki);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("WikiExport", () => {
  it("accepts a consistent export with full revision bodies in history", () => {
    expect(WikiExport.parse(makeExport())).toEqual(makeExport());
  });

  it("rejects schema version 1, whose history held metadata only", () => {
    expect(WikiExport.safeParse({ ...makeExport(), schemaVersion: 1 }).success).toBe(false);
  });

  it("rejects pages for features missing from the manifest", () => {
    const page = makeRevision({ featureId: "ghost" });
    expect(messages(makeExport({ pages: [page], history: { ghost: [page] } }))).toContain(
      "ghost is not in the manifest",
    );
  });

  it("requires each page to be the last entry of its history", () => {
    expect(messages(makeExport({ history: { signals: [first] } }))).toContain(
      "history for signals must end with page rev-2",
    );
  });

  it("rejects two pages for the same feature", () => {
    expect(messages(makeExport({ pages: [second, second] }))).toEqual(["two pages for signals"]);
  });

  it("rejects a history revision filed under another feature", () => {
    const stray: Revision = { ...first, featureId: "deliverables" };
    expect(messages(makeExport({ history: { signals: [stray, second] } }))).toContain(
      "history for signals holds revision rev-1 of deliverables",
    );
  });

  it("rejects a history whose parent chain is broken", () => {
    const orphan = makeRevision({ id: "rev-2", parentId: "rev-x", reason: "update" });
    expect(
      messages(makeExport({ pages: [orphan], history: { signals: [first, orphan] } })),
    ).toEqual(["revision rev-2 must have parent rev-1"]);
  });

  it("rejects a history that starts with a parented revision", () => {
    expect(messages(makeExport({ history: { signals: [second] } }))).toEqual([
      "revision rev-2 must have parent null",
    ]);
  });

  it("rejects a history with no page", () => {
    const wiki = makeExport({ history: { signals: [first, second], deliverables: [first] } });
    expect(messages(wiki)).toContain("history for deliverables has no page");
  });
});
```

In `packages/core/src/index.test.ts`:

Replace:
```ts
  it("resolves by package name and exposes the schema version", () => {
    expect(core.SCHEMA_VERSION).toBe(1);
  });
```
with:
```ts
  it("resolves by package name and exposes the schema version", () => {
    expect(core.SCHEMA_VERSION).toBe(2);
  });
```

In `packages/engine/src/store/export.test.ts`:

Replace:
```ts
    const wiki = buildExport(store, options);
    expect(wiki.head).toBe(SHA_B);
```
with:
```ts
    const wiki = buildExport(store, options);
    expect(wiki.schemaVersion).toBe(2);
    expect(wiki.head).toBe(SHA_B);
```

Replace:
```ts
    expect(wiki.pages.map((p) => p.id)).toEqual(["rev-2"]);
    expect(wiki.history.signals).toEqual([
      {
        id: "rev-1",
        sha: SHA_A,
        commitDate: "2026-02-03T10:00:00-05:00",
        reason: "build",
        pr: null,
      },
      {
        id: "rev-2",
        sha: SHA_B,
        commitDate: "2026-02-03T10:00:00-05:00",
        reason: "update",
        pr: 88,
      },
    ]);
  });
```
with:
```ts
    expect(wiki.pages.map((p) => p.id)).toEqual(["rev-2"]);
    expect(wiki.history.signals?.map((r) => [r.id, r.sha, r.reason, r.pr])).toEqual([
      ["rev-1", SHA_A, "build", null],
      ["rev-2", SHA_B, "update", 88],
    ]);
  });

  it("exports full revision bodies, so past versions can be read and diffed", () => {
    seed();
    const wiki = buildExport(store, options);
    expect(wiki.history.signals?.[0]).toEqual(store.getRevision("rev-1"));
    expect(wiki.history.signals?.at(-1)).toEqual(wiki.pages[0]);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/export.test.ts packages/core/src/index.test.ts packages/engine/src/store/export.test.ts`
Expected: FAIL. All 9 `WikiExport` cases fail, because `schemaVersion` must still be 1 and history entries are metadata only. The version test and both store export tests also fail.

- [ ] **Step 4: Implement**

Replace `packages/core/src/export.ts` with:

```ts
import { z } from "zod";
import { FeatureId } from "./feature.ts";
import { Manifest } from "./manifest.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
import { Revision } from "./revision.ts";
import { SCHEMA_VERSION } from "./version.ts";

/** Everything the reader site and agents consume. Pages are the current revision of each feature. */
export const WikiExport = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repo: z.string().min(1),
    head: GitSha,
    exportedAt: IsoDateTime,
    manifest: Manifest,
    pages: z.array(Revision),
    /** Every stored revision body per feature, oldest first; the last one is the feature's page. */
    history: z.record(FeatureId, z.array(Revision)),
  })
  .superRefine((wiki, ctx) => {
    const known = new Set(wiki.manifest.features.map((f) => f.id));
    const seen = new Set<string>();
    wiki.pages.forEach((page, index) => {
      if (seen.has(page.featureId)) {
        ctx.addIssue({
          code: "custom",
          message: `two pages for ${page.featureId}`,
          path: ["pages", index],
        });
      }
      seen.add(page.featureId);
      if (!known.has(page.featureId)) {
        ctx.addIssue({
          code: "custom",
          message: `${page.featureId} is not in the manifest`,
          path: ["pages", index],
        });
      }
      if (wiki.history[page.featureId]?.at(-1)?.id !== page.id) {
        ctx.addIssue({
          code: "custom",
          message: `history for ${page.featureId} must end with page ${page.id}`,
          path: ["history", page.featureId],
        });
      }
    });

    for (const [featureId, revisions] of Object.entries(wiki.history)) {
      if (!seen.has(featureId)) {
        ctx.addIssue({
          code: "custom",
          message: `history for ${featureId} has no page`,
          path: ["history", featureId],
        });
      }
      revisions.forEach((revision, index) => {
        if (revision.featureId !== featureId) {
          ctx.addIssue({
            code: "custom",
            message: `history for ${featureId} holds revision ${revision.id} of ${revision.featureId}`,
            path: ["history", featureId, index],
          });
        }
        const parent = index === 0 ? null : (revisions[index - 1]?.id ?? null);
        if (revision.parentId !== parent) {
          ctx.addIssue({
            code: "custom",
            message: `revision ${revision.id} must have parent ${parent}`,
            path: ["history", featureId, index, "parentId"],
          });
        }
      });
    }
  });
export type WikiExport = z.infer<typeof WikiExport>;
```

In `packages/core/src/version.ts`:

Replace:
```ts
/** Version of the stored and exported wiki data format. Bump on any breaking schema change. */
export const SCHEMA_VERSION = 1;
```
with:
```ts
/** Version of the stored and exported wiki data format. Bump on any breaking schema change. */
export const SCHEMA_VERSION = 2;
```

In `packages/core/src/index.ts`:

Replace:
```ts
export { contentHash } from "./content-hash.ts";
export { HistoryEntry, WikiExport } from "./export.ts";
export {
```
with:
```ts
export { contentHash } from "./content-hash.ts";
export { WikiExport } from "./export.ts";
export {
```

Replace `packages/engine/src/store/export.ts` with:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_VERSION, WikiExport } from "@repowiki/core";
import { EmptyStoreError } from "./errors.ts";
import type { Store } from "./store.ts";

export interface ExportOptions {
  repo: string;
  exportedAt: string;
}

/** Assembles and validates the export consumed by the reader site and by agents. */
export function buildExport(store: Store, options: ExportOptions): WikiExport {
  const head = store.getHead();
  const manifest = store.getLatestManifest();
  if (head === null || manifest === null) throw new EmptyStoreError();

  const pages = store.listCurrentRevisions();
  const history = Object.fromEntries(
    pages.map((page) => [page.featureId, store.listHistory(page.featureId)]),
  );
  return WikiExport.parse({
    schemaVersion: SCHEMA_VERSION,
    repo: options.repo,
    head,
    exportedAt: options.exportedAt,
    manifest,
    pages,
    history,
  });
}

export function writeExport(store: Store, outPath: string, options: ExportOptions): void {
  const wiki = buildExport(store, options);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(wiki, null, 2)}\n`, "utf8");
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (332 tests in the trial). `grep -rn HistoryEntry packages scripts` prints nothing.

- [ ] **Step 6: Commit and ship**

```bash
git add packages/core packages/engine
git commit -m "feat(core): export full revision bodies in history"
```

Ship. PR title: `feat(core): export full revision bodies in history`. In the PR body, note that the export is a file and not a stored body, so no store migration is needed, and that `SCHEMA_VERSION` is now 2.

---

### Task 4: Site package, export loading and arguments

**Ticket:** `[M5] site: package, export loading and arguments`

**Files:**
- Create: `packages/site/package.json`, `packages/site/src/load.ts`, `packages/site/src/args.ts`, `packages/site/src/test-fixtures.ts`
- Test: `packages/site/src/load.test.ts`, `packages/site/src/args.test.ts`

**Interfaces:**
- Consumes: `WikiExport`, `SCHEMA_VERSION` and `Revision` from `@repowiki/core`, and the builders in `@repowiki/core/test-fixtures` (`makeRevision`, `makeFeature`, `bodyClaim`, `leadClaim`, `codeCitation`, `commitCitation`, `SHA_A/B/C`).
- Produces:
  - `class ExportError extends Error`.
  - `resolveExportFile(path: string): string`: a directory means `<dir>/export.json`.
  - `loadExport(path: string): WikiExport`: throws `ExportError` with `cannot read export <file>: …` or `invalid export <file>:\n<zod pretty error>`.
  - `class UsageError extends Error`.
  - `interface SiteArgs { command: "build" | "preview"; exportFile: string | null; outDir: string; repoUrl: string | null }`.
  - `parseSiteArgs(argv: readonly string[]): SiteArgs`.
  - `fixtureExport(): WikiExport`, a valid export with these features:
    - `signals`: active, with two revisions, every section, a stale claim, hook claims, a diagram, and an unknown See also id `ghost`.
    - `deliverables`: active.
    - `legacy-signals`: a redirect to `signals`.
    - `reports`: a disambiguation of `signals` and `deliverables`.
    - `exporter`: retired.
    - `scheduler`: active, with no page.

- [ ] **Step 1: Branch and create the package**

```bash
git switch -c m5/site-package
mkdir -p packages/site/src
```

Create `packages/site/package.json`:

```json
{
  "name": "@repowiki/site",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@repowiki/core": "workspace:*"
  }
}
```

Then:

```bash
pnpm --filter @repowiki/site add --save-exact zod@4.6.5
pnpm audit   # expect: No known vulnerabilities found
```


`packages/site/package.json` now lists `"zod": "4.6.5"` after `@repowiki/core`.

- [ ] **Step 2: Write the fixture export and the failing tests**

`packages/site/src/test-fixtures.ts` (a fixture; it does not count toward the PR size):

```ts
import { type Revision, SCHEMA_VERSION, WikiExport } from "@repowiki/core";
import {
  bodyClaim,
  codeCitation,
  commitCitation,
  leadClaim,
  makeFeature,
  makeRevision,
  SHA_A,
  SHA_B,
  SHA_C,
} from "@repowiki/core/test-fixtures";

const ingest = codeCitation();
const models = codeCitation({
  path: "src/signals/models.py",
  startLine: 3,
  endLine: 18,
  symbol: null,
});
const oddPath = codeCitation({
  path: "src/signals/odd name#1.py",
  startLine: 1,
  endLine: 9,
  sha: SHA_B,
});
const todo = codeCitation({ startLine: 30, endLine: 30, symbol: null, sha: SHA_B });
const crud = codeCitation({
  path: "src/deliverables/crud.py",
  startLine: 1,
  endLine: 40,
  symbol: null,
});

const signalsV1 = makeRevision({
  id: "signals-1",
  sections: [
    {
      key: "lead",
      claims: [
        leadClaim({ text: "**Signal ingestion** turns chunks into signals.", supports: ["s-o1"] }),
      ],
    },
    {
      key: "overview",
      claims: [bodyClaim({ id: "s-o1", text: "Signals are built from chunks." })],
    },
    {
      key: "known-limitations",
      claims: [
        bodyClaim({
          id: "s-l0",
          kind: "limitation",
          text: "Fetch errors are not retried (a `TODO` notes it).",
          citations: [todo],
        }),
      ],
    },
  ],
});

const signalsV2 = makeRevision({
  id: "signals-2",
  parentId: "signals-1",
  reason: "update",
  sha: SHA_B,
  pr: 88,
  commitDate: "2026-03-10T16:30:00+01:00",
  infobox: {
    files: 4,
    loc: 1312,
    languages: ["Python", "TypeScript"],
    entryPoints: ["src/signals/ingest.py", "src/signals/api.ts"],
    firstCommitDate: "2026-01-26T09:00:00-05:00",
    lastCommitDate: "2026-03-10T16:30:00+01:00",
  },
  diagram:
    "flowchart LR\n  fetch[Fetcher] --> ingest[ingest_chunk]\n  ingest --> store[(signals table)]",
  seeAlso: ["deliverables", "reports", "ghost"],
  sections: [
    {
      key: "lead",
      claims: [
        leadClaim({
          id: "s-lead-1",
          text: "**Signal ingestion** is the subsystem of demo-repo that turns ingested chunks into [[deliverables|deliverable records]].",
          supports: ["s-o1", "s-o2"],
        }),
        leadClaim({
          id: "s-lead-2",
          text: "It retries failed fetches with [[wp:Exponential backoff]].",
          supports: ["s-h2"],
        }),
      ],
    },
    {
      key: "overview",
      claims: [
        bodyClaim({
          id: "s-o1",
          text: "Signals are created from ingested chunks by `ingest_chunk`.",
          hook: true,
        }),
        bodyClaim({
          id: "s-o2",
          text: "Each signal stores its source chunk and a *confidence* score.",
          citations: [ingest, models],
        }),
      ],
    },
    {
      key: "how-it-works",
      claims: [
        bodyClaim({
          id: "s-h1",
          text: "The [[scheduler]] triggers ingestion every five minutes.",
          citations: [oddPath],
          staleSince: SHA_B,
        }),
        bodyClaim({
          id: "s-h2",
          text: "Failed fetches are retried up to three times; [[ghost]] described the old approach. Payloads containing `<script>` tags are stored escaped, and so is <b>this</b>.",
          citations: [models],
        }),
      ],
    },
    {
      key: "data-flow",
      claims: [
        bodyClaim({
          id: "s-d1",
          text: "Chunks pass through [[legacy-signals]] storage before promotion.",
        }),
      ],
    },
    {
      key: "history",
      claims: [
        bodyClaim({
          id: "s-hist1",
          kind: "history",
          text: "Signal ingestion was introduced in PR #45.",
          citations: [commitCitation()],
          hook: true,
        }),
      ],
    },
    {
      key: "known-limitations",
      claims: [
        bodyClaim({
          id: "s-l1",
          kind: "limitation",
          text: "Deduplication is not implemented (a `TODO` in the ingest module).",
          citations: [todo],
        }),
      ],
    },
  ],
});

const deliverables = makeRevision({
  id: "deliverables-1",
  featureId: "deliverables",
  commitDate: "2026-02-20T11:00:00-05:00",
  seeAlso: ["signals"],
  infobox: {
    files: 2,
    loc: 410,
    languages: ["Python"],
    entryPoints: ["src/deliverables/crud.py"],
    firstCommitDate: "2026-02-01T09:00:00-05:00",
    lastCommitDate: "2026-02-20T11:00:00-05:00",
  },
  sections: [
    {
      key: "lead",
      claims: [
        leadClaim({
          id: "d-lead",
          text: "**Deliverables** are the records that [[signals]] feed.",
          supports: ["d-o1"],
        }),
      ],
    },
    {
      key: "overview",
      claims: [
        bodyClaim({
          id: "d-o1",
          text: "Deliverables are stored as rows in the `deliverables` table.",
          citations: [crud],
          hook: true,
        }),
      ],
    },
  ],
});

const legacy = makeRevision({
  id: "legacy-1",
  featureId: "legacy-signals",
  commitDate: "2026-01-30T08:00:00-05:00",
  seeAlso: [],
  sections: [
    {
      key: "lead",
      claims: [
        leadClaim({ text: "**Legacy signals** stored raw signals before ingestion was rebuilt." }),
      ],
    },
    { key: "overview", claims: [bodyClaim()] },
  ],
});

const exporter = makeRevision({
  id: "exporter-1",
  featureId: "exporter",
  commitDate: "2026-01-15T12:00:00-05:00",
  seeAlso: [],
  sections: [
    {
      key: "lead",
      claims: [leadClaim({ text: "The **CSV exporter** wrote signals to CSV files." })],
    },
    { key: "overview", claims: [bodyClaim({ citations: [crud] })] },
  ],
});

const pages: Revision[] = [deliverables, exporter, legacy, signalsV2];

/** A small but complete export: every feature status, two revisions, stale and hook claims. */
export function fixtureExport(): WikiExport {
  return WikiExport.parse({
    schemaVersion: SCHEMA_VERSION,
    repo: "demo-repo",
    head: SHA_C,
    exportedAt: "2026-09-30T21:00:00Z",
    manifest: {
      sha: SHA_C,
      features: [
        makeFeature({ aliases: ["signal pipeline", "SIGNALS_TABLE", "/api/signals"] }),
        makeFeature({
          id: "deliverables",
          title: "Deliverables",
          aliases: ["deliverable records", "signal pipeline", "Signals", "Deliverables"],
        }),
        makeFeature({
          id: "legacy-signals",
          title: "Legacy signals",
          aliases: [],
          status: { kind: "redirect", to: "signals" },
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "merge", sha: SHA_B, into: "signals" },
          ],
        }),
        makeFeature({
          id: "reports",
          title: "Reports",
          aliases: [],
          status: { kind: "disambiguation", to: ["signals", "deliverables"] },
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "split", sha: SHA_B, into: ["signals", "deliverables"] },
          ],
        }),
        makeFeature({
          id: "exporter",
          title: "CSV exporter",
          aliases: [],
          status: { kind: "retired" },
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "retire", sha: SHA_C },
          ],
        }),
        makeFeature({ id: "scheduler", title: "Scheduler", aliases: [] }),
      ],
      membership: {
        "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 },
        "src/deliverables/crud.py": { featureId: "deliverables", weight: 0.7 },
        "src/scheduler.py": { featureId: "scheduler", weight: 0.6 },
      },
    },
    pages,
    history: {
      deliverables: [deliverables],
      exporter: [exporter],
      "legacy-signals": [legacy],
      signals: [signalsV1, signalsV2],
    },
  });
}
```

`packages/site/src/load.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ExportError, loadExport } from "./load.ts";
import { fixtureExport } from "./test-fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "repowiki-load-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe("loadExport", () => {
  it("parses a valid export, given the file or its directory", () => {
    const file = write("export.json", JSON.stringify(fixtureExport()));
    expect(loadExport(file)).toEqual(fixtureExport());
    expect(loadExport(dir)).toEqual(fixtureExport());
  });

  it("names the file and the failing field for a schema violation", () => {
    const pages = fixtureExport().pages.map((page) => ({ ...page, commitDate: "yesterday" }));
    const file = write("bad.json", JSON.stringify({ ...fixtureExport(), pages }));
    expect(() => loadExport(file)).toThrow(ExportError);
    expect(() => loadExport(file)).toThrow(/invalid export .*bad\.json[\s\S]*commitDate/);
  });

  it("rejects an export from an older schema version", () => {
    const file = write("v1.json", JSON.stringify({ ...fixtureExport(), schemaVersion: 1 }));
    expect(() => loadExport(file)).toThrow(/schemaVersion/);
  });

  it("reports unreadable and non-JSON files as ExportError", () => {
    expect(() => loadExport(join(dir, "missing.json"))).toThrow(/cannot read export/);
    expect(() => loadExport(write("junk.json", "{"))).toThrow(/cannot read export/);
  });
});
```

`packages/site/src/args.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseSiteArgs, UsageError } from "./args.ts";

const dir = mkdtempSync(join(tmpdir(), "repowiki-args-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseSiteArgs", () => {
  it("defaults --out to a site directory next to the export file", () => {
    expect(parseSiteArgs(["build", "--export", "/data/demo/export.json"])).toEqual({
      command: "build",
      exportFile: "/data/demo/export.json",
      outDir: "/data/demo/site",
      repoUrl: null,
    });
  });

  it("treats an --export directory as <dir>/export.json", () => {
    const args = parseSiteArgs(["build", "--export", dir]);
    expect(args.exportFile).toBe(join(dir, "export.json"));
    expect(args.outDir).toBe(join(dir, "site"));
  });

  it("resolves relative paths and keeps an explicit --out", () => {
    const args = parseSiteArgs(["build", "--export", "x.json", "--out", "out"]);
    expect(args.exportFile).toBe(resolve("x.json"));
    expect(args.outDir).toBe(resolve("out"));
  });

  it("normalizes --repo-url and drops trailing slashes", () => {
    const args = parseSiteArgs([
      "build",
      "--export",
      "x.json",
      "--repo-url",
      "https://github.com/a/b/",
    ]);
    expect(args.repoUrl).toBe("https://github.com/a/b");
  });

  it.each(["javascript:alert(1)", "github.com/a/b", "file:///etc"])(
    "rejects --repo-url %j",
    (url) => {
      expect(() => parseSiteArgs(["build", "--export", "x.json", "--repo-url", url])).toThrow(
        UsageError,
      );
    },
  );

  it("lets preview take --out alone", () => {
    expect(parseSiteArgs(["preview", "--out", "/srv/site"])).toEqual({
      command: "preview",
      exportFile: null,
      outDir: "/srv/site",
      repoUrl: null,
    });
  });

  it.each([
    [[]],
    [["serve"]],
    [["build"]],
    [["preview"]],
    [["build", "--export"]],
    [["build", "--export", "--out", "x"]],
    [["build", "--export", "x.json", "--bogus", "1"]],
  ])("rejects %j", (argv) => {
    expect(() => parseSiteArgs(argv)).toThrow(UsageError);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site`
Expected: FAIL with `Error: Cannot find module './load.ts'` (and `'./args.ts'`).

- [ ] **Step 4: Implement**

`packages/site/src/load.ts`:

```ts
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WikiExport } from "@repowiki/core";
import { z } from "zod";

/** The export could not be read or failed schema validation. The message is reader-facing. */
export class ExportError extends Error {
  override name = "ExportError";
}

/** A directory argument means "<dir>/export.json"; anything else is taken as the file itself. */
export function resolveExportFile(path: string): string {
  try {
    return statSync(path).isDirectory() ? join(path, "export.json") : path;
  } catch {
    return path;
  }
}

/** Reads and validates an export with the @repowiki/core schema. Throws ExportError. */
export function loadExport(path: string): WikiExport {
  const file = resolveExportFile(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ExportError(`cannot read export ${file}: ${(error as Error).message}`);
  }
  const result = WikiExport.safeParse(raw);
  if (!result.success) {
    throw new ExportError(`invalid export ${file}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
```

`packages/site/src/args.ts`:

```ts
import { dirname, resolve } from "node:path";
import { resolveExportFile } from "./load.ts";

export interface SiteArgs {
  command: "build" | "preview";
  /** Absolute path of the export JSON file (null only for `preview --out`). */
  exportFile: string | null;
  /** Absolute output directory of the built site. */
  outDir: string;
  /** Web URL of the documented repo (GitHub-style), or null to leave citations unlinked. */
  repoUrl: string | null;
}

export class UsageError extends Error {
  override name = "UsageError";
}

export const USAGE =
  "usage: site build --export <file|dir> [--out <dir>] [--repo-url <https-url>]\n" +
  "       site preview (--export <file|dir> | --out <dir>)";

const FLAGS = new Set(["--export", "--out", "--repo-url"]);

/** Parses `build|preview` plus flags. The default --out is a `site` directory next to the export. */
export function parseSiteArgs(argv: readonly string[]): SiteArgs {
  const [command, ...rest] = argv;
  if (command !== "build" && command !== "preview") throw new UsageError(USAGE);
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? "";
    const value = rest[i + 1];
    if (!FLAGS.has(flag)) throw new UsageError(`unknown argument ${flag}\n${USAGE}`);
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value\n${USAGE}`);
    }
    flags.set(flag, value);
  }

  const exportFlag = flags.get("--export");
  const outFlag = flags.get("--out");
  if (exportFlag === undefined && (command === "build" || outFlag === undefined)) {
    throw new UsageError(`--export is required\n${USAGE}`);
  }
  const exportFile = exportFlag === undefined ? null : resolve(resolveExportFile(exportFlag));
  const outDir = resolve(outFlag ?? resolve(dirname(exportFile ?? ""), "site"));
  return { command, exportFile, outDir, repoUrl: parseRepoUrl(flags.get("--repo-url")) };
}

function parseRepoUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`--repo-url must be an absolute http(s) URL, got ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`--repo-url must be an absolute http(s) URL, got ${value}`);
  }
  return url.href.replace(/\/+$/, "");
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (351 tests in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/site pnpm-lock.yaml
git commit -m "feat(site): load and validate the export; parse site arguments"
```

Ship. PR title: `feat(site): package, export loading and arguments`.

---

### Task 5: Astro build, Pagefind and the site CLI

**Ticket:** `[M5] site: Astro build, Pagefind and the site CLI`

**Files:**
- Modify: `pnpm-workspace.yaml` (whole file), `.gitignore`, `biome.json` (whole file), root `package.json` (`scripts`)
- Create: `packages/site/src/build.ts`, `cli.ts`, `demo.ts`, `site.ts`, `layouts/Layout.astro`, `pages/index.astro`, `test-site.ts`
- Test: `packages/site/src/site.test.ts`

**Interfaces:**
- Consumes: `loadExport`, `ExportError`, `parseSiteArgs` and `UsageError` (Task 4), and `fixtureExport` (Task 4).
- Produces:
  - `buildSite(exportFile: string, outDir: string, repoUrl: string | null): Promise<{ htmlPages: number }>`. It validates first, then runs `astro build` and then Pagefind.
  - `previewSite(outDir: string): Promise<void>`, which serves `http://127.0.0.1:4321/`.
  - `getSite()`, which returns the export the build renders. Task 7 changes it to return a `SiteModel`.
  - Root scripts `site:build`, `site:preview` and `site:demo`.
  - Test helpers in `test-site.ts`:
    - `runCli(args): CliResult`.
    - `buildFixtureSite(extraArgs?): BuiltSite`, where `BuiltSite` has `{ dir, outDir, stdout, read(path), cleanup() }`.
    - `htmlFiles(outDir): string[]`.
    - `brokenLinks(outDir): string[]`.
  - The `site build` exit codes: 0 when built; 1 on an `ExportError`, printed to stderr; 2 on a `UsageError`.

- [ ] **Step 1: Branch and add the dependencies**

```bash
git switch -c m5/site-build
```

Replace `pnpm-workspace.yaml` with the following. Set it *before* adding Astro, so that `sharp` is never installed.

```yaml
packages:
  - "packages/*"
onlyBuiltDependencies:
  - better-sqlite3
ignoredBuiltDependencies:
  - esbuild
  - tree-sitter-javascript
  - tree-sitter-python
  - tree-sitter-typescript
ignoredOptionalDependencies:
  - sharp
```

Append `.astro/` to `.gitignore`:

```text
.astro/
```

Replace `biome.json` with the following. Biome cannot see template usage, so it reports variables used only in `.astro` markup as unused.

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } },
  "linter": { "enabled": true, "rules": { "preset": "recommended" } },
  "overrides": [
    {
      "includes": ["**/*.astro"],
      "linter": {
        "rules": {
          "correctness": { "noUnusedVariables": "off", "noUnusedImports": "off" }
        }
      }
    }
  ]
}
```

```bash
pnpm --filter @repowiki/site add --save-exact astro@7.3.5 pagefind@1.5.2
pnpm install   # must not print "Ignored build scripts"
pnpm audit     # expect: No known vulnerabilities found
```


Add these to the root `package.json` `scripts`, after `index:repo`:

Replace:
```json
    "tracker:seed": "node scripts/tracker/run.ts",
    "index:repo": "node scripts/index-repo.ts"
  },
```
with:
```json
    "tracker:seed": "node scripts/tracker/run.ts",
    "index:repo": "node scripts/index-repo.ts",
    "site:build": "node packages/site/src/cli.ts build",
    "site:preview": "node packages/site/src/cli.ts preview",
    "site:demo": "node packages/site/src/demo.ts"
  },
```

- [ ] **Step 2: Write the test helpers and the failing tests**

`packages/site/src/test-site.ts` (a fixture builder; it does not count toward the PR size):

```ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureExport } from "./test-fixtures.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the site CLI in a child process, as `pnpm site:build` does. */
export function runCli(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export interface BuiltSite {
  dir: string;
  outDir: string;
  stdout: string;
  /** Contents of a built file, by its path relative to the output directory. */
  read(path: string): string;
  cleanup(): void;
}

/** Writes the fixture export to a temp dir and builds the site from it. */
export function buildFixtureSite(extraArgs: readonly string[] = []): BuiltSite {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-site-"));
  const exportFile = join(dir, "export.json");
  writeFileSync(exportFile, JSON.stringify(fixtureExport(), null, 2));
  const outDir = join(dir, "site");
  const result = runCli(["build", "--export", exportFile, "--out", outDir, ...extraArgs]);
  if (result.status !== 0) throw new Error(`site build failed:\n${result.stderr}${result.stdout}`);
  return {
    dir,
    outDir,
    stdout: result.stdout,
    read: (path) => readFileSync(join(outDir, path), "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Every built HTML file, relative to outDir, sorted. */
export function htmlFiles(outDir: string): string[] {
  return (readdirSync(outDir, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".html"))
    .map((file) => file.split("\\").join("/"))
    .sort();
}

/**
 * Same-site links that point nowhere: root-relative href/src values whose target file is
 * missing, and "#fragment" links whose id is not on the page. Returns "page -> link" strings.
 */
export function brokenLinks(outDir: string): string[] {
  const broken: string[] = [];
  for (const page of htmlFiles(outDir)) {
    const html = readFileSync(join(outDir, page), "utf8");
    for (const [, link = ""] of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      if (link.startsWith("#")) {
        if (link.length > 1 && !html.includes(`id="${link.slice(1)}"`)) {
          broken.push(`${page} -> ${link}`);
        }
        continue;
      }
      if (!link.startsWith("/") || link.startsWith("//")) continue;
      const path = decodeURIComponent(link.replace(/[?#].*$/, ""));
      const target = path.endsWith("/") ? `${path}index.html` : path;
      if (!existsSync(join(outDir, target))) broken.push(`${page} -> ${link}`);
    }
  }
  return broken;
}
```

`packages/site/src/site.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureExport } from "./test-fixtures.ts";
import { type BuiltSite, brokenLinks, buildFixtureSite, htmlFiles, runCli } from "./test-site.ts";

let site: BuiltSite;
beforeAll(() => {
  site = buildFixtureSite(["--repo-url", "https://github.com/acme/demo-repo"]);
}, 120_000);
afterAll(() => site.cleanup());

describe("site build", () => {
  it("renders the Main Page and a Pagefind index", () => {
    expect(site.read("index.html")).toContain("Welcome to the demo-repo wiki");
    expect(existsSync(join(site.outDir, "pagefind", "pagefind.js"))).toBe(true);
    expect(site.stdout).toMatch(/^built .+ \(\d+ HTML pages\)$/m);
  });

  it("has no same-site links to missing pages or anchors", () => {
    expect(htmlFiles(site.outDir).length).toBeGreaterThan(0);
    expect(brokenLinks(site.outDir)).toEqual([]);
  });

  it("references no off-site scripts, styles or fonts", () => {
    for (const page of htmlFiles(site.outDir)) {
      expect(site.read(page)).not.toMatch(
        /(?:src|href)="(?:https?:)?\/\/[^"]*\.(?:js|css|woff2?)"/,
      );
    }
  });
});

describe("site build input validation", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "repowiki-site-bad-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fails loudly on an export that violates the schema, and writes nothing", () => {
    const bad = { ...fixtureExport(), head: "not-a-sha" };
    writeFileSync(join(dir, "export.json"), JSON.stringify(bad));
    const result = runCli(["build", "--export", dir, "--out", join(dir, "out")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`invalid export ${join(dir, "export.json")}`);
    expect(result.stderr).toContain("head");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("fails loudly on a missing export", () => {
    const result = runCli(["build", "--export", join(dir, "missing.json")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read export");
  });

  it("exits 2 with usage on bad arguments", () => {
    const result = runCli(["build"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--export is required");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site/src/site.test.ts`
Expected: FAIL in `beforeAll` with `site build failed:` followed by `Cannot find module …/packages/site/src/cli.ts`.

- [ ] **Step 4: Implement**

`packages/site/src/build.ts`:

```ts
import { fileURLToPath } from "node:url";
import type { AstroInlineConfig } from "astro";
import { build, preview } from "astro";
import * as pagefind from "pagefind";
import { loadExport } from "./load.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Environment the Astro pages read (see site.ts). Telemetry is off: builds never touch the network. */
function setBuildEnv(exportFile: string, repoUrl: string | null): void {
  process.env.ASTRO_TELEMETRY_DISABLED = "1";
  process.env.REPOWIKI_EXPORT = exportFile;
  process.env.REPOWIKI_REPO_URL = repoUrl ?? "";
}

function astroConfig(outDir: string): AstroInlineConfig {
  return {
    root: ROOT,
    outDir,
    configFile: false,
    logLevel: "warn",
    compressHTML: false,
    trailingSlash: "always",
    build: { format: "directory", inlineStylesheets: "never" },
    devToolbar: { enabled: false },
    server: { host: "127.0.0.1", port: 4321 },
    // Emit every script as a file, so pages (and their snapshots) only reference hashed assets.
    vite: { build: { assetsInlineLimit: 0 } },
  };
}

export interface BuildResult {
  /** HTML files Pagefind read; only pages marked data-pagefind-body become search results. */
  htmlPages: number;
}

/** Validates the export, renders the static site into outDir, then indexes it with Pagefind. */
export async function buildSite(
  exportFile: string,
  outDir: string,
  repoUrl: string | null,
): Promise<BuildResult> {
  loadExport(exportFile);
  setBuildEnv(exportFile, repoUrl);
  await build(astroConfig(outDir));

  const { index, errors } = await pagefind.createIndex({ forceLanguage: "en" });
  try {
    if (index === undefined) throw new Error(`pagefind: ${errors.join("; ")}`);
    const added = await index.addDirectory({ path: outDir });
    if (added.errors.length > 0) throw new Error(`pagefind: ${added.errors.join("; ")}`);
    const written = await index.writeFiles({ outputPath: `${outDir}/pagefind` });
    if (written.errors.length > 0) throw new Error(`pagefind: ${written.errors.join("; ")}`);
    return { htmlPages: added.page_count };
  } finally {
    await pagefind.close();
  }
}

/** Serves a built site on http://127.0.0.1:4321/ until the process is stopped. */
export async function previewSite(outDir: string): Promise<void> {
  process.env.ASTRO_TELEMETRY_DISABLED = "1";
  await preview(astroConfig(outDir));
}
```

`packages/site/src/cli.ts`:

```ts
import { parseSiteArgs, UsageError } from "./args.ts";
import { buildSite, previewSite } from "./build.ts";
import { ExportError } from "./load.ts";

try {
  const args = parseSiteArgs(process.argv.slice(2));
  if (args.command === "build") {
    const { htmlPages } = await buildSite(args.exportFile ?? "", args.outDir, args.repoUrl);
    console.log(`built ${args.outDir} (${htmlPages} HTML pages)`);
  } else {
    await previewSite(args.outDir);
  }
} catch (error) {
  if (error instanceof UsageError || error instanceof ExportError) {
    console.error(error.message);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
  throw error;
}
```

`packages/site/src/site.ts`:

```ts
import type { WikiExport } from "@repowiki/core";
import { loadExport } from "./load.ts";

export interface Site {
  wiki: WikiExport;
  repoUrl: string | null;
}

let cached: Site | null = null;

/** The export the current build renders, loaded once per build from REPOWIKI_EXPORT. */
export function getSite(): Site {
  if (cached !== null) return cached;
  const exportFile = process.env.REPOWIKI_EXPORT;
  if (exportFile === undefined || exportFile === "") {
    throw new Error("REPOWIKI_EXPORT is not set; build the site with `pnpm site:build`");
  }
  const repoUrl = process.env.REPOWIKI_REPO_URL;
  cached = {
    wiki: loadExport(exportFile),
    repoUrl: repoUrl === undefined || repoUrl === "" ? null : repoUrl,
  };
  return cached;
}
```

`packages/site/src/layouts/Layout.astro`:

```astro
---
import { getSite } from "../site.ts";

interface Props {
  /** Shown in the browser tab as "<title> - <repo> wiki". */
  title: string;
}

const { title } = Astro.props;
const { wiki } = getSite();
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title} - {wiki.repo} wiki</title>
  </head>
  <body>
    <main id="content">
      <slot />
    </main>
  </body>
</html>
```

`packages/site/src/pages/index.astro`:

```astro
---
import Layout from "../layouts/Layout.astro";
import { getSite } from "../site.ts";

const { wiki } = getSite();
---
<Layout title="Main page">
  <h1 class="page-title">Welcome to the {wiki.repo} wiki</h1>
  <p>{wiki.pages.length} articles generated from commit <code>{wiki.head.slice(0, 7)}</code>.</p>
</Layout>
```

`packages/site/src/demo.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite, previewSite } from "./build.ts";
import { fixtureExport } from "./test-fixtures.ts";

// Builds the fixture export and serves it, so the reader can be browsed before a real build exists.
const dir = join(tmpdir(), "repowiki-demo");
mkdirSync(dir, { recursive: true });
const exportFile = join(dir, "export.json");
writeFileSync(exportFile, `${JSON.stringify(fixtureExport(), null, 2)}\n`);
const outDir = join(dir, "site");
await buildSite(exportFile, outDir, "https://github.com/acme/demo-repo");
console.log(`demo export ${exportFile}\nserving ${outDir} at http://127.0.0.1:4321/`);
await previewSite(outDir);
```

- [ ] **Step 5: Run the check, and build once by hand**

```bash
pnpm check
pnpm site:demo
```

Expected: `pnpm check` passes (357 tests in the trial). `pnpm site:demo` prints `demo export …/repowiki-demo/export.json` and `serving … at http://127.0.0.1:4321/`. Opening that URL shows "Welcome to the demo-repo wiki". Stop it with Ctrl-C.

- [ ] **Step 6: Commit and ship**

```bash
git add .gitignore biome.json package.json pnpm-workspace.yaml pnpm-lock.yaml packages/site
git commit -m "feat(site): build the static site with Astro and index it with Pagefind"
```

Ship. PR title: `feat(site): Astro build, Pagefind and the site CLI`. Paste the dependency review table from this plan into the PR body.

---

### Task 6: Page shell and stylesheet

**Ticket:** `[M5] site: page shell and stylesheet`

**Files:**
- Modify: `packages/site/src/layouts/Layout.astro` (whole file)
- Create: `packages/site/src/styles/wiki.css`
- Test: `packages/site/src/site.test.ts` (append)

**Interfaces:**
- Produces:
  - The shell every page shares: skip link, header with the site name, `<nav class="site-nav" aria-label="Site">`, `<main id="content" class="content">`, and a footer with the head sha.
  - A `head` slot (`<Fragment slot="head">…</Fragment>`) for page-specific `<head>` tags.
  - The CSS custom properties that later blocks reuse: `--bg`, `--bg-subtle`, `--text`, `--text-muted`, `--border`, `--border-subtle`, `--link`, `--link-visited`, `--notice-bg`, `--notice-border`, `--font-sans`, `--font-serif` and `--font-mono`.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/site-shell
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/site/src/site.test.ts`:

```ts
describe("page shell", () => {
  it("links one local stylesheet with dark-mode and phone-width rules", () => {
    const html = site.read("index.html");
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="(\/_astro\/[^"]+\.css)"/g)];
    expect(sheets).toHaveLength(1);
    const css = site.read(sheets[0]?.[1] ?? "");
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).toMatch(/max-width:720px|width<=720px/);
  });

  it("has a skip link, a labelled site nav and a main landmark", () => {
    const html = site.read("index.html");
    expect(html).toContain('<a class="skip-link" href="#content">Jump to content</a>');
    expect(html).toContain('<nav class="site-nav" aria-label="Site">');
    expect(html).toContain('<main id="content" class="content">');
    expect(html).toContain("<title>Main page - demo-repo wiki</title>");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site/src/site.test.ts`
Expected: FAIL, 2 failed. No stylesheet link is found, and there is no skip link.

- [ ] **Step 4: Implement**

Replace `packages/site/src/layouts/Layout.astro` with:

```astro
---
import "../styles/wiki.css";
import { getSite } from "../site.ts";

interface Props {
  /** Shown in the browser tab as "<title> - <repo> wiki". */
  title: string;
}

const { title } = Astro.props;
const { wiki } = getSite();
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <link rel="icon" href="data:," />
    <title>{title} - {wiki.repo} wiki</title>
    <slot name="head" />
  </head>
  <body>
    <a class="skip-link" href="#content">Jump to content</a>
    <header class="site-header">
      <a class="site-name" href="/">{wiki.repo}<span class="site-tagline">wiki</span></a>
    </header>
    <div class="page">
      <nav class="site-nav" aria-label="Site">
        <ul>
          <li><a href="/">Main page</a></li>
        </ul>
      </nav>
      <main id="content" class="content">
        <slot />
      </main>
    </div>
    <footer class="site-footer">
      Generated by RepoWiki from <code>{wiki.repo}</code> at commit
      <code>{wiki.head.slice(0, 7)}</code>.
    </footer>
  </body>
</html>
```

Create `packages/site/src/styles/wiki.css`:

```css
/* RepoWiki reader. System fonts, a Wikipedia-like scale, light and dark themes, phone widths. */
:root {
  --bg: #ffffff;
  --bg-subtle: #f8f9fa;
  --text: #202122;
  --text-muted: #54595d;
  --border: #a2a9b1;
  --border-subtle: #c8ccd1;
  --link: #3366cc;
  --link-visited: #795cb2;
  --link-external: #3366cc;
  --notice-bg: #fef6e7;
  --notice-border: #fc3;
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-serif: "Linux Libertine", Georgia, "Times New Roman", Times, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101418;
    --bg-subtle: #202122;
    --text: #eaecf0;
    --text-muted: #a2a9b1;
    --border: #72777d;
    --border-subtle: #54595d;
    --link: #88a3e8;
    --link-visited: #a799cd;
    --link-external: #88a3e8;
    --notice-bg: #3d2f12;
    --notice-border: #a66200;
    color-scheme: dark;
  }
}

* {
  box-sizing: border-box;
}

html {
  font-size: 100%;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 1rem;
  line-height: 1.6;
}

a {
  color: var(--link);
  text-decoration: none;
}

a:visited {
  color: var(--link-visited);
}

a:hover {
  text-decoration: underline;
}

a:focus-visible,
button:focus-visible,
input:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}

code {
  font-family: var(--font-mono);
  font-size: 0.875em;
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: 2px;
  padding: 1px 4px;
}

.skip-link {
  position: absolute;
  left: -999px;
}

.skip-link:focus {
  left: 1rem;
  top: 0.5rem;
  background: var(--bg);
  padding: 0.25rem 0.5rem;
}

.site-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--border-subtle);
}

.site-name {
  font-family: var(--font-serif);
  font-size: 1.5rem;
  color: var(--text);
}

.site-name:visited {
  color: var(--text);
}

.site-tagline {
  margin-left: 0.4rem;
  font-size: 0.9rem;
  color: var(--text-muted);
}

.page {
  display: flex;
  max-width: 82rem;
  margin: 0 auto;
}

.site-nav {
  flex: 0 0 11rem;
  padding: 1rem 1.5rem;
  font-size: 0.875rem;
}

.site-nav ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.site-nav li {
  margin: 0.3rem 0;
}

.content {
  flex: 1 1 auto;
  min-width: 0;
  padding: 1rem 1.5rem 2rem;
}

.page-title {
  font-family: var(--font-serif);
  font-size: 1.8rem;
  font-weight: normal;
  line-height: 1.3;
  margin: 0 0 0.25rem;
  padding-bottom: 0.25rem;
  border-bottom: 1px solid var(--border);
}

.site-footer {
  border-top: 1px solid var(--border-subtle);
  padding: 1rem 1.5rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}

@media (max-width: 720px) {
  .page {
    display: block;
  }

  .site-nav {
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .site-nav ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0 1rem;
  }

  .content {
    padding: 0.75rem 1rem 2rem;
  }
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (359 tests in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/site
git commit -m "feat(site): add the page shell and wiki stylesheet"
```

Ship. PR title: `feat(site): page shell and stylesheet`.

---

### Task 7: Site model and inline renderer

**Ticket:** `[M5] site: site model and inline renderer`

**Files:**
- Create: `packages/site/src/urls.ts`, `packages/site/src/model.ts`, `packages/site/src/inline.ts`
- Modify: `packages/site/src/site.ts` (whole file)
- Test: `packages/site/src/model.test.ts`, `packages/site/src/inline.test.ts`

**Interfaces:**
- Consumes: `WikiExport`, `Feature`, `Revision` and `FEATURE_ID_MAX_LENGTH` from `@repowiki/core`, `loadExport` (Task 4), and `fixtureExport` (Task 4).
- Produces:
  - `urls.ts`:
    - `articleUrl(id)`, which returns `/wiki/<id>/`.
    - `historyUrl(id)`.
    - `oldRevisionUrl(id, n)`.
    - `diffUrl(id, n)`.
    - `previewUrl(id)`.
    - `wikipediaUrl(title)`.
  - `model.ts`:
    - `interface AliasRoute { slug; alias; targets: string[] }`.
    - `interface SiteModel { wiki; repoUrl; features: ReadonlyMap<string, Feature>; pages: ReadonlyMap<string, Revision>; history: ReadonlyMap<string, readonly Revision[]>; aliases: readonly AliasRoute[] }`.
    - `aliasSlug(alias)`.
    - `hasArticleRoute(site, id)`: in this task, only active or retired features with a page. Task 11 widens it.
    - `finalTarget(site, id)`.
    - `featureLink(site, id): { href; title } | null`.
    - `buildSiteModel(wiki, repoUrl): SiteModel`.
  - `inline.ts`:
    - `interface InlineOptions { link(id): { href; title } | null; links?: boolean }`.
    - `escapeHtml(text)`.
    - `renderInline(text, options)`.
  - `getSite(): SiteModel`.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/site-model
```

- [ ] **Step 2: Write the failing tests**

`packages/site/src/model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { aliasSlug, buildSiteModel, featureLink, finalTarget, hasArticleRoute } from "./model.ts";
import { fixtureExport } from "./test-fixtures.ts";

const site = buildSiteModel(fixtureExport(), null);

describe("aliasSlug", () => {
  it.each([
    ["signal pipeline", "signal-pipeline"],
    ["SIGNALS_TABLE", "signals-table"],
    ["/api/signals", "api-signals"],
    ["Café façade", "cafe-facade"],
    ["  ---  ", ""],
    [`${"a".repeat(63)} b`, "a".repeat(63)],
  ])("slugs %j as %j", (alias, slug) => {
    expect(aliasSlug(alias)).toBe(slug);
  });
});

describe("buildSiteModel", () => {
  it("routes active and retired features that have a page", () => {
    const routed = [...site.features.keys()].filter((id) => hasArticleRoute(site, id));
    expect(routed.sort()).toEqual(["deliverables", "exporter", "signals"]);
    expect(hasArticleRoute(site, "scheduler")).toBe(false);
    expect(hasArticleRoute(site, "ghost")).toBe(false);
  });

  it("resolves redirects and links only routed features", () => {
    expect(finalTarget(site, "legacy-signals")).toBe("signals");
    expect(finalTarget(site, "signals")).toBe("signals");
    expect(featureLink(site, "deliverables")).toEqual({
      href: "/wiki/deliverables/",
      title: "Deliverables",
    });
    expect(featureLink(site, "scheduler")).toBeNull();
    expect(featureLink(site, "ghost")).toBeNull();
  });

  it("makes alias routes, merging shared slugs and skipping ones that shadow feature ids", () => {
    expect(site.aliases).toEqual([
      { slug: "api-signals", alias: "/api/signals", targets: ["signals"] },
      { slug: "deliverable-records", alias: "deliverable records", targets: ["deliverables"] },
      { slug: "signal-pipeline", alias: "signal pipeline", targets: ["signals", "deliverables"] },
      { slug: "signals-table", alias: "SIGNALS_TABLE", targets: ["signals"] },
    ]);
  });

  it("indexes pages and full history by feature id", () => {
    expect(site.pages.get("signals")?.id).toBe("signals-2");
    expect(site.history.get("signals")?.map((r) => r.id)).toEqual(["signals-1", "signals-2"]);
  });
});
```

`packages/site/src/inline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { escapeHtml, type InlineOptions, renderInline } from "./inline.ts";

const known: InlineOptions = {
  link: (id) =>
    id === "deliverables" ? { href: "/wiki/deliverables/", title: 'The "Deliverables"' } : null,
};

describe("renderInline", () => {
  it("escapes raw HTML in claim text", () => {
    expect(renderInline("a <b>bold</b> & 'quoted' claim", known)).toBe(
      "a &lt;b&gt;bold&lt;/b&gt; &amp; &#39;quoted&#39; claim",
    );
  });

  it("renders bold, italic and code, keeping code literal", () => {
    expect(renderInline("**Signals** are *scored* by `a*b*c <x>`.", known)).toBe(
      "<b>Signals</b> are <i>scored</i> by <code>a*b*c &lt;x&gt;</code>.",
    );
  });

  it("leaves lone and spaced asterisks alone", () => {
    expect(renderInline("2 * 3 * 4 and a*", known)).toBe("2 * 3 * 4 and a*");
  });

  it("links known features with their title, an optional label and a preview id", () => {
    expect(renderInline("See [[deliverables]] and [[ deliverables | records ]].", known)).toBe(
      'See <a class="wikilink" href="/wiki/deliverables/" title="The &quot;Deliverables&quot;" data-preview="deliverables">The &quot;Deliverables&quot;</a>' +
        ' and <a class="wikilink" href="/wiki/deliverables/" title="The &quot;Deliverables&quot;" data-preview="deliverables">records</a>.',
    );
  });

  it("renders unknown features as plain text", () => {
    expect(renderInline("[[ghost]] and [[ghost|<the old one>]]", known)).toBe(
      "ghost and &lt;the old one&gt;",
    );
  });

  it("links Wikipedia titles with underscores and percent-encoding", () => {
    expect(renderInline("[[wp:Exponential backoff]] [[wp:C++ (language)|C++]]", known)).toBe(
      '<a class="external" href="https://en.wikipedia.org/wiki/Exponential_backoff" title="Wikipedia: Exponential backoff">Exponential backoff</a> ' +
        '<a class="external" href="https://en.wikipedia.org/wiki/C%2B%2B_(language)" title="Wikipedia: C++ (language)">C++</a>',
    );
  });

  it("renders labels only when links are off", () => {
    expect(
      renderInline("**[[deliverables|records]]** via [[wp:Backoff]]", { ...known, links: false }),
    ).toBe("<b>records</b> via Backoff");
  });

  it("ignores placeholder characters smuggled into the text", () => {
    expect(
      renderInline(`x${String.fromCharCode(0xe000)}0${String.fromCharCode(0xe001)}y \`z\``, known),
    ).toBe("x0y <code>z</code>");
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-special characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site/src/model.test.ts packages/site/src/inline.test.ts`
Expected: FAIL with `Error: Cannot find module './model.ts'` and `'./inline.ts'`.

- [ ] **Step 4: Implement**

`packages/site/src/urls.ts`:

```ts
/** Every page URL the site emits. Feature ids and alias slugs are URL-safe kebab-case. */
export const articleUrl = (id: string): string => `/wiki/${id}/`;
export const historyUrl = (id: string): string => `/wiki/${id}/history/`;
/** n is the 1-based position in the feature's history, oldest first. */
export const oldRevisionUrl = (id: string, n: number): string => `/wiki/${id}/history/${n}/`;
/** Diff of revision n against revision n - 1. */
export const diffUrl = (id: string, n: number): string => `/wiki/${id}/diff/${n}/`;
export const previewUrl = (id: string): string => `/api/preview/${id}.json`;

/** English Wikipedia article URL for a [[wp:Title]] token. */
export function wikipediaUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.trim().replace(/ /g, "_"))}`;
}
```

`packages/site/src/model.ts`:

```ts
import {
  FEATURE_ID_MAX_LENGTH,
  type Feature,
  type Revision,
  type WikiExport,
} from "@repowiki/core";
import { articleUrl } from "./urls.ts";

/** An alias URL /wiki/<slug>/: a redirect when it has one target, a disambiguation page otherwise. */
export interface AliasRoute {
  slug: string;
  /** The first spelling that produced this slug. */
  alias: string;
  /** Feature ids, already resolved through redirects, in manifest order. */
  targets: string[];
}

export interface SiteModel {
  wiki: WikiExport;
  repoUrl: string | null;
  features: ReadonlyMap<string, Feature>;
  /** Current revision per feature id. */
  pages: ReadonlyMap<string, Revision>;
  /** Every revision per feature id, oldest first. */
  history: ReadonlyMap<string, readonly Revision[]>;
  /** Sorted by slug. Never shadows a feature id. */
  aliases: readonly AliasRoute[];
}

/** URL slug for an alias: ASCII lowercase kebab-case, at most FEATURE_ID_MAX_LENGTH characters. */
export function aliasSlug(alias: string): string {
  return alias
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FEATURE_ID_MAX_LENGTH)
    .replace(/-+$/, "");
}

/** True when /wiki/<id>/ is a page: an active or retired feature that has a revision. */
export function hasArticleRoute(site: SiteModel, id: string): boolean {
  const kind = site.features.get(id)?.status.kind;
  return (kind === "active" || kind === "retired") && site.pages.has(id);
}

/** Follows redirects to the feature a reader should land on. The manifest forbids cycles. */
export function finalTarget(site: SiteModel, id: string): string {
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    const status = site.features.get(current)?.status;
    if (status?.kind !== "redirect" || seen.has(current)) return current;
    seen.add(current);
    current = status.to;
  }
}

/** Link target for [[id]] tokens and See also entries, or null when the id has no page. */
export function featureLink(site: SiteModel, id: string): { href: string; title: string } | null {
  const feature = site.features.get(id);
  if (feature === undefined || !hasArticleRoute(site, id)) return null;
  return { href: articleUrl(id), title: feature.title };
}

export function buildSiteModel(wiki: WikiExport, repoUrl: string | null): SiteModel {
  const site: SiteModel = {
    wiki,
    repoUrl,
    features: new Map(wiki.manifest.features.map((feature) => [feature.id, feature])),
    pages: new Map(wiki.pages.map((page) => [page.featureId, page])),
    history: new Map(Object.entries(wiki.history)),
    aliases: [],
  };

  const routes = new Map<string, AliasRoute>();
  for (const feature of wiki.manifest.features) {
    if (!hasArticleRoute(site, feature.id)) continue;
    const target = finalTarget(site, feature.id);
    for (const alias of feature.aliases) {
      const slug = aliasSlug(alias);
      if (slug === "" || site.features.has(slug)) continue;
      const route = routes.get(slug) ?? { slug, alias, targets: [] };
      if (!route.targets.includes(target)) route.targets.push(target);
      routes.set(slug, route);
    }
  }
  site.aliases = [...routes.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return site;
}
```

`packages/site/src/inline.ts`. The placeholder characters are built with `String.fromCharCode`. Never write them as `\uE000` escapes, because `pnpm format` turns those into invisible literal characters.

```ts
import { wikipediaUrl } from "./urls.ts";

export interface InlineOptions {
  /** Resolves a [[featureId]] token; null renders the label as plain text. */
  link(id: string): { href: string; title: string } | null;
  /** False renders every link token as its plain label (hover previews). Default true. */
  links?: boolean;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

const TOKEN = /`([^`]+)`|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
// Placeholders use private-use characters, built at runtime so no formatter rewrites them.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const PLACEHOLDER_CHARS = new RegExp(`[${OPEN}${CLOSE}]`, "g");
const SLOT = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

/**
 * Renders claim text to HTML. Everything is escaped; the only markup produced is **bold**,
 * *italic*, `code`, [[featureId]] / [[featureId|label]] and [[wp:Title]] / [[wp:Title|label]].
 */
export function renderInline(text: string, options: InlineOptions): string {
  const slots: string[] = [];
  const hold = (html: string): string => `${OPEN}${slots.push(html) - 1}${CLOSE}`;
  const held = text
    .replace(PLACEHOLDER_CHARS, "")
    .replace(TOKEN, (_match, code: string | undefined, target = "", label?: string) =>
      hold(
        code !== undefined
          ? `<code>${escapeHtml(code)}</code>`
          : renderLink(target.trim(), label?.trim(), options),
      ),
    );
  return escapeHtml(held)
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>")
    .replace(/\*(?=\S)([^*]+?)(?<=\S)\*/g, "<i>$1</i>")
    .replace(SLOT, (_match, index: string) => slots[Number(index)] ?? "");
}

function renderLink(target: string, label: string | undefined, options: InlineOptions): string {
  const links = options.links !== false;
  if (target.startsWith("wp:")) {
    const title = target.slice(3).trim();
    const text = escapeHtml(label ?? title);
    if (!links || title === "") return text;
    return `<a class="external" href="${escapeHtml(wikipediaUrl(title))}" title="Wikipedia: ${escapeHtml(title)}">${text}</a>`;
  }
  const resolved = options.link(target);
  const text = escapeHtml(label ?? resolved?.title ?? target);
  if (!links || resolved === null) return text;
  // data-preview is read by the hover-preview script.
  return `<a class="wikilink" href="${escapeHtml(resolved.href)}" title="${escapeHtml(resolved.title)}" data-preview="${escapeHtml(target)}">${text}</a>`;
}
```

Replace `packages/site/src/site.ts` with:

```ts
import { loadExport } from "./load.ts";
import { buildSiteModel, type SiteModel } from "./model.ts";

let cached: SiteModel | null = null;

/** The site model the current build renders, built once per build from REPOWIKI_EXPORT. */
export function getSite(): SiteModel {
  if (cached !== null) return cached;
  const exportFile = process.env.REPOWIKI_EXPORT;
  if (exportFile === undefined || exportFile === "") {
    throw new Error("REPOWIKI_EXPORT is not set; build the site with `pnpm site:build`");
  }
  const repoUrl = process.env.REPOWIKI_REPO_URL;
  cached = buildSiteModel(
    loadExport(exportFile),
    repoUrl === undefined || repoUrl === "" ? null : repoUrl,
  );
  return cached;
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (378 tests in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/site
git commit -m "feat(site): add the site model and inline claim renderer"
```

Ship. PR title: `feat(site): site model and inline renderer`.

---

### Task 8: References and code citation links

**Ticket:** `[M5] site: references and code citation links`

**Files:**
- Create: `packages/site/src/references.ts`
- Test: `packages/site/src/references.test.ts`

**Interfaces:**
- Consumes: `Citation`, `CodeCitation`, `CommitCitation` and `Revision` from `@repowiki/core`, and `escapeHtml` (Task 7).
- Produces:
  - `interface RefMarker { n; id }`, `interface RefNote { n; citation; backlinks: string[] }` and `interface References { notes; markers: ReadonlyMap<claimId, RefMarker[]> }`.
  - `citationKey(citation)`.
  - `collectReferences(revision): References`.
  - `markersHtml(markers)`.
  - `backlinksHtml(note)`.
  - `codeUrl(repoUrl, citation)`.
  - `citationHtml(citation, repoUrl | null)`.
  - Footnote anchors `cite-ref-<n>-<k>` and notes `cite-note-<n>`.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/site-references
```

- [ ] **Step 2: Write the failing tests**

`packages/site/src/references.test.ts`:

```ts
import {
  bodyClaim,
  codeCitation,
  commitCitation,
  leadClaim,
  makeRevision,
  SHA_A,
  SHA_B,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  backlinksHtml,
  citationHtml,
  codeUrl,
  collectReferences,
  markersHtml,
} from "./references.ts";
import { fixtureExport } from "./test-fixtures.ts";

const REPO = "https://github.com/acme/demo-repo";
const signals = fixtureExport().pages.find((page) => page.featureId === "signals");
if (signals === undefined) throw new Error("fixture has no signals page");

describe("collectReferences", () => {
  it("numbers citations in reading order and reuses numbers for identical citations", () => {
    const refs = collectReferences(signals);
    expect(refs.notes.map((note) => [note.n, note.backlinks])).toEqual([
      [1, ["cite-ref-1-0", "cite-ref-1-1", "cite-ref-1-2"]],
      [2, ["cite-ref-2-0", "cite-ref-2-1"]],
      [3, ["cite-ref-3-0"]],
      [4, ["cite-ref-4-0"]],
      [5, ["cite-ref-5-0"]],
    ]);
    expect(refs.markers.get("s-o2")).toEqual([
      { n: 1, id: "cite-ref-1-1" },
      { n: 2, id: "cite-ref-2-0" },
    ]);
    expect(refs.markers.get("s-lead-1")).toEqual([]);
  });

  it("treats the same lines at another sha as a different source", () => {
    const claim = bodyClaim({ citations: [codeCitation(), codeCitation({ sha: SHA_B })] });
    const revision = makeRevision({
      sections: [
        { key: "lead", claims: [leadClaim()] },
        { key: "overview", claims: [claim] },
      ],
    });
    expect(collectReferences(revision).notes.map((note) => note.n)).toEqual([1, 2]);
  });
});

describe("markersHtml and backlinksHtml", () => {
  it("renders footnote markers that link to their note", () => {
    expect(markersHtml([{ n: 2, id: "cite-ref-2-0" }])).toBe(
      '<sup class="reference" id="cite-ref-2-0"><a href="#cite-note-2">[2]</a></sup>',
    );
  });

  it("renders ^ for one use and lettered back-links for several", () => {
    const one = { n: 1, citation: commitCitation(), backlinks: ["cite-ref-1-0"] };
    expect(backlinksHtml(one)).toBe(
      '<a class="ref-back" href="#cite-ref-1-0" aria-label="Back to the citing claim">^</a>',
    );
    const two = { ...one, backlinks: ["cite-ref-1-0", "cite-ref-1-1"] };
    expect(backlinksHtml(two)).toBe(
      '^ <a class="ref-back" href="#cite-ref-1-0" aria-label="Back to citing claim 1">a</a> <a class="ref-back" href="#cite-ref-1-1" aria-label="Back to citing claim 2">b</a>',
    );
  });
});

describe("citationHtml", () => {
  it("renders a code citation as path:Lstart-end@sha with a permalink", () => {
    expect(citationHtml(codeCitation(), REPO)).toBe(
      `<a class="external" href="${REPO}/blob/${SHA_A}/src/signals/ingest.py#L10-L24"><code>src/signals/ingest.py:L10-24@aaaaaaa</code></a> (<code>ingest_chunk</code>)`,
    );
  });

  it("percent-encodes each path segment and uses one line number for one-line ranges", () => {
    const odd = codeCitation({ path: "src/a b/c#1%.py", startLine: 7, endLine: 7, symbol: null });
    expect(codeUrl(REPO, odd)).toBe(`${REPO}/blob/${SHA_A}/src/a%20b/c%231%25.py#L7`);
    expect(citationHtml(odd, null)).toBe("<code>src/a b/c#1%.py:L7@aaaaaaa</code>");
  });

  it("renders a commit citation with its subject and PR", () => {
    expect(citationHtml(commitCitation({ subject: 'fix: "quote" <b>' }), REPO)).toBe(
      `Commit <a class="external" href="${REPO}/commit/${SHA_A}"><code>aaaaaaa</code></a>: &quot;fix: &quot;quote&quot; &lt;b&gt;&quot; (<a class="external" href="${REPO}/pull/45">PR #45</a>)`,
    );
    expect(citationHtml(commitCitation({ pr: null }), null)).toBe(
      "Commit <code>aaaaaaa</code>: &quot;feat: add signal ingestion&quot;",
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site/src/references.test.ts`
Expected: FAIL with `Error: Cannot find module './references.ts'`.

- [ ] **Step 4: Implement**

`packages/site/src/references.ts`:

```ts
import type { Citation, CodeCitation, CommitCitation, Revision } from "@repowiki/core";
import { escapeHtml } from "./inline.ts";

/** One footnote marker after a claim: [n], with a unique anchor for the back-link. */
export interface RefMarker {
  n: number;
  id: string;
}

/** One entry of the References list. backlinks are the marker ids that cite it, in order. */
export interface RefNote {
  n: number;
  citation: Citation;
  backlinks: string[];
}

export interface References {
  notes: RefNote[];
  /** Markers per claim id. */
  markers: ReadonlyMap<string, RefMarker[]>;
}

/** Identical citations share one number, as Wikipedia's named references do. */
export function citationKey(citation: Citation): string {
  return citation.kind === "code"
    ? `code ${citation.sha} ${citation.startLine} ${citation.endLine} ${citation.path}`
    : `commit ${citation.sha}`;
}

/** Numbers citations in reading order across the page's sections. */
export function collectReferences(revision: Revision): References {
  const byKey = new Map<string, RefNote>();
  const markers = new Map<string, RefMarker[]>();
  for (const section of revision.sections) {
    for (const claim of section.claims) {
      const claimMarkers: RefMarker[] = [];
      for (const citation of claim.citations) {
        const key = citationKey(citation);
        let note = byKey.get(key);
        if (note === undefined) {
          note = { n: byKey.size + 1, citation, backlinks: [] };
          byKey.set(key, note);
        }
        const id = `cite-ref-${note.n}-${note.backlinks.length}`;
        note.backlinks.push(id);
        claimMarkers.push({ n: note.n, id });
      }
      markers.set(claim.id, claimMarkers);
    }
  }
  return { notes: [...byKey.values()], markers };
}

export function markersHtml(markers: readonly RefMarker[]): string {
  return markers
    .map(
      (m) => `<sup class="reference" id="${m.id}"><a href="#cite-note-${m.n}">[${m.n}]</a></sup>`,
    )
    .join("");
}

/** "^" for a single use; "^ a b c" when several claims cite the same source. */
export function backlinksHtml(note: RefNote): string {
  if (note.backlinks.length === 1) {
    return `<a class="ref-back" href="#${note.backlinks[0]}" aria-label="Back to the citing claim">^</a>`;
  }
  const letters = note.backlinks.map(
    (id, i) =>
      `<a class="ref-back" href="#${id}" aria-label="Back to citing claim ${i + 1}">${String.fromCharCode(97 + (i % 26))}</a>`,
  );
  return `^ ${letters.join(" ")}`;
}

const short = (sha: string): string => sha.slice(0, 7);
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** GitHub-style permalink to the cited lines at the cited sha. */
export function codeUrl(repoUrl: string, c: CodeCitation): string {
  const lines = c.endLine > c.startLine ? `L${c.startLine}-L${c.endLine}` : `L${c.startLine}`;
  return `${repoUrl}/blob/${c.sha}/${encodePath(c.path)}#${lines}`;
}

function link(href: string | null, html: string): string {
  return href === null ? html : `<a class="external" href="${escapeHtml(href)}">${html}</a>`;
}

/** A References entry: path:Lstart-end@sha for code, sha "subject" (PR #n) for commits. */
export function citationHtml(citation: Citation, repoUrl: string | null): string {
  return citation.kind === "code" ? codeHtml(citation, repoUrl) : commitHtml(citation, repoUrl);
}

function codeHtml(c: CodeCitation, repoUrl: string | null): string {
  const lines = c.endLine > c.startLine ? `L${c.startLine}-${c.endLine}` : `L${c.startLine}`;
  const label = `<code>${escapeHtml(c.path)}:${lines}@${short(c.sha)}</code>`;
  const symbol = c.symbol === null ? "" : ` (<code>${escapeHtml(c.symbol)}</code>)`;
  return link(repoUrl === null ? null : codeUrl(repoUrl, c), label) + symbol;
}

function commitHtml(c: CommitCitation, repoUrl: string | null): string {
  const sha = link(
    repoUrl === null ? null : `${repoUrl}/commit/${c.sha}`,
    `<code>${short(c.sha)}</code>`,
  );
  const pr =
    c.pr === null
      ? ""
      : ` (${link(repoUrl === null ? null : `${repoUrl}/pull/${c.pr}`, `PR #${c.pr}`)})`;
  return `Commit ${sha}: &quot;${escapeHtml(c.subject)}&quot;${pr}`;
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (385 tests in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/site
git commit -m "feat(site): number references and link code citations"
```

Ship. PR title: `feat(site): references and code citation links`.

---

### Task 9: Article view

**Ticket:** `[M5] site: article view`

**Files:**
- Create: `packages/site/src/format.ts`, `packages/site/src/article.ts`
- Test: `packages/site/src/article.test.ts`

**Interfaces:**
- Consumes: `renderInline` and `escapeHtml` (Task 7), `featureLink` and `SiteModel` (Task 7), and `collectReferences`, `markersHtml`, `backlinksHtml` and `citationHtml` (Task 8).
- Produces:
  - `formatDate(iso)`, `formatNumber(n)` and `shortSha(sha)`.
  - `SECTION_TITLES` and `STALE_NOTICE`.
  - `interface SectionView { anchor; title; html; stale }`.
  - `interface ArticleView { featureId; title; notice: string | null; leadHtml; leadStale; toc: { anchor; title }[]; sections: SectionView[]; seeAlso: { href; title }[]; references: { n; html; backlinks }[]; infobox: { label; html }[]; lastEdited }`.
  - `articleView(site, revision): ArticleView`.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/article-view
```

- [ ] **Step 2: Write the failing tests**

`packages/site/src/article.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { articleView } from "./article.ts";
import { formatDate, formatNumber } from "./format.ts";
import { buildSiteModel } from "./model.ts";
import { fixtureExport } from "./test-fixtures.ts";

const REPO = "https://github.com/acme/demo-repo";
const site = buildSiteModel(fixtureExport(), REPO);
const page = (id: string) => {
  const revision = site.pages.get(id);
  if (revision === undefined) throw new Error(`no page ${id}`);
  return revision;
};

describe("formatDate and formatNumber", () => {
  it("reads the date as written, whatever the offset", () => {
    expect(formatDate("2026-03-10T23:30:00-08:00")).toBe("10 March 2026");
    expect(formatDate("2026-01-01T00:10:00+14:00")).toBe("1 January 2026");
  });

  it("groups thousands", () => {
    expect(formatNumber(1312)).toBe("1,312");
  });
});

describe("articleView", () => {
  const view = articleView(site, page("signals"));

  it("builds the table of contents from stored sections, then See also and References", () => {
    expect(view.toc.map((entry) => entry.title)).toEqual([
      "Overview",
      "How it works",
      "Data flow",
      "History",
      "Known limitations",
      "See also",
      "References",
    ]);
  });

  it("flags only sections that hold a stale claim", () => {
    expect(view.sections.filter((s) => s.stale).map((s) => s.anchor)).toEqual(["how-it-works"]);
    expect(view.leadStale).toBe(false);
  });

  it("marks the lead stale when a claim it supports is stale", () => {
    const revision = page("signals");
    const [lead, ...rest] = revision.sections;
    if (lead === undefined) throw new Error("no lead");
    const leadClaims = lead.claims.map((claim) => ({ ...claim, supports: ["s-h1"] }));
    const stale = articleView(site, {
      ...revision,
      sections: [{ ...lead, claims: leadClaims }, ...rest],
    });
    expect(stale.leadStale).toBe(true);
  });

  it("drops See also entries that have no page", () => {
    expect(view.seeAlso).toEqual([{ href: "/wiki/deliverables/", title: "Deliverables" }]);
  });

  it("fills the infobox from the revision and the feature's aliases", () => {
    expect(view.infobox.map((row) => [row.label, row.html])).toEqual([
      ["Also known as", "signal pipeline, SIGNALS_TABLE, /api/signals"],
      ["Files", "4"],
      ["Lines of code", "1,312"],
      ["Languages", "Python, TypeScript"],
      ["Entry points", "<code>src/signals/ingest.py</code><br><code>src/signals/api.ts</code>"],
      ["First commit", "26 January 2026"],
      ["Last commit", "10 March 2026"],
      [
        "Revision",
        `<a class="external" href="${REPO}/commit/${"b".repeat(40)}"><code>bbbbbbb</code></a> (PR #88)`,
      ],
    ]);
  });

  it("dates the page by its commit, not its generation time", () => {
    expect(view.lastEdited).toMatch(/^This page was last edited on 10 March 2026, at commit /);
  });

  it("omits an empty alias row and adds a notice for a retired feature", () => {
    const retired = articleView(site, page("exporter"));
    expect(retired.infobox.map((row) => row.label)).not.toContain("Also known as");
    expect(retired.notice).toBe(
      "This feature was retired at commit <code>ccccccc</code>. The article describes it as of its last revision.",
    );
    expect(view.notice).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site/src/article.test.ts`
Expected: FAIL with `Error: Cannot find module './article.ts'`.

- [ ] **Step 4: Implement**

`packages/site/src/format.ts`:

```ts
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * "2026-03-10T16:30:00+01:00" -> "10 March 2026". Reads the calendar date as written, in the
 * committer's own offset, so output never depends on the build machine's time zone.
 */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

const NUMBER = new Intl.NumberFormat("en-US");

export function formatNumber(n: number): string {
  return NUMBER.format(n);
}

export const shortSha = (sha: string): string => sha.slice(0, 7);
```

`packages/site/src/article.ts`:

```ts
import type { Revision, SectionKey } from "@repowiki/core";
import { formatDate, formatNumber, shortSha } from "./format.ts";
import { escapeHtml, renderInline } from "./inline.ts";
import { featureLink, type SiteModel } from "./model.ts";
import { backlinksHtml, citationHtml, collectReferences, markersHtml } from "./references.ts";

export const SECTION_TITLES: Record<Exclude<SectionKey, "lead">, string> = {
  overview: "Overview",
  "how-it-works": "How it works",
  "data-flow": "Data flow",
  history: "History",
  "known-limitations": "Known limitations",
};

export const STALE_NOTICE = "This section may be out of date.";

export interface SectionView {
  anchor: string;
  title: string;
  html: string;
  stale: boolean;
}

export interface ArticleView {
  featureId: string;
  title: string;
  /** Banner HTML above the article (retired feature, old revision), or null. */
  notice: string | null;
  leadHtml: string;
  leadStale: boolean;
  toc: { anchor: string; title: string }[];
  sections: SectionView[];
  seeAlso: { href: string; title: string }[];
  references: { n: number; html: string; backlinks: string }[];
  infobox: { label: string; html: string }[];
  lastEdited: string;
}

/** Everything the article template prints, computed from one revision. */
export function articleView(site: SiteModel, revision: Revision): ArticleView {
  const feature = site.features.get(revision.featureId);
  const title = feature?.title ?? revision.featureId;
  const refs = collectReferences(revision);
  const link = (id: string) => featureLink(site, id);

  const stale = new Set<string>();
  for (const section of revision.sections) {
    for (const claim of section.claims) if (claim.staleSince !== null) stale.add(claim.id);
  }
  const paragraph = (claims: Revision["sections"][number]["claims"]): string =>
    claims
      .map(
        (claim) =>
          renderInline(claim.text, { link }) + markersHtml(refs.markers.get(claim.id) ?? []),
      )
      .join(" ");

  const lead = revision.sections.find((section) => section.key === "lead")?.claims ?? [];
  const sections: SectionView[] = revision.sections.flatMap((section) =>
    section.key === "lead"
      ? []
      : [
          {
            anchor: section.key,
            title: SECTION_TITLES[section.key],
            html: paragraph(section.claims),
            stale: section.claims.some((claim) => stale.has(claim.id)),
          },
        ],
  );
  const seeAlso = revision.seeAlso.flatMap((id) => {
    const target = link(id);
    return target === null ? [] : [target];
  });
  const references = refs.notes.map((note) => ({
    n: note.n,
    html: citationHtml(note.citation, site.repoUrl),
    backlinks: backlinksHtml(note),
  }));
  const toc = [
    ...sections.map(({ anchor, title }) => ({ anchor, title })),
    ...(seeAlso.length > 0 ? [{ anchor: "see-also", title: "See also" }] : []),
    ...(references.length > 0 ? [{ anchor: "references", title: "References" }] : []),
  ];

  const retire = feature?.lineage.find((event) => event.kind === "retire");
  const notice =
    feature?.status.kind === "retired"
      ? `This feature was retired${retire === undefined ? "" : ` at commit <code>${shortSha(retire.sha)}</code>`}. The article describes it as of its last revision.`
      : null;

  return {
    featureId: revision.featureId,
    title,
    notice,
    leadHtml: paragraph(lead),
    leadStale: lead.some(
      (claim) => stale.has(claim.id) || claim.supports.some((id) => stale.has(id)),
    ),
    toc,
    sections,
    seeAlso,
    references,
    infobox: infoboxRows(site, revision, feature?.aliases ?? []),
    lastEdited: `This page was last edited on ${formatDate(revision.commitDate)}, at commit ${revisionHtml(site, revision)}.`,
  };
}

function revisionHtml(site: SiteModel, revision: Revision): string {
  const sha = `<code>${shortSha(revision.sha)}</code>`;
  const linked =
    site.repoUrl === null
      ? sha
      : `<a class="external" href="${escapeHtml(`${site.repoUrl}/commit/${revision.sha}`)}">${sha}</a>`;
  return revision.pr === null ? linked : `${linked} (PR #${revision.pr})`;
}

function infoboxRows(
  site: SiteModel,
  revision: Revision,
  aliases: readonly string[],
): ArticleView["infobox"] {
  const box = revision.infobox;
  const rows = [
    { label: "Also known as", html: aliases.map(escapeHtml).join(", ") },
    { label: "Files", html: formatNumber(box.files) },
    { label: "Lines of code", html: formatNumber(box.loc) },
    { label: "Languages", html: box.languages.map(escapeHtml).join(", ") },
    {
      label: "Entry points",
      html: box.entryPoints.map((p) => `<code>${escapeHtml(p)}</code>`).join("<br>"),
    },
    { label: "First commit", html: formatDate(box.firstCommitDate) },
    { label: "Last commit", html: formatDate(box.lastCommitDate) },
    { label: "Revision", html: revisionHtml(site, revision) },
  ];
  return rows.filter((row) => row.html !== "");
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (394 tests in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/site
git commit -m "feat(site): compute the article view from a revision"
```

Ship. PR title: `feat(site): article view`.

---

### Task 10: Article pages

**Ticket:** `[M5] site: article pages`

**Files:**
- Create: `packages/site/src/routes.ts`, `packages/site/src/components/Article.astro`, `packages/site/src/pages/wiki/[slug]/index.astro`
- Modify: `biome.json` (whole file), `packages/site/src/styles/wiki.css` (append)
- Test: `packages/site/src/site.test.ts` (append); first golden snapshot `__snapshots__/wiki-signals.html`

**Interfaces:**
- Consumes: `articleView` and `STALE_NOTICE` (Task 9), and `getSite` (Task 7).
- Produces:
  - `type WikiRoute = { slug; kind: "article"; featureId }`. Task 11 extends it.
  - `wikiRoutes(site): WikiRoute[]`.
  - `<Article view={ArticleView} indexed={boolean} />`. Only `indexed` pages carry `data-pagefind-body`.
  - The `normalized(path)` helper in `site.test.ts`, which replaces `/_astro/<hash>` with `/_astro/ASSET`.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/article-pages
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/site/src/site.test.ts`:

```ts
/** Hashed asset names change with any CSS or script edit; snapshots should not. */
function normalized(path: string): string {
  return site.read(path).replace(/\/_astro\/[^"]+/g, "/_astro/ASSET");
}

describe("article page", () => {
  it("renders the lead, sections, references and infobox", () => {
    const html = site.read("wiki/signals/index.html");
    expect(html).toContain('<h1 class="page-title">Signal ingestion</h1>');
    expect(html).toContain("<b>Signal ingestion</b> is the subsystem of demo-repo");
    expect(html).toContain(
      '<a class="wikilink" href="/wiki/deliverables/" title="Deliverables" data-preview="deliverables">deliverable records</a>',
    );
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Exponential_backoff"');
    expect(html).toContain('<li id="cite-note-5">');
    expect(html).toContain(
      "/blob/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/src/signals/odd%20name%231.py#L1-L9",
    );
    expect(html.match(/This section may be out of date\./g)).toHaveLength(1);
    expect(html).toContain("<td>1,312</td>");
  });

  it("escapes markup in claim text and leaves unknown links as plain text", () => {
    const html = site.read("wiki/signals/index.html");
    expect(html).toContain(
      "<code>&lt;script&gt;</code> tags are stored escaped, and so is &lt;b&gt;this&lt;/b&gt;.",
    );
    expect(html).toContain("The scheduler triggers ingestion");
    expect(html).toContain("ghost described the old approach");
    expect(html).not.toContain("/wiki/ghost/");
  });

  it("indexes current articles for search and marks retired ones", () => {
    expect(site.read("wiki/signals/index.html")).toContain(
      '<article class="article" data-pagefind-body>',
    );
    expect(site.read("wiki/exporter/index.html")).toContain("This feature was retired at commit");
    expect(existsSync(join(site.outDir, "wiki", "scheduler"))).toBe(false);
  });

  it("matches the golden snapshot", async () => {
    await expect(normalized("wiki/signals/index.html")).toMatchFileSnapshot(
      "__snapshots__/wiki-signals.html",
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site/src/site.test.ts`
Expected: FAIL. The article tests fail with `ENOENT` on `wiki/signals/index.html`.

- [ ] **Step 4: Implement**

Replace `biome.json` with the following, which excludes golden snapshots from Biome:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/__snapshots__"] },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } },
  "linter": { "enabled": true, "rules": { "preset": "recommended" } },
  "overrides": [
    {
      "includes": ["**/*.astro"],
      "linter": {
        "rules": {
          "correctness": { "noUnusedVariables": "off", "noUnusedImports": "off" }
        }
      }
    }
  ]
}
```

`packages/site/src/routes.ts`:

```ts
import type { SiteModel } from "./model.ts";

/** One page under /wiki/<slug>/. */
export type WikiRoute = { slug: string; kind: "article"; featureId: string };

/** Every /wiki/<slug>/ page: articles for active and retired features that have a revision. */
export function wikiRoutes(site: SiteModel): WikiRoute[] {
  const routes: WikiRoute[] = [];
  for (const feature of site.wiki.manifest.features) {
    const kind = feature.status.kind;
    if ((kind === "active" || kind === "retired") && site.pages.has(feature.id)) {
      routes.push({ slug: feature.id, kind: "article", featureId: feature.id });
    }
  }
  return routes;
}
```

`packages/site/src/components/Article.astro`:

```astro
---
import { type ArticleView, STALE_NOTICE } from "../article.ts";
import { getSite } from "../site.ts";

interface Props {
  view: ArticleView;
  /** True only for the current revision, so search indexes each article once. */
  indexed: boolean;
}

const { view, indexed } = Astro.props;
const { wiki } = getSite();
---
<article class="article" data-pagefind-body={indexed ? "" : undefined}>
  <h1 class="page-title">{view.title}</h1>
  <p class="tagline">From the {wiki.repo} wiki</p>
  {view.notice !== null && <div class="ambox" role="note" set:html={view.notice} />}
  <table class="infobox">
    <caption>{view.title}</caption>
    <tbody>
      {view.infobox.map((row) => (
        <tr>
          <th scope="row">{row.label}</th>
          <td set:html={row.html} />
        </tr>
      ))}
    </tbody>
  </table>
  {view.leadStale && <div class="ambox ambox-stale" role="note">{STALE_NOTICE}</div>}
  <p class="lead" set:html={view.leadHtml} />
  {view.toc.length > 0 && (
    <nav class="toc" aria-labelledby="toc-heading">
      <h2 id="toc-heading">Contents</h2>
      <ol>
        {view.toc.map((entry) => (
          <li><a href={`#${entry.anchor}`}>{entry.title}</a></li>
        ))}
      </ol>
    </nav>
  )}
  {view.sections.map((section) => (
    <section aria-labelledby={section.anchor}>
      <h2 id={section.anchor}>{section.title}</h2>
      {section.stale && <div class="ambox ambox-stale" role="note">{STALE_NOTICE}</div>}
      <p set:html={section.html} />
    </section>
  ))}
  {view.seeAlso.length > 0 && (
    <section aria-labelledby="see-also">
      <h2 id="see-also">See also</h2>
      <ul>
        {view.seeAlso.map((entry) => (
          <li><a class="wikilink" href={entry.href}>{entry.title}</a></li>
        ))}
      </ul>
    </section>
  )}
  {view.references.length > 0 && (
    <section aria-labelledby="references">
      <h2 id="references">References</h2>
      <ol class="references">
        {view.references.map((ref) => (
          <li id={`cite-note-${ref.n}`}>
            <span class="ref-backs" set:html={ref.backlinks} /> <span set:html={ref.html} />
          </li>
        ))}
      </ol>
    </section>
  )}
  <p class="last-edited" set:html={view.lastEdited} />
</article>
```

`packages/site/src/pages/wiki/[slug]/index.astro`:

```astro
---
import { articleView } from "../../../article.ts";
import Article from "../../../components/Article.astro";
import Layout from "../../../layouts/Layout.astro";
import { type WikiRoute, wikiRoutes } from "../../../routes.ts";
import { getSite } from "../../../site.ts";

export function getStaticPaths() {
  return wikiRoutes(getSite()).map((route) => ({ params: { slug: route.slug }, props: { route } }));
}

const { route } = Astro.props as { route: WikiRoute };
const site = getSite();
const page = site.pages.get(route.featureId);
if (page === undefined) throw new Error(`no page for ${route.featureId}`);
const view = articleView(site, page);
---
<Layout title={view.title}>
  <Article view={view} indexed={true} />
</Layout>
```

Append to `packages/site/src/styles/wiki.css`:

```css
/* Articles */
.tagline {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: var(--text-muted);
}

.article h2 {
  font-family: var(--font-serif);
  font-size: 1.5rem;
  font-weight: normal;
  line-height: 1.3;
  margin: 1.5rem 0 0.5rem;
  border-bottom: 1px solid var(--border);
}

.article p {
  margin: 0.5rem 0;
}

.infobox {
  float: right;
  clear: right;
  width: 22rem;
  margin: 0 0 1rem 1.5rem;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  border-collapse: collapse;
  font-size: 0.875rem;
  line-height: 1.5;
}

.infobox caption {
  font-weight: bold;
  font-size: 1.1rem;
  padding: 0.4rem;
}

.infobox th,
.infobox td {
  padding: 0.25rem 0.5rem;
  text-align: left;
  vertical-align: top;
}

.infobox th {
  width: 40%;
}

.ambox {
  margin: 0.5rem 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-subtle);
  border-left: 0.5rem solid var(--notice-border);
  background: var(--notice-bg);
  font-size: 0.875rem;
}

.toc {
  display: inline-block;
  min-width: 14rem;
  margin: 1rem 0;
  padding: 0.5rem 1rem;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  font-size: 0.875rem;
}

.toc h2 {
  font-family: var(--font-sans);
  font-size: 1rem;
  font-weight: bold;
  text-align: center;
  border: 0;
  margin: 0;
}

.toc ol {
  margin: 0.25rem 0 0;
  padding-left: 1.5rem;
}

sup.reference {
  font-size: 0.75em;
  line-height: 1;
  white-space: nowrap;
}

.references {
  font-size: 0.875rem;
}

.references li:target {
  background: var(--bg-subtle);
}

.ref-backs {
  user-select: none;
}

.last-edited {
  clear: both;
  margin-top: 2rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border-subtle);
  font-size: 0.75rem;
  color: var(--text-muted);
}

a.external::after {
  content: " \2197";
  font-size: 0.75em;
}

@media (max-width: 720px) {
  .infobox {
    float: none;
    width: 100%;
    margin: 0 0 1rem;
  }
}
```

- [ ] **Step 5: Write the snapshot, review it, run the check**

```bash
pnpm vitest run packages/site -u
pnpm check
```

Expected: `Snapshots 1 written` (`packages/site/src/__snapshots__/wiki-signals.html`). Read it. It should show:
- the infobox rows ("Also known as" … "Revision");
- a lead with a `deliverable records` link;
- Contents listing Overview, How it works, Data flow, History, Known limitations, See also and References;
- one "This section may be out of date." box;
- five references, the third with `odd%20name%231.py#L1-L9`.

`legacy-signals` still renders as the plain text `legacy-signals`, because redirect pages arrive in Task 11. `pnpm check` passes (398 tests in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add biome.json packages/site
git commit -m "feat(site): render article pages"
```

Ship. PR title: `feat(site): article pages`.

---

### Task 11: Redirect, disambiguation and alias pages

**Ticket:** `[M5] site: redirect, disambiguation and alias pages`

**Files:**
- Create: `packages/site/src/summary.ts`, `packages/site/src/client/redirect-note.ts`
- Modify:
  - `packages/site/src/model.ts` (`hasArticleRoute`)
  - `packages/site/src/routes.ts` (whole file)
  - `packages/site/src/pages/wiki/[slug]/index.astro` (whole file)
  - `packages/site/src/components/Article.astro`
  - `packages/site/src/styles/wiki.css` (append)
- Test:
  - `packages/site/src/routes.test.ts`
  - `packages/site/src/model.test.ts`
  - `packages/site/src/article.test.ts`
  - `packages/site/src/site.test.ts` (append); snapshots `wiki-legacy-signals.html` and `wiki-reports.html`

**Interfaces:**
- Consumes: `finalTarget`, `featureLink` and `SiteModel.aliases` (Task 7), and `renderInline` (Task 7).
- Produces:
  - `WikiRoute` becomes `{ slug; kind: "article"; featureId } | { slug; kind: "redirect"; title; target } | { slug; kind: "disambiguation"; title; targets: string[] }`.
  - `hasArticleRoute(site, id)` now also returns true for redirect and disambiguation features.
  - `leadSummary(site, featureId): string | null`, the link-free lead HTML.
  - Redirect pages send readers to `<target>?redirectedfrom=<title>`, and the article shows "(Redirected from <title>)".

- [ ] **Step 1: Branch**

```bash
git switch -c m5/redirect-pages
```

- [ ] **Step 2: Write the failing tests**

`packages/site/src/routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSiteModel } from "./model.ts";
import { wikiRoutes } from "./routes.ts";
import { leadSummary } from "./summary.ts";
import { fixtureExport } from "./test-fixtures.ts";

const site = buildSiteModel(fixtureExport(), null);

describe("wikiRoutes", () => {
  it("emits articles, feature redirects and disambiguations, then alias pages", () => {
    expect(wikiRoutes(site)).toEqual([
      { slug: "signals", kind: "article", featureId: "signals" },
      { slug: "deliverables", kind: "article", featureId: "deliverables" },
      { slug: "legacy-signals", kind: "redirect", title: "Legacy signals", target: "signals" },
      {
        slug: "reports",
        kind: "disambiguation",
        title: "Reports",
        targets: ["signals", "deliverables"],
      },
      { slug: "exporter", kind: "article", featureId: "exporter" },
      { slug: "api-signals", kind: "redirect", title: "/api/signals", target: "signals" },
      {
        slug: "deliverable-records",
        kind: "redirect",
        title: "deliverable records",
        target: "deliverables",
      },
      {
        slug: "signal-pipeline",
        kind: "disambiguation",
        title: "signal pipeline",
        targets: ["signals", "deliverables"],
      },
      { slug: "signals-table", kind: "redirect", title: "SIGNALS_TABLE", target: "signals" },
    ]);
  });

  it("never emits two pages for one slug", () => {
    const slugs = wikiRoutes(site).map((route) => route.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("leadSummary", () => {
  it("renders the lead without links", () => {
    expect(leadSummary(site, "deliverables")).toBe(
      "<b>Deliverables</b> are the records that Signal ingestion feed.",
    );
    expect(leadSummary(site, "scheduler")).toBeNull();
  });
});
```

In `packages/site/src/model.test.ts`:

Replace:
```ts
describe("buildSiteModel", () => {
  it("routes active and retired features that have a page", () => {
    const routed = [...site.features.keys()].filter((id) => hasArticleRoute(site, id));
    expect(routed.sort()).toEqual(["deliverables", "exporter", "signals"]);
    expect(hasArticleRoute(site, "scheduler")).toBe(false);
```
with:
```ts
describe("buildSiteModel", () => {
  it("routes features that have a page, a redirect or a disambiguation", () => {
    const routed = [...site.features.keys()].filter((id) => hasArticleRoute(site, id));
    expect(routed.sort()).toEqual([
      "deliverables",
      "exporter",
      "legacy-signals",
      "reports",
      "signals",
    ]);
    expect(hasArticleRoute(site, "scheduler")).toBe(false);
```

In `packages/site/src/article.test.ts`:

Replace:
```ts
  it("drops See also entries that have no page", () => {
    expect(view.seeAlso).toEqual([{ href: "/wiki/deliverables/", title: "Deliverables" }]);
  });
```
with:
```ts
  it("drops See also entries that have no page", () => {
    expect(view.seeAlso).toEqual([
      { href: "/wiki/deliverables/", title: "Deliverables" },
      { href: "/wiki/reports/", title: "Reports" },
    ]);
  });
```

Append to `packages/site/src/site.test.ts`:

```ts
describe("redirect and disambiguation pages", () => {
  it("redirects a merged feature to its target and names where the reader came from", () => {
    const html = site.read("wiki/legacy-signals/index.html");
    expect(html).toContain(
      '<meta http-equiv="refresh" content="0; url=/wiki/signals/?redirectedfrom=Legacy%20signals">',
    );
    expect(html).toContain('<link rel="canonical" href="/wiki/signals/">');
    expect(html).toMatch(
      /Redirect to:\s*<a class="wikilink" href="\/wiki\/signals\/">Signal ingestion<\/a>/,
    );
    expect(site.read("wiki/signals/index.html")).toContain(
      '<p class="redirect-note" id="redirected-from" hidden></p>',
    );
  });

  it("lists the targets of a split feature with their leads", () => {
    const html = site.read("wiki/reports/index.html");
    expect(html).toContain("<p><b>Reports</b> may refer to:</p>");
    expect(html).toContain('<a class="wikilink" href="/wiki/deliverables/">Deliverables</a>');
    expect(html).toContain(": <b>Deliverables</b> are the records that Signal ingestion feed.");
  });

  it("gives aliases redirect URLs, and a disambiguation page when two features share one", () => {
    expect(site.read("wiki/signals-table/index.html")).toContain(
      "url=/wiki/signals/?redirectedfrom=SIGNALS_TABLE",
    );
    expect(site.read("wiki/api-signals/index.html")).toContain("redirectedfrom=%2Fapi%2Fsignals");
    expect(site.read("wiki/signal-pipeline/index.html")).toContain(
      "<p><b>signal pipeline</b> may refer to:</p>",
    );
  });

  it("links article text to redirect pages instead of dropping the link", () => {
    expect(site.read("wiki/signals/index.html")).toContain(
      'href="/wiki/legacy-signals/" title="Legacy signals" data-preview="legacy-signals">Legacy signals</a>',
    );
  });

  it("matches the golden snapshots", async () => {
    await expect(normalized("wiki/legacy-signals/index.html")).toMatchFileSnapshot(
      "__snapshots__/wiki-legacy-signals.html",
    );
    await expect(normalized("wiki/reports/index.html")).toMatchFileSnapshot(
      "__snapshots__/wiki-reports.html",
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site`
Expected: FAIL. `routes.test.ts` fails with `Error: Cannot find module './summary.ts'`. The model and article cases fail because `legacy-signals` and `reports` have no route yet. The new site tests fail with `ENOENT` on `wiki/legacy-signals/index.html`.

- [ ] **Step 4: Implement**

In `packages/site/src/model.ts`:

Replace:
```ts

/** True when /wiki/<id>/ is a page: an active or retired feature that has a revision. */
export function hasArticleRoute(site: SiteModel, id: string): boolean {
  const kind = site.features.get(id)?.status.kind;
  return (kind === "active" || kind === "retired") && site.pages.has(id);
```
with:
```ts

/** True when /wiki/<id>/ is a page: a redirect, a disambiguation, or a feature with a revision. */
export function hasArticleRoute(site: SiteModel, id: string): boolean {
  const kind = site.features.get(id)?.status.kind;
  if (kind === "redirect" || kind === "disambiguation") return true;
  return (kind === "active" || kind === "retired") && site.pages.has(id);
```

Replace `packages/site/src/routes.ts` with:

```ts
import { finalTarget, type SiteModel } from "./model.ts";

/** One page under /wiki/<slug>/. Redirects and disambiguations come from features or aliases. */
export type WikiRoute =
  | { slug: string; kind: "article"; featureId: string }
  | { slug: string; kind: "redirect"; title: string; target: string }
  | { slug: string; kind: "disambiguation"; title: string; targets: string[] };

/**
 * Every /wiki/<slug>/ page: articles for active and retired features that have a revision,
 * a redirect or disambiguation page per feature status, then one page per alias slug.
 */
export function wikiRoutes(site: SiteModel): WikiRoute[] {
  const routes: WikiRoute[] = [];
  for (const feature of site.wiki.manifest.features) {
    const { id, title, status } = feature;
    if (status.kind === "redirect") {
      routes.push({ slug: id, kind: "redirect", title, target: finalTarget(site, id) });
    } else if (status.kind === "disambiguation") {
      routes.push({ slug: id, kind: "disambiguation", title, targets: status.to });
    } else if (site.pages.has(id)) {
      routes.push({ slug: id, kind: "article", featureId: id });
    }
  }
  for (const alias of site.aliases) {
    const [only, ...more] = alias.targets;
    if (only === undefined) continue;
    routes.push(
      more.length === 0
        ? { slug: alias.slug, kind: "redirect", title: alias.alias, target: only }
        : { slug: alias.slug, kind: "disambiguation", title: alias.alias, targets: alias.targets },
    );
  }
  return routes;
}
```

`packages/site/src/summary.ts`:

```ts
import { renderInline } from "./inline.ts";
import { featureLink, type SiteModel } from "./model.ts";

/** The lead of a feature's current page as link-free HTML, or null when it has no page. */
export function leadSummary(site: SiteModel, featureId: string): string | null {
  const lead = site.pages.get(featureId)?.sections.find((section) => section.key === "lead");
  if (lead === undefined) return null;
  const link = (id: string) => featureLink(site, id);
  return lead.claims.map((claim) => renderInline(claim.text, { link, links: false })).join(" ");
}
```

`packages/site/src/client/redirect-note.ts`:

```ts
/// <reference lib="dom" />
// Shows "(Redirected from X)" under the title when a redirect page sent the reader here.
const from = new URLSearchParams(window.location.search).get("redirectedfrom");
const note = document.getElementById("redirected-from");
if (from !== null && from !== "" && note !== null) {
  const name = document.createElement("b");
  name.textContent = from;
  note.append("(Redirected from ", name, ")");
  note.hidden = false;
}
```

In `packages/site/src/components/Article.astro`:

Replace:
```astro
  <p class="tagline">From the {wiki.repo} wiki</p>
  {view.notice !== null && <div class="ambox" role="note" set:html={view.notice} />}
```
with:
```astro
  <p class="tagline">From the {wiki.repo} wiki</p>
  <p class="redirect-note" id="redirected-from" hidden></p>
  {view.notice !== null && <div class="ambox" role="note" set:html={view.notice} />}
```

Replace:
```astro
</article>
```
with:
```astro
</article>
<script>
  import "../client/redirect-note.ts";
</script>
```

Replace `packages/site/src/pages/wiki/[slug]/index.astro` with:

```astro
---
import { articleView } from "../../../article.ts";
import Article from "../../../components/Article.astro";
import Layout from "../../../layouts/Layout.astro";
import { featureLink } from "../../../model.ts";
import { type WikiRoute, wikiRoutes } from "../../../routes.ts";
import { getSite } from "../../../site.ts";
import { leadSummary } from "../../../summary.ts";

export function getStaticPaths() {
  return wikiRoutes(getSite()).map((route) => ({ params: { slug: route.slug }, props: { route } }));
}

const { route } = Astro.props as { route: WikiRoute };
const site = getSite();
const page = route.kind === "article" ? site.pages.get(route.featureId) : undefined;
const view = page === undefined ? null : articleView(site, page);
const target = route.kind === "redirect" ? featureLink(site, route.target) : null;
const refresh =
  target === null || route.kind !== "redirect"
    ? null
    : `0; url=${target.href}?redirectedfrom=${encodeURIComponent(route.title)}`;
const entries =
  route.kind === "disambiguation"
    ? route.targets.map((id) => ({
        link: featureLink(site, id),
        title: site.features.get(id)?.title ?? id,
        summary: leadSummary(site, id),
      }))
    : [];
---
{route.kind === "article" && view !== null && (
  <Layout title={view.title}>
    <Article view={view} indexed={true} />
  </Layout>
)}
{route.kind === "redirect" && (
  <Layout title={route.title}>
    <Fragment slot="head">
      {refresh !== null && <meta http-equiv="refresh" content={refresh} />}
      {target !== null && <link rel="canonical" href={target.href} />}
      <meta name="robots" content="noindex" />
    </Fragment>
    <h1 class="page-title">{route.title}</h1>
    <p class="redirect-target">
      Redirect to:
      {target === null ? (
        <span>{site.features.get(route.target)?.title ?? route.target}</span>
      ) : (
        <a class="wikilink" href={target.href}>{target.title}</a>
      )}
    </p>
  </Layout>
)}
{route.kind === "disambiguation" && (
  <Layout title={route.title}>
    <h1 class="page-title">{route.title}</h1>
    <p><b>{route.title}</b> may refer to:</p>
    <ul class="dab-list">
      {entries.map((entry) => (
        <li>
          {entry.link === null ? <span>{entry.title}</span> : <a class="wikilink" href={entry.link.href}>{entry.title}</a>}
          {entry.summary !== null && <span class="dab-summary" set:html={`: ${entry.summary}`} />}
        </li>
      ))}
    </ul>
    <p class="dab-note">This disambiguation page lists articles associated with the title <i>{route.title}</i>.</p>
  </Layout>
)}
```

Append to `packages/site/src/styles/wiki.css`:

```css
/* Redirects and disambiguation pages */
.redirect-note {
  margin: -0.75rem 0 1rem;
  font-size: 0.875rem;
  color: var(--text-muted);
}

.redirect-target {
  font-size: 1.1rem;
}

.dab-list li {
  margin: 0.25rem 0;
}

.dab-note {
  margin-top: 1.5rem;
  font-size: 0.875rem;
  color: var(--text-muted);
}
```

- [ ] **Step 5: Update the snapshots, review them, run the check**

```bash
pnpm vitest run packages/site -u
pnpm check
```

Expected:
- `wiki-legacy-signals.html` and `wiki-reports.html` are written.
- In `wiki-signals.html`, the only changes are: the empty `redirected-from` note, a `<script type="module" src="/_astro/ASSET">` tag, the `Legacy signals` link in Data flow, and `Reports` added to See also.
- `pnpm check` passes (406 tests in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/site
git commit -m "feat(site): render redirect, disambiguation and alias pages"
```

Ship. PR title: `feat(site): redirect, disambiguation and alias pages`.

---

### Task 12: Revision diff

**Ticket:** `[M5] site: revision diff`

**Files:**
- Create: `packages/site/src/diff.ts`
- Test: `packages/site/src/diff.test.ts`

**Interfaces:**
- Consumes: `SectionKey` and `Revision` from `@repowiki/core`, `SECTION_TITLES` (Task 9), and `escapeHtml` (Task 7).
- Produces:
  - `type DiffOp<T> = { op: "equal" | "delete" | "insert"; value: T }`.
  - `MAX_DIFF_CELLS = 1_000_000`.
  - `diffSequence(a, b): DiffOp[]`, which lists deletions before insertions.
  - `wordDiffHtml(before, after)`.
  - `interface DiffRow { kind: "context" | "removed" | "added" | "changed"; html }` and `interface DiffSection { title; rows }`.
  - `revisionDiff(before, after): DiffSection[]`, which omits unchanged sections.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/revision-diff
```

- [ ] **Step 2: Write the failing tests**

`packages/site/src/diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffSequence, MAX_DIFF_CELLS, revisionDiff, wordDiffHtml } from "./diff.ts";
import { fixtureExport } from "./test-fixtures.ts";

describe("diffSequence", () => {
  it("keeps common items and lists deletions before insertions", () => {
    expect(diffSequence(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { op: "equal", value: "a" },
      { op: "delete", value: "b" },
      { op: "insert", value: "x" },
      { op: "equal", value: "c" },
      { op: "insert", value: "d" },
    ]);
  });

  it("handles empty sides", () => {
    expect(diffSequence([], ["a"])).toEqual([{ op: "insert", value: "a" }]);
    expect(diffSequence(["a"], [])).toEqual([{ op: "delete", value: "a" }]);
  });

  it("falls back to delete-all, insert-all for inputs too large to table", () => {
    const size = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 1;
    const same = Array.from({ length: size }, (_, i) => String(i));
    const ops = diffSequence(same, same);
    expect(ops.filter((op) => op.op === "equal")).toEqual([]);
    expect(ops).toHaveLength(size * 2);
  });
});

describe("wordDiffHtml", () => {
  it("marks changed words and escapes everything", () => {
    expect(wordDiffHtml("a b <c>", "a x <c>")).toBe("a <del>b</del><ins>x</ins> &lt;c&gt;");
  });
});

describe("revisionDiff", () => {
  const [before, after] = fixtureExport().history.signals ?? [];
  if (before === undefined || after === undefined) throw new Error("fixture needs two revisions");
  const diff = revisionDiff(before, after);

  it("lists every changed section in stored order", () => {
    expect(diff.map((section) => section.title)).toEqual([
      "Lead",
      "Overview",
      "How it works",
      "Data flow",
      "History",
      "Known limitations",
    ]);
  });

  it("pairs a rewritten claim into a word diff and shows new claims as added", () => {
    expect(diff[1]?.rows).toEqual([
      {
        kind: "changed",
        html: "Signals are <del>built</del><ins>created</ins> from <del>chunks.</del><ins>ingested chunks by `ingest_chunk`.</ins>",
      },
      { kind: "added", html: "Each signal stores its source chunk and a *confidence* score." },
    ]);
  });

  it("is empty when nothing changed", () => {
    expect(revisionDiff(after, after)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site/src/diff.test.ts`
Expected: FAIL with `Error: Cannot find module './diff.ts'`.

- [ ] **Step 4: Implement**

`packages/site/src/diff.ts`:

```ts
import { type Revision, SectionKey } from "@repowiki/core";
import { SECTION_TITLES } from "./article.ts";
import { escapeHtml } from "./inline.ts";

export type DiffOp<T> = { op: "equal" | "delete" | "insert"; value: T };

/** Above this many cells the LCS table is skipped and the change shown as delete-all, insert-all. */
export const MAX_DIFF_CELLS = 1_000_000;

/** Longest-common-subsequence diff of two sequences, in order. */
export function diffSequence<T>(a: readonly T[], b: readonly T[]): DiffOp<T>[] {
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [
      ...a.map((value): DiffOp<T> => ({ op: "delete", value })),
      ...b.map((value): DiffOp<T> => ({ op: "insert", value })),
    ];
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        a[i] === b[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: DiffOp<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: "equal", value: a[i] as T });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j === b.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))
    ) {
      ops.push({ op: "delete", value: a[i] as T });
      i++;
    } else {
      ops.push({ op: "insert", value: b[j] as T });
      j++;
    }
  }
  return ops;
}

/** Word-level diff of one rewritten claim, as HTML with <del> and <ins>; runs are merged. */
export function wordDiffHtml(before: string, after: string): string {
  const words = (text: string) => text.split(/(\s+)/).filter((token) => token !== "");
  const runs: DiffOp<string>[] = [];
  for (const { op, value } of diffSequence(words(before), words(after))) {
    const last = runs.at(-1);
    if (last?.op === op) last.value += value;
    else runs.push({ op, value });
  }
  return runs
    .map(({ op, value }) => {
      const text = escapeHtml(value);
      return op === "equal" ? text : op === "delete" ? `<del>${text}</del>` : `<ins>${text}</ins>`;
    })
    .join("");
}

export interface DiffRow {
  kind: "context" | "removed" | "added" | "changed";
  html: string;
}

export interface DiffSection {
  title: string;
  rows: DiffRow[];
}

/**
 * Claim-by-claim diff of the stored claim text (the page's source, as Wikipedia diffs show
 * wikitext). Sections with no change are omitted. A run of removed claims followed by added
 * ones is paired into "changed" rows with a word diff.
 */
export function revisionDiff(before: Revision, after: Revision): DiffSection[] {
  const texts = (revision: Revision, key: SectionKey) =>
    revision.sections.find((section) => section.key === key)?.claims.map((claim) => claim.text) ??
    [];
  const sections: DiffSection[] = [];
  for (const key of SectionKey.options) {
    const ops = diffSequence(texts(before, key), texts(after, key));
    if (ops.every((op) => op.op === "equal")) continue;
    const rows: DiffRow[] = [];
    let removed: string[] = [];
    let added: string[] = [];
    const flush = () => {
      const paired = Math.min(removed.length, added.length);
      for (let k = 0; k < paired; k++) {
        rows.push({ kind: "changed", html: wordDiffHtml(removed[k] ?? "", added[k] ?? "") });
      }
      for (const text of removed.slice(paired))
        rows.push({ kind: "removed", html: escapeHtml(text) });
      for (const text of added.slice(paired)) rows.push({ kind: "added", html: escapeHtml(text) });
      removed = [];
      added = [];
    };
    for (const { op, value } of ops) {
      if (op === "delete") removed.push(value);
      else if (op === "insert") added.push(value);
      else {
        flush();
        rows.push({ kind: "context", html: escapeHtml(value) });
      }
    }
    flush();
    sections.push({ title: key === "lead" ? "Lead" : SECTION_TITLES[key], rows });
  }
  return sections;
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (413 tests in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/site
git commit -m "feat(site): diff revisions claim by claim"
```

Ship. PR title: `feat(site): revision diff`.

---

### Task 13: Revision history and old revisions

**Ticket:** `[M5] site: revision history and old revisions`

**Files:**
- Create:
  - `packages/site/src/history.ts`
  - `packages/site/src/components/PageTabs.astro`
  - `packages/site/src/pages/wiki/[slug]/history/index.astro`
  - `packages/site/src/pages/wiki/[slug]/history/[n].astro`
- Modify: `packages/site/src/components/Article.astro`, `packages/site/src/pages/wiki/[slug]/index.astro`, `packages/site/src/styles/wiki.css` (append)
- Test: `packages/site/src/history.test.ts`, `packages/site/src/site.test.ts` (append); snapshot `wiki-signals-history.html`

**Interfaces:**
- Consumes: `formatDate`, `formatNumber` and `shortSha` (Task 9), `articleView` (Task 9), and `oldRevisionUrl` and `historyUrl` (Task 7).
- Produces:
  - `interface HistoryRow { n; date; oldHref; summaryHtml; commitHtml; cost }`. Task 14 adds `diffHref`.
  - `historyRows(site, featureId)`, newest first.
  - `oldRevisionNotice(site, revision)`.
  - `<PageTabs featureId current="article" | "history" />`.
  - The `Article` prop `tab?: "article" | "history"`.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/history-pages
```

- [ ] **Step 2: Write the failing tests**

`packages/site/src/history.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { historyRows, oldRevisionNotice } from "./history.ts";
import { buildSiteModel } from "./model.ts";
import { fixtureExport } from "./test-fixtures.ts";

const REPO = "https://github.com/acme/demo-repo";
const site = buildSiteModel(fixtureExport(), REPO);
const [first, second] = site.history.get("signals") ?? [];
if (first === undefined || second === undefined) throw new Error("fixture needs two revisions");

describe("historyRows", () => {
  it("lists revisions newest first, dated by commit", () => {
    expect(historyRows(site, "signals")).toEqual([
      {
        n: 2,
        date: "10 March 2026",
        oldHref: "/wiki/signals/history/2/",
        summaryHtml: `update (<a class="external" href="${REPO}/pull/88">PR #88</a>)`,
        commitHtml: `<a class="external" href="${REPO}/commit/${"b".repeat(40)}"><code>bbbbbbb</code></a>`,
        cost: "claude-haiku-4-5, 1,200 in / 300 out tokens",
      },
      {
        n: 1,
        date: "3 February 2026",
        oldHref: "/wiki/signals/history/1/",
        summaryHtml: "build",
        commitHtml: `<a class="external" href="${REPO}/commit/${"a".repeat(40)}"><code>aaaaaaa</code></a>`,
        cost: "claude-haiku-4-5, 1,200 in / 300 out tokens",
      },
    ]);
  });

  it("is empty for a feature with no revisions", () => {
    expect(historyRows(site, "scheduler")).toEqual([]);
  });
});

describe("oldRevisionNotice", () => {
  const plain = buildSiteModel(fixtureExport(), null);

  it("warns on an old revision and links the current one", () => {
    expect(oldRevisionNotice(plain, first)).toBe(
      'This is an old revision of this page, as of 3 February 2026 (commit <code>aaaaaaa</code>). It may differ significantly from the <a href="/wiki/signals/">current revision</a>.',
    );
  });

  it("says so when the revision is the current one", () => {
    expect(oldRevisionNotice(plain, second)).toBe(
      "This is the current revision of this page, as of 10 March 2026 (commit <code>bbbbbbb</code>).",
    );
  });
});
```

Append to `packages/site/src/site.test.ts`:

```ts
describe("history pages", () => {
  it("lists every revision newest first with links to each old revision", () => {
    const html = site.read("wiki/signals/history/index.html");
    expect(html).toContain('<h1 class="page-title">Signal ingestion: Revision history</h1>');
    const second = html.indexOf('href="/wiki/signals/history/2/"');
    const first = html.indexOf('href="/wiki/signals/history/1/"');
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(second);
  });

  it("renders old revisions with a banner and keeps them out of search", () => {
    const html = site.read("wiki/signals/history/1/index.html");
    expect(html).toContain("This is an old revision of this page, as of 3 February 2026");
    expect(html).toContain("Signals are built from chunks.");
    expect(html).not.toContain("data-pagefind-body");
  });

  it("gives every page with history a View history tab, redirects included", () => {
    const article = site.read("wiki/signals/index.html");
    expect(article).toContain('<a href="/wiki/signals/" aria-current="page">Article</a>');
    expect(article).toContain('<a href="/wiki/signals/history/">View history</a>');
    expect(site.read("wiki/signals/history/1/index.html")).toContain(
      '<a href="/wiki/signals/history/" aria-current="page">View history</a>',
    );
    expect(site.read("wiki/legacy-signals/index.html")).toContain(
      '<a href="/wiki/legacy-signals/history/">View history</a>',
    );
    expect(site.read("wiki/legacy-signals/history/index.html")).toContain("Legacy signals");
  });

  it("matches the golden snapshots", async () => {
    await expect(normalized("wiki/signals/history/index.html")).toMatchFileSnapshot(
      "__snapshots__/wiki-signals-history.html",
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site`
Expected: FAIL with `Error: Cannot find module './history.ts'`, and `ENOENT` on `wiki/signals/history/index.html`.

- [ ] **Step 4: Implement**

`packages/site/src/history.ts`:

```ts
import type { Revision } from "@repowiki/core";
import { formatDate, formatNumber, shortSha } from "./format.ts";
import { escapeHtml } from "./inline.ts";
import type { SiteModel } from "./model.ts";
import { articleUrl, oldRevisionUrl } from "./urls.ts";

export interface HistoryRow {
  n: number;
  date: string;
  oldHref: string;
  /** "update (PR #88)" with links when the repo URL is known. */
  summaryHtml: string;
  commitHtml: string;
  cost: string;
}

/** "View history" rows, newest first. Dates are commit dates (spec §5 rule 5). */
export function historyRows(site: SiteModel, featureId: string): HistoryRow[] {
  const revisions = site.history.get(featureId) ?? [];
  return revisions
    .map((revision, index) => {
      const n = index + 1;
      return {
        n,
        date: formatDate(revision.commitDate),
        oldHref: oldRevisionUrl(featureId, n),
        summaryHtml: summaryHtml(site, revision),
        commitHtml: commitHtml(site, revision),
        cost: `${revision.model}, ${formatNumber(revision.tokens.in)} in / ${formatNumber(revision.tokens.out)} out tokens`,
      };
    })
    .reverse();
}

function commitHtml(site: SiteModel, revision: Revision): string {
  const sha = `<code>${shortSha(revision.sha)}</code>`;
  return site.repoUrl === null
    ? sha
    : `<a class="external" href="${escapeHtml(`${site.repoUrl}/commit/${revision.sha}`)}">${sha}</a>`;
}

function summaryHtml(site: SiteModel, revision: Revision): string {
  if (revision.pr === null) return revision.reason;
  const pr =
    site.repoUrl === null
      ? `PR #${revision.pr}`
      : `<a class="external" href="${escapeHtml(`${site.repoUrl}/pull/${revision.pr}`)}">PR #${revision.pr}</a>`;
  return `${revision.reason} (${pr})`;
}

/** Banner for /wiki/<id>/history/<n>/. */
export function oldRevisionNotice(site: SiteModel, revision: Revision): string {
  const current = site.pages.get(revision.featureId)?.id === revision.id;
  const when = `as of ${formatDate(revision.commitDate)} (commit ${commitHtml(site, revision)})`;
  return current
    ? `This is the current revision of this page, ${when}.`
    : `This is an old revision of this page, ${when}. It may differ significantly from the <a href="${articleUrl(revision.featureId)}">current revision</a>.`;
}
```

`packages/site/src/components/PageTabs.astro`:

```astro
---
import { articleUrl, historyUrl } from "../urls.ts";

interface Props {
  featureId: string;
  current: "article" | "history";
}

const { featureId, current } = Astro.props;
---
<nav class="page-tabs" aria-label="Page views">
  <a href={articleUrl(featureId)} aria-current={current === "article" ? "page" : undefined}>Article</a>
  <a href={historyUrl(featureId)} aria-current={current === "history" ? "page" : undefined}>View history</a>
</nav>
```

`packages/site/src/pages/wiki/[slug]/history/index.astro`:

```astro
---
import PageTabs from "../../../../components/PageTabs.astro";
import { historyRows } from "../../../../history.ts";
import Layout from "../../../../layouts/Layout.astro";
import { getSite } from "../../../../site.ts";

export function getStaticPaths() {
  return [...getSite().history.keys()].map((slug) => ({ params: { slug } }));
}

const site = getSite();
const featureId = Astro.params.slug as string;
const title = site.features.get(featureId)?.title ?? featureId;
const rows = historyRows(site, featureId);
---
<Layout title={`${title}: Revision history`}>
  <PageTabs featureId={featureId} current="history" />
  <h1 class="page-title">{title}: Revision history</h1>
  <p class="history-help">Newest first. Dates are the dates of the commits each revision documents.</p>
  <ul class="history">
    {rows.map((row) => (
      <li>
        <a href={row.oldHref}>{row.date}</a>
        <span class="history-commit" set:html={row.commitHtml} />
        <span class="history-summary" set:html={row.summaryHtml} />
        <span class="history-cost">{row.cost}</span>
      </li>
    ))}
  </ul>
</Layout>
```

`packages/site/src/pages/wiki/[slug]/history/[n].astro`:

```astro
---
import type { Revision } from "@repowiki/core";
import { articleView } from "../../../../article.ts";
import Article from "../../../../components/Article.astro";
import { oldRevisionNotice } from "../../../../history.ts";
import Layout from "../../../../layouts/Layout.astro";
import { getSite } from "../../../../site.ts";

export function getStaticPaths() {
  return [...getSite().history.entries()].flatMap(([slug, revisions]) =>
    revisions.map((revision, index) => ({
      params: { slug, n: String(index + 1) },
      props: { revision },
    })),
  );
}

const { revision } = Astro.props as { revision: Revision };
const site = getSite();
const view = { ...articleView(site, revision), notice: oldRevisionNotice(site, revision) };
---
<Layout title={`${view.title} (old revision)`}>
  <Article view={view} indexed={false} tab="history" />
</Layout>
```

In `packages/site/src/components/Article.astro`:

Replace:
```astro
import { getSite } from "../site.ts";
```
with:
```astro
import { getSite } from "../site.ts";
import PageTabs from "./PageTabs.astro";
```

Replace:
```astro
  indexed: boolean;
}

const { view, indexed } = Astro.props;
const { wiki } = getSite();
---
<article class="article" data-pagefind-body={indexed ? "" : undefined}>
```
with:
```astro
  indexed: boolean;
  /** Which page tab is highlighted: the article, or (for old revisions) its history. */
  tab?: "article" | "history";
}

const { view, indexed, tab = "article" } = Astro.props;
const { wiki } = getSite();
---
<PageTabs featureId={view.featureId} current={tab} />
<article class="article" data-pagefind-body={indexed ? "" : undefined}>
```

In `packages/site/src/pages/wiki/[slug]/index.astro`:

Replace:
```astro
import { leadSummary } from "../../../summary.ts";
```
with:
```astro
import { leadSummary } from "../../../summary.ts";
import { historyUrl } from "../../../urls.ts";
```

Replace:
```astro
    </p>
  </Layout>
```
with:
```astro
    </p>
    {site.history.has(route.slug) && <p><a href={historyUrl(route.slug)}>View history</a></p>}
  </Layout>
```

Append to `packages/site/src/styles/wiki.css`:

```css
/* Page tabs and history */
.page-tabs {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.5rem;
  font-size: 0.875rem;
}

.page-tabs a[aria-current="page"] {
  color: var(--text);
  font-weight: bold;
}

.history-help {
  font-size: 0.875rem;
  color: var(--text-muted);
}

.history {
  list-style: none;
  padding: 0;
}

.history li {
  margin: 0.4rem 0;
}

.history li > * + * {
  margin-left: 0.5rem;
}

.history-cost {
  font-size: 0.8rem;
  color: var(--text-muted);
}
```

- [ ] **Step 5: Update the snapshots, review them, run the check**

```bash
pnpm vitest run packages/site -u
pnpm check
```

Expected:
- `wiki-signals-history.html` is written. It lists 10 March 2026 (`update (PR #88)`) above 3 February 2026 (`build`).
- `wiki-signals.html` and `wiki-legacy-signals.html` change only by the Article / View history tabs and the "View history" link.
- `pnpm check` passes (421 tests in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/site
git commit -m "feat(site): render revision history and old revisions"
```

Ship. PR title: `feat(site): revision history and old revisions`.

---

### Task 14: Diffs between revisions

**Ticket:** `[M5] site: diffs between revisions`

**Files:**
- Create: `packages/site/src/pages/wiki/[slug]/diff/[n].astro`
- Modify: `packages/site/src/history.ts`, `packages/site/src/pages/wiki/[slug]/history/index.astro`, `packages/site/src/styles/wiki.css` (append)
- Test: `packages/site/src/history.test.ts`, `packages/site/src/site.test.ts`; snapshot `wiki-signals-diff-2.html`

**Interfaces:**
- Consumes: `revisionDiff` (Task 12), and `historyRows` and `PageTabs` (Task 13).
- Produces:
  - `HistoryRow.diffHref: string | null`, which is null for the first revision.
  - `revisionLabelHtml(site, revision, n)`.
  - The page `/wiki/<id>/diff/<n>/` for `n >= 2`.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/diff-pages
```

- [ ] **Step 2: Write the failing tests**

In `packages/site/src/history.test.ts`:

Replace:
```ts
import { describe, expect, it } from "vitest";
import { historyRows, oldRevisionNotice } from "./history.ts";
import { buildSiteModel } from "./model.ts";
```
with:
```ts
import { describe, expect, it } from "vitest";
import { historyRows, oldRevisionNotice, revisionLabelHtml } from "./history.ts";
import { buildSiteModel } from "./model.ts";
```

Replace:
```ts
describe("historyRows", () => {
  it("lists revisions newest first, dated by commit", () => {
    expect(historyRows(site, "signals")).toEqual([
```
with:
```ts
describe("historyRows", () => {
  it("lists revisions newest first, dated by commit, with diff links after the first", () => {
    expect(historyRows(site, "signals")).toEqual([
```

Replace:
```ts
        oldHref: "/wiki/signals/history/2/",
        summaryHtml: `update (<a class="external" href="${REPO}/pull/88">PR #88</a>)`,
```
with:
```ts
        oldHref: "/wiki/signals/history/2/",
        diffHref: "/wiki/signals/diff/2/",
        summaryHtml: `update (<a class="external" href="${REPO}/pull/88">PR #88</a>)`,
```

Replace:
```ts
        oldHref: "/wiki/signals/history/1/",
        summaryHtml: "build",
```
with:
```ts
        oldHref: "/wiki/signals/history/1/",
        diffHref: null,
        summaryHtml: "build",
```

Replace:
```ts

describe("oldRevisionNotice", () => {
  const plain = buildSiteModel(fixtureExport(), null);
```
with:
```ts

describe("oldRevisionNotice and revisionLabelHtml", () => {
  const plain = buildSiteModel(fixtureExport(), null);
```

Replace:
```ts
    );
  });
});
```
with:
```ts
    );
  });

  it("labels a revision for the diff header", () => {
    expect(revisionLabelHtml(plain, first, 1)).toBe(
      '<a href="/wiki/signals/history/1/">Revision as of 3 February 2026</a> (commit <code>aaaaaaa</code>)',
    );
  });
});
```

In `packages/site/src/site.test.ts`:

Replace:
```ts
describe("history pages", () => {
  it("lists every revision newest first with links to each old revision", () => {
    const html = site.read("wiki/signals/history/index.html");
```
with:
```ts
describe("history pages", () => {
  it("lists every revision newest first with prev-diff and old-revision links", () => {
    const html = site.read("wiki/signals/history/index.html");
```

Replace:
```ts
    expect(first).toBeGreaterThan(second);
  });
```
with:
```ts
    expect(first).toBeGreaterThan(second);
    expect(html).toContain('(<a href="/wiki/signals/diff/2/">prev</a>)');
    expect(html).toContain("(<span>prev</span>)");
  });
```

Replace:
```ts
    expect(html).not.toContain("data-pagefind-body");
  });
```
with:
```ts
    expect(html).not.toContain("data-pagefind-body");
  });

  it("diffs a revision against its parent", () => {
    const html = site.read("wiki/signals/diff/2/index.html");
    expect(html).toContain("Signals are <del>built</del><ins>created</ins> from");
    expect(html).toContain('<div class="diff-row diff-added">');
    expect(existsSync(join(site.outDir, "wiki", "signals", "diff", "1"))).toBe(false);
  });
```

Replace:
```ts
      "__snapshots__/wiki-signals-history.html",
    );
  });
});
```
with:
```ts
      "__snapshots__/wiki-signals-history.html",
    );
    await expect(normalized("wiki/signals/diff/2/index.html")).toMatchFileSnapshot(
      "__snapshots__/wiki-signals-diff-2.html",
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site`
Expected: FAIL. `revisionLabelHtml` is not exported, the history rows have no `diffHref`, and `wiki/signals/diff/2/index.html` does not exist.

- [ ] **Step 4: Implement**

In `packages/site/src/history.ts`:

Replace:
```ts
import type { SiteModel } from "./model.ts";
import { articleUrl, oldRevisionUrl } from "./urls.ts";
```
with:
```ts
import type { SiteModel } from "./model.ts";
import { articleUrl, diffUrl, oldRevisionUrl } from "./urls.ts";
```

Replace:
```ts
  oldHref: string;
  /** "update (PR #88)" with links when the repo URL is known. */
```
with:
```ts
  oldHref: string;
  /** Diff against the previous revision; null for the first. */
  diffHref: string | null;
  /** "update (PR #88)" with links when the repo URL is known. */
```

Replace:
```ts
        oldHref: oldRevisionUrl(featureId, n),
        summaryHtml: summaryHtml(site, revision),
```
with:
```ts
        oldHref: oldRevisionUrl(featureId, n),
        diffHref: n === 1 ? null : diffUrl(featureId, n),
        summaryHtml: summaryHtml(site, revision),
```

Replace:
```ts
    : `This is an old revision of this page, ${when}. It may differ significantly from the <a href="${articleUrl(revision.featureId)}">current revision</a>.`;
}
```
with:
```ts
    : `This is an old revision of this page, ${when}. It may differ significantly from the <a href="${articleUrl(revision.featureId)}">current revision</a>.`;
}

/** "Revision as of 10 March 2026 (commit bbbbbbb)" linking to that revision's page. */
export function revisionLabelHtml(site: SiteModel, revision: Revision, n: number): string {
  return `<a href="${oldRevisionUrl(revision.featureId, n)}">Revision as of ${formatDate(revision.commitDate)}</a> (commit ${commitHtml(site, revision)})`;
}
```

In `packages/site/src/pages/wiki/[slug]/history/index.astro`:

Replace:
```astro
  <h1 class="page-title">{title}: Revision history</h1>
  <p class="history-help">Newest first. Dates are the dates of the commits each revision documents.</p>
  <ul class="history">
```
with:
```astro
  <h1 class="page-title">{title}: Revision history</h1>
  <p class="history-help">
    Newest first. Dates are the dates of the commits each revision documents. "prev" shows what
    that revision changed.
  </p>
  <ul class="history">
```

Replace:
```astro
      <li>
        <a href={row.oldHref}>{row.date}</a>
```
with:
```astro
      <li>
        ({row.diffHref === null ? <span>prev</span> : <a href={row.diffHref}>prev</a>})
        <a href={row.oldHref}>{row.date}</a>
```

`packages/site/src/pages/wiki/[slug]/diff/[n].astro`:

```astro
---
import type { Revision } from "@repowiki/core";
import PageTabs from "../../../../components/PageTabs.astro";
import { revisionDiff } from "../../../../diff.ts";
import { revisionLabelHtml } from "../../../../history.ts";
import Layout from "../../../../layouts/Layout.astro";
import { getSite } from "../../../../site.ts";

export function getStaticPaths() {
  return [...getSite().history.entries()].flatMap(([slug, revisions]) =>
    revisions.slice(1).map((after, index) => ({
      params: { slug, n: String(index + 2) },
      props: { before: revisions[index] as Revision, after, n: index + 2 },
    })),
  );
}

const { before, after, n } = Astro.props as { before: Revision; after: Revision; n: number };
const site = getSite();
const featureId = after.featureId;
const title = site.features.get(featureId)?.title ?? featureId;
const sections = revisionDiff(before, after);
const SIGNS = { context: "", removed: "-", added: "+", changed: "~" } as const;
const LABELS = {
  context: "Unchanged",
  removed: "Removed",
  added: "Added",
  changed: "Changed",
} as const;
---
<Layout title={`${title}: Difference between revisions`}>
  <PageTabs featureId={featureId} current="history" />
  <h1 class="page-title">{title}: Difference between revisions</h1>
  <div class="diff-header">
    <p set:html={revisionLabelHtml(site, before, n - 1)} />
    <p set:html={revisionLabelHtml(site, after, n)} />
  </div>
  {sections.length === 0 && <p>No difference in the article text.</p>}
  {sections.map((section) => (
    <section class="diff-section">
      <h2>{section.title}</h2>
      {section.rows.map((row) => (
        <div class={`diff-row diff-${row.kind}`}>
          <span class="diff-sign" aria-hidden="true">{SIGNS[row.kind]}</span>
          <span class="visually-hidden">{LABELS[row.kind]}: </span>
          <span class="diff-text" set:html={row.html} />
        </div>
      ))}
    </section>
  ))}
</Layout>
```

In `packages/site/src/styles/wiki.css` (a header rename, then a block appended at the end):

Replace:
```css

/* Page tabs and history */
.page-tabs {
```
with:
```css

/* Page tabs, history and diffs */
.page-tabs {
```

Replace:
```css
  font-size: 0.8rem;
  color: var(--text-muted);
}
```
with:
```css
  font-size: 0.8rem;
  color: var(--text-muted);
}

.diff-header {
  display: flex;
  flex-wrap: wrap;
  gap: 0 2rem;
}

.diff-row {
  display: flex;
  gap: 0.5rem;
  margin: 0.25rem 0;
  padding: 0.25rem 0.5rem;
  border-left: 4px solid var(--border-subtle);
}

.diff-removed {
  border-left-color: #d33;
}

.diff-added {
  border-left-color: #14866d;
}

.diff-changed {
  border-left-color: var(--notice-border);
}

.diff-context {
  color: var(--text-muted);
}

.diff-sign {
  flex: 0 0 1ch;
  font-family: var(--font-mono);
}

del {
  background: rgba(221, 51, 51, 0.2);
  text-decoration: line-through;
}

ins {
  background: rgba(20, 134, 109, 0.2);
  text-decoration: none;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
```

- [ ] **Step 5: Update the snapshots, review them, run the check**

```bash
pnpm vitest run packages/site -u
pnpm check
```

Expected:
- `wiki-signals-diff-2.html` is written. It has a Lead section with a "changed" row (`<ins>is the subsystem of demo-repo that </ins>`), and Overview starts `Signals are <del>built</del><ins>created</ins> from`.
- `wiki-signals-history.html` gains `(prev)` links.
- `pnpm check` passes (423 tests in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/site
git commit -m "feat(site): render diffs between revisions"
```

Ship. PR title: `feat(site): diffs between revisions`.

---

### Task 15: Hover previews

**Ticket:** `[M5] site: hover previews`

**Files:**
- Create: `packages/site/src/preview.ts`, `packages/site/src/pages/api/preview/[slug].json.ts`, `packages/site/src/client/preview.ts`
- Modify: `packages/site/src/layouts/Layout.astro`, `packages/site/src/styles/wiki.css` (append)
- Test: `packages/site/src/preview.test.ts`, `packages/site/src/site.test.ts` (append)

**Interfaces:**
- Consumes: `hasArticleRoute`, `finalTarget` and `leadSummary` (Tasks 7 and 11), `formatDate` and `formatNumber` (Task 9), and the `data-preview` attribute that `renderInline` writes (Task 7).
- Produces:
  - `interface Preview { title; url; html }`.
  - `previewData(site, id): Preview | null`.
  - A static `/api/preview/<id>.json` for every id with a preview.
  - Hover and focus cards (`#preview-card`, `role="tooltip"`), which Escape closes.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/hover-previews
```

- [ ] **Step 2: Write the failing tests**

`packages/site/src/preview.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSiteModel } from "./model.ts";
import { previewData } from "./preview.ts";
import { fixtureExport } from "./test-fixtures.ts";

const site = buildSiteModel(fixtureExport(), null);

describe("previewData", () => {
  it("shows the link-free lead and key facts of an article", () => {
    expect(previewData(site, "deliverables")).toEqual({
      title: "Deliverables",
      url: "/wiki/deliverables/",
      html: '<p><b>Deliverables</b> are the records that Signal ingestion feed.</p><p class="preview-facts">2 files &middot; 410 lines &middot; Python &middot; last commit 20 February 2026</p>',
    });
  });

  it("previews a redirect as its target", () => {
    expect(previewData(site, "legacy-signals")).toEqual(previewData(site, "signals"));
    expect(previewData(site, "signals")?.html).not.toContain("<a ");
  });

  it("lists the targets of a disambiguation", () => {
    expect(previewData(site, "reports")?.html).toBe(
      "<p><b>Reports</b> may refer to: Signal ingestion, Deliverables.</p>",
    );
  });

  it("has nothing for features without a page", () => {
    expect(previewData(site, "scheduler")).toBeNull();
    expect(previewData(site, "ghost")).toBeNull();
  });
});
```

Append to `packages/site/src/site.test.ts`:

```ts
describe("hover previews", () => {
  it("writes a preview file for every link that asks for one", () => {
    const ids = new Set<string>();
    for (const page of htmlFiles(site.outDir)) {
      for (const [, id = ""] of site.read(page).matchAll(/data-preview="([^"]+)"/g)) ids.add(id);
    }
    expect([...ids].sort()).toEqual(["deliverables", "legacy-signals", "signals"]);
    for (const id of ids) {
      expect(existsSync(join(site.outDir, "api", "preview", `${id}.json`))).toBe(true);
    }
  });

  it("serves the target's lead for a redirect", () => {
    const preview = JSON.parse(site.read("api/preview/legacy-signals.json"));
    expect(preview.title).toBe("Signal ingestion");
    expect(preview.url).toBe("/wiki/signals/");
    expect(preview.html).toContain("<b>Signal ingestion</b> is the subsystem of demo-repo");
  });

  it("loads the preview script on every page", () => {
    for (const page of ["index.html", "wiki/signals/index.html", "wiki/reports/index.html"]) {
      expect(site.read(page)).toMatch(/<script type="module" src="\/_astro\/[^"]+\.js"><\/script>/);
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site`
Expected: FAIL with `Error: Cannot find module './preview.ts'`. The preview-file test fails on the missing `api/preview/*.json` files.

- [ ] **Step 4: Implement**

`packages/site/src/preview.ts`:

```ts
import { formatDate, formatNumber } from "./format.ts";
import { escapeHtml } from "./inline.ts";
import { finalTarget, hasArticleRoute, type SiteModel } from "./model.ts";
import { leadSummary } from "./summary.ts";
import { articleUrl } from "./urls.ts";

/** Body of /api/preview/<id>.json, shown when a reader hovers or focuses a link to <id>. */
export interface Preview {
  title: string;
  url: string;
  /** Escaped at build time; the client inserts it as-is. */
  html: string;
}

/** Preview for a link target. Redirects preview their final target; null when there is none. */
export function previewData(site: SiteModel, id: string): Preview | null {
  if (!hasArticleRoute(site, id)) return null;
  const targetId = finalTarget(site, id);
  const feature = site.features.get(targetId);
  if (feature === undefined) return null;
  const url = articleUrl(targetId);

  if (feature.status.kind === "disambiguation") {
    const names = feature.status.to.map((to) => escapeHtml(site.features.get(to)?.title ?? to));
    const html = `<p><b>${escapeHtml(feature.title)}</b> may refer to: ${names.join(", ")}.</p>`;
    return { title: feature.title, url, html };
  }

  const page = site.pages.get(targetId);
  const lead = leadSummary(site, targetId);
  if (page === undefined || lead === null) return null;
  const box = page.infobox;
  const facts = [
    `${formatNumber(box.files)} files`,
    `${formatNumber(box.loc)} lines`,
    ...(box.languages.length > 0 ? [box.languages.map(escapeHtml).join(", ")] : []),
    `last commit ${formatDate(box.lastCommitDate)}`,
  ];
  const html = `<p>${lead}</p><p class="preview-facts">${facts.join(" &middot; ")}</p>`;
  return { title: feature.title, url, html };
}
```

`packages/site/src/pages/api/preview/[slug].json.ts`:

```ts
import type { APIRoute, GetStaticPaths } from "astro";
import { previewData } from "../../../preview.ts";
import { getSite } from "../../../site.ts";

export const getStaticPaths: GetStaticPaths = () => {
  const site = getSite();
  return [...site.features.keys()]
    .filter((id) => previewData(site, id) !== null)
    .map((slug) => ({ params: { slug } }));
};

export const GET: APIRoute = ({ params }) =>
  new Response(JSON.stringify(previewData(getSite(), params.slug ?? "")), {
    headers: { "content-type": "application/json" },
  });
```

`packages/site/src/client/preview.ts`:

```ts
/// <reference lib="dom" />
// Wikipedia-style page previews: hovering (or focusing) a link with data-preview shows the
// target's lead and key facts, fetched from /api/preview/<id>.json.

interface Preview {
  title: string;
  url: string;
  html: string;
}

const SHOW_DELAY_MS = 300;
const HIDE_DELAY_MS = 250;
const cache = new Map<string, Promise<Preview | null>>();
const card = document.createElement("div");
card.className = "preview-card";
card.id = "preview-card";
card.setAttribute("role", "tooltip");
card.hidden = true;
document.body.append(card);

let showTimer = 0;
let hideTimer = 0;
let anchor: HTMLAnchorElement | null = null;

function load(id: string): Promise<Preview | null> {
  let pending = cache.get(id);
  if (pending === undefined) {
    pending = fetch(`/api/preview/${encodeURIComponent(id)}.json`)
      .then((response) => (response.ok ? (response.json() as Promise<Preview | null>) : null))
      .catch(() => null);
    cache.set(id, pending);
  }
  return pending;
}

async function show(link: HTMLAnchorElement): Promise<void> {
  const preview = await load(link.dataset.preview ?? "");
  if (preview === null || anchor !== link) return;
  const title = document.createElement("a");
  title.className = "preview-title";
  title.href = preview.url;
  title.textContent = preview.title;
  const body = document.createElement("div");
  body.innerHTML = preview.html; // built and escaped by the site generator, same origin
  card.replaceChildren(title, body);
  card.hidden = false;
  const rect = link.getBoundingClientRect();
  const width = Math.min(352, document.documentElement.clientWidth - 16);
  card.style.width = `${width}px`;
  card.style.left = `${Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 8)) + window.scrollX}px`;
  card.style.top = `${rect.bottom + window.scrollY + 6}px`;
  link.setAttribute("aria-describedby", card.id);
}

function hide(): void {
  window.clearTimeout(showTimer);
  card.hidden = true;
  anchor?.removeAttribute("aria-describedby");
  anchor = null;
}

function previewLink(target: EventTarget | null): HTMLAnchorElement | null {
  return target instanceof Element ? target.closest<HTMLAnchorElement>("a[data-preview]") : null;
}

function enter(link: HTMLAnchorElement, delay: number): void {
  window.clearTimeout(hideTimer);
  if (anchor === link) return;
  hide();
  anchor = link;
  showTimer = window.setTimeout(() => void show(link), delay);
}

function leave(): void {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hide, HIDE_DELAY_MS);
}

if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
  document.addEventListener("mouseover", (event) => {
    const link = previewLink(event.target);
    if (link !== null) enter(link, SHOW_DELAY_MS);
    else if (card.contains(event.target as Node)) window.clearTimeout(hideTimer);
  });
  document.addEventListener("mouseout", (event) => {
    if (previewLink(event.target) !== null || card.contains(event.target as Node)) leave();
  });
}
document.addEventListener("focusin", (event) => {
  const link = previewLink(event.target);
  if (link !== null) enter(link, 0);
});
document.addEventListener("focusout", (event) => {
  if (previewLink(event.target) !== null) leave();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hide();
});
```

In `packages/site/src/layouts/Layout.astro`:

Replace:
```astro
    </footer>
  </body>
```
with:
```astro
    </footer>
    <script>
      import "../client/preview.ts";
    </script>
  </body>
```

Append to `packages/site/src/styles/wiki.css`:

```css
/* Hover previews */
.preview-card {
  position: absolute;
  z-index: 10;
  padding: 0.75rem 1rem;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 2px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  font-size: 0.875rem;
  line-height: 1.5;
}

.preview-card p {
  margin: 0.25rem 0;
}

.preview-title {
  font-family: var(--font-serif);
  font-size: 1.1rem;
}

.preview-facts {
  color: var(--text-muted);
  font-size: 0.8rem;
}
```

- [ ] **Step 5: Update the snapshots, check, and hover by hand**

```bash
pnpm vitest run packages/site -u
pnpm check
pnpm site:demo
```

Expected:
- Every snapshot changes only by one more `<script type="module" src="/_astro/ASSET">` tag.
- `pnpm check` passes (430 tests in the trial).
- In the demo, hovering "deliverable records" on `/wiki/signals/` shows a card titled Deliverables, with "2 files · 410 lines · Python · last commit 20 February 2026". Tabbing to the link shows the card too, and Escape hides it.

- [ ] **Step 6: Commit and ship**

```bash
git add packages/site
git commit -m "feat(site): show hover previews of linked features"
```

Ship. PR title: `feat(site): hover previews`.

---

### Task 16: Main Page, Random article and All articles

**Ticket:** `[M5] site: Main Page, Random article and All articles`

**Files:**
- Create:
  - `packages/site/src/main-page.ts`
  - `packages/site/src/pages/random.astro`
  - `packages/site/src/client/random.ts`
  - `packages/site/src/pages/special/all-pages.astro`
- Modify: `packages/site/src/pages/index.astro` (whole file), `packages/site/src/layouts/Layout.astro`, `packages/site/src/styles/wiki.css` (append)
- Test: `packages/site/src/main-page.test.ts`, `packages/site/src/site.test.ts` (append); snapshot `index.html`

**Interfaces:**
- Consumes: `leadSummary` (Task 11), `renderInline` and `featureLink` (Task 7), and `formatDate` (Task 9).
- Produces:
  - `DID_YOU_KNOW_COUNT = 5` and `RECENT_COUNT = 5`.
  - `rotation(head, length)`.
  - `didYouKnowText(text)`.
  - `interface MainPageView { articleCount; featured; didYouKnow; recent }`.
  - `mainPageView(site)`.
  - The pages `/random/` and `/special/all-pages/`, both linked from the site nav.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/main-page
```

- [ ] **Step 2: Write the failing tests**

`packages/site/src/main-page.test.ts`:

```ts
import { SHA_C } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { didYouKnowText, mainPageView, rotation } from "./main-page.ts";
import { buildSiteModel } from "./model.ts";
import { fixtureExport } from "./test-fixtures.ts";

const site = buildSiteModel(fixtureExport(), null);

describe("rotation", () => {
  it("is seeded by the head sha and stays in range", () => {
    expect(rotation(SHA_C, 3)).toBe(0);
    expect(rotation("0000000500000000000000000000000000000000", 3)).toBe(2);
    expect(rotation(SHA_C, 0)).toBe(0);
  });
});

describe("didYouKnowText", () => {
  it.each([
    ["Signals are built from chunks.", "... that signals are built from chunks?"],
    ["API keys rotate daily.", "... that API keys rotate daily?"],
    ["`ingest_chunk` retries twice", "... that `ingest_chunk` retries twice?"],
    ["Is it cached?", "... that is it cached?"],
  ])("turns %j into %j", (text, hook) => {
    expect(didYouKnowText(text)).toBe(hook);
  });
});

describe("mainPageView", () => {
  const view = mainPageView(site);

  it("counts active articles and features one chosen by the head sha", () => {
    expect(view.articleCount).toBe(2);
    expect(view.featured).toEqual({
      href: "/wiki/deliverables/",
      title: "Deliverables",
      leadHtml: "<b>Deliverables</b> are the records that Signal ingestion feed.",
    });
  });

  it("draws Did you know from hook claims of active articles", () => {
    expect(view.didYouKnow.map((item) => [item.title, item.html])).toEqual([
      [
        "Deliverables",
        "... that deliverables are stored as rows in the <code>deliverables</code> table?",
      ],
      [
        "Signal ingestion",
        "... that signals are created from ingested chunks by <code>ingest_chunk</code>?",
      ],
      ["Signal ingestion", "... that signal ingestion was introduced in PR #45?"],
    ]);
  });

  it("lists recently updated articles newest first, by commit date", () => {
    expect(view.recent).toEqual([
      { href: "/wiki/signals/", title: "Signal ingestion", date: "10 March 2026" },
      { href: "/wiki/deliverables/", title: "Deliverables", date: "20 February 2026" },
      { href: "/wiki/exporter/", title: "CSV exporter", date: "15 January 2026" },
    ]);
  });
});
```

Append to `packages/site/src/site.test.ts`:

```ts
describe("Main Page, Random article and All articles", () => {
  it("shows the featured article, Did you know hooks and recent updates", () => {
    const html = site.read("index.html");
    expect(html).toContain("2 articles.");
    expect(html).toContain('(<a href="/wiki/deliverables/">Full article...</a>)');
    expect(html).toContain(
      '... that signal ingestion was introduced in PR #45?</span> <span class="dyk-source">(<a href="/wiki/signals/">Signal ingestion</a>)</span>',
    );
    expect(html.indexOf("10 March 2026")).toBeLessThan(html.indexOf("20 February 2026"));
  });

  it("sends Random article to one of the active articles", () => {
    expect(site.read("random/index.html")).toContain(
      '<script type="application/json" id="random-targets">["/wiki/deliverables/","/wiki/signals/"]</script>',
    );
  });

  it("lists every routed feature, marking redirects and disambiguations", () => {
    const html = site.read("special/all-pages/index.html");
    expect(html).toContain('<span class="all-pages-note">(redirect to Signal ingestion)</span>');
    expect(html).toContain('<span class="all-pages-note">(disambiguation)</span>');
    expect(html).toContain('<span class="all-pages-note">(retired)</span>');
    expect(html).not.toContain("Scheduler");
  });

  it("links Random article and All articles from every page", () => {
    expect(site.read("wiki/signals/index.html")).toContain('<a href="/random/">Random article</a>');
  });

  it("matches the golden snapshot", async () => {
    await expect(normalized("index.html")).toMatchFileSnapshot("__snapshots__/index.html");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site`
Expected: FAIL with `Error: Cannot find module './main-page.ts'`. The Main Page tests fail on the old placeholder page.

- [ ] **Step 4: Implement**

`packages/site/src/main-page.ts`:

```ts
import { formatDate } from "./format.ts";
import { renderInline } from "./inline.ts";
import { featureLink, type SiteModel } from "./model.ts";
import { leadSummary } from "./summary.ts";
import { articleUrl } from "./urls.ts";

export const DID_YOU_KNOW_COUNT = 5;
export const RECENT_COUNT = 5;

export interface MainPageView {
  articleCount: number;
  featured: { href: string; title: string; leadHtml: string } | null;
  didYouKnow: { html: string; href: string; title: string }[];
  recent: { href: string; title: string; date: string }[];
}

/** Deterministic rotation seeded by the head sha: the same export always shows the same page. */
export function rotation(head: string, length: number): number {
  return length === 0 ? 0 : Number.parseInt(head.slice(0, 8), 16) % length;
}

/** "Signals are built." -> "... that signals are built?" (lowercased only before a lowercase letter). */
export function didYouKnowText(text: string): string {
  const question = text.trim().replace(/[.!]$/, "?");
  const lowered = /^[A-Z][a-z]/.test(question)
    ? question.charAt(0).toLowerCase() + question.slice(1)
    : question;
  return `... that ${lowered}${lowered.endsWith("?") ? "" : "?"}`;
}

export function mainPageView(site: SiteModel): MainPageView {
  const link = (id: string) => featureLink(site, id);
  const active = [...site.pages.values()]
    .filter((page) => site.features.get(page.featureId)?.status.kind === "active")
    .sort((a, b) => (a.featureId < b.featureId ? -1 : 1));

  const pick = active[rotation(site.wiki.head, active.length)];
  const featured =
    pick === undefined
      ? null
      : {
          href: articleUrl(pick.featureId),
          title: site.features.get(pick.featureId)?.title ?? pick.featureId,
          leadHtml: leadSummary(site, pick.featureId) ?? "",
        };

  const hooks = active.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.claims
        .filter((claim) => claim.hook)
        .map((claim) => ({
          html: renderInline(didYouKnowText(claim.text), { link }),
          href: articleUrl(page.featureId),
          title: site.features.get(page.featureId)?.title ?? page.featureId,
        })),
    ),
  );
  const start = rotation(site.wiki.head, hooks.length);
  const didYouKnow = [...hooks.slice(start), ...hooks.slice(0, start)].slice(0, DID_YOU_KNOW_COUNT);

  const recent = [...site.pages.values()]
    .filter(
      (page) =>
        link(page.featureId) !== null &&
        site.features.get(page.featureId)?.status.kind !== "redirect",
    )
    .sort(
      (a, b) =>
        Date.parse(b.commitDate) - Date.parse(a.commitDate) || (a.featureId < b.featureId ? -1 : 1),
    )
    .slice(0, RECENT_COUNT)
    .map((page) => ({
      href: articleUrl(page.featureId),
      title: site.features.get(page.featureId)?.title ?? page.featureId,
      date: formatDate(page.commitDate),
    }));

  return { articleCount: active.length, featured, didYouKnow, recent };
}
```

Replace `packages/site/src/pages/index.astro` with:

```astro
---
import Layout from "../layouts/Layout.astro";
import { mainPageView } from "../main-page.ts";
import { getSite } from "../site.ts";

const site = getSite();
const view = mainPageView(site);
---
<Layout title="Main page">
  <div class="mp-welcome">
    <h1 class="mp-title">Welcome to the {site.wiki.repo} wiki</h1>
    <p>
      The feature-by-feature encyclopedia of <code>{site.wiki.repo}</code>, generated from commit
      <code>{site.wiki.head.slice(0, 7)}</code>. {view.articleCount} articles.
    </p>
  </div>
  <div class="mp-columns">
    <section class="mp-box" aria-labelledby="mp-featured">
      <h2 id="mp-featured">From the featured article</h2>
      {view.featured === null ? (
        <p>No articles yet.</p>
      ) : (
        <>
          <p set:html={view.featured.leadHtml} />
          <p>(<a href={view.featured.href}>Full article...</a>)</p>
        </>
      )}
    </section>
    <section class="mp-box" aria-labelledby="mp-dyk">
      <h2 id="mp-dyk">Did you know...</h2>
      <ul>
        {view.didYouKnow.map((item) => (
          <li>
            <span set:html={item.html} /> <span class="dyk-source">(<a href={item.href}>{item.title}</a>)</span>
          </li>
        ))}
      </ul>
    </section>
    <section class="mp-box" aria-labelledby="mp-recent">
      <h2 id="mp-recent">Recently updated</h2>
      <ul>
        {view.recent.map((item) => (
          <li><a href={item.href}>{item.title}</a> <span class="mp-date">{item.date}</span></li>
        ))}
      </ul>
    </section>
  </div>
</Layout>
```

`packages/site/src/pages/random.astro`:

```astro
---
import Layout from "../layouts/Layout.astro";
import { getSite } from "../site.ts";
import { articleUrl } from "../urls.ts";

const site = getSite();
const urls = [...site.pages.keys()]
  .filter((id) => site.features.get(id)?.status.kind === "active")
  .sort()
  .map(articleUrl);
---
<Layout title="Random article">
  <h1 class="page-title">Random article</h1>
  <p id="random-status">
    Choosing a random article... If nothing happens, pick one from
    <a href="/special/all-pages/">All articles</a>.
  </p>
  <script type="application/json" id="random-targets" set:html={JSON.stringify(urls).replace(/</g, "\\u003c")} />
</Layout>
<script>
  import "../client/random.ts";
</script>
```

`packages/site/src/client/random.ts`:

```ts
/// <reference lib="dom" />
// /random/ sends the reader to a uniformly random active article.
const data = document.getElementById("random-targets")?.textContent ?? "[]";
const urls = JSON.parse(data) as string[];
const pick = urls[Math.floor(Math.random() * urls.length)];
if (pick !== undefined) window.location.replace(pick);
```

`packages/site/src/pages/special/all-pages.astro`:

```astro
---
import Layout from "../../layouts/Layout.astro";
import { featureLink } from "../../model.ts";
import { getSite } from "../../site.ts";

const site = getSite();
const entries = site.wiki.manifest.features
  .flatMap((feature) => {
    const link = featureLink(site, feature.id);
    if (link === null) return [];
    const { status } = feature;
    const note =
      status.kind === "redirect"
        ? `redirect to ${site.features.get(status.to)?.title ?? status.to}`
        : status.kind === "disambiguation"
          ? "disambiguation"
          : status.kind === "retired"
            ? "retired"
            : null;
    return [{ href: link.href, title: feature.title, note }];
  })
  .sort((a, b) => a.title.localeCompare(b.title, "en"));
---
<Layout title="All articles">
  <h1 class="page-title">All articles</h1>
  <ul class="all-pages">
    {entries.map((entry) => (
      <li>
        <a href={entry.href} class={entry.note === null ? undefined : "all-pages-other"}>{entry.title}</a>
        {entry.note !== null && <span class="all-pages-note">({entry.note})</span>}
      </li>
    ))}
  </ul>
</Layout>
```

In `packages/site/src/layouts/Layout.astro`:

Replace:
```astro
          <li><a href="/">Main page</a></li>
        </ul>
```
with:
```astro
          <li><a href="/">Main page</a></li>
          <li><a href="/random/">Random article</a></li>
          <li><a href="/special/all-pages/">All articles</a></li>
        </ul>
```

Append to `packages/site/src/styles/wiki.css`:

```css
/* Main Page and special pages */
.mp-welcome {
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  border: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
  text-align: center;
}

.mp-title {
  font-family: var(--font-serif);
  font-size: 1.8rem;
  font-weight: normal;
  margin: 0;
}

.mp-columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: 1rem;
}

.mp-box {
  padding: 0 1rem 0.5rem;
  border: 1px solid var(--border-subtle);
}

.mp-box h2 {
  margin: 0 -1rem 0.5rem;
  padding: 0.25rem 1rem;
  font-family: var(--font-sans);
  font-size: 1rem;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-subtle);
}

.mp-box ul {
  padding-left: 1.25rem;
}

.mp-date,
.dyk-source,
.all-pages-note {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.all-pages-other {
  font-style: italic;
}
```

- [ ] **Step 5: Update the snapshots, review them, run the check**

```bash
pnpm vitest run packages/site -u
pnpm check
```

Expected:
- `index.html` is written. It has the featured article (Deliverables), three Did you know... items, and Recently updated (Signal ingestion, then Deliverables, then CSV exporter).
- Every other snapshot changes only by the two new nav links.
- `pnpm check` passes (443 tests in the trial).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/site
git commit -m "feat(site): add the Main Page, Random article and All articles"
```

Ship. PR title: `feat(site): Main Page, Random article and All articles`. The PR runs to about 330 counted lines. That is over the guide, but every page in it links to the others, so it cannot be split without breaking the link crawl. Say so in the PR body.

---

### Task 17: Diagrams and the feature map

**Ticket:** `[M5] site: diagrams and feature map`

**Files:**
- Modify: `pnpm-workspace.yaml`, `packages/site/package.json`
- Create: `packages/site/src/client/mermaid.ts`, `packages/site/src/components/Diagram.astro`, `packages/site/src/feature-map.ts`
- Modify:
  - `packages/site/src/article.ts`
  - `packages/site/src/components/Article.astro`
  - `packages/site/src/pages/index.astro`
  - `packages/site/src/layouts/Layout.astro`
  - `packages/site/src/styles/wiki.css` (append)
- Test: `packages/site/src/feature-map.test.ts`, `packages/site/src/site.test.ts`

**Interfaces:**
- Consumes: `ArticleView` (Task 9), `mainPageView` and `index.astro` (Task 16), and `articleUrl` (Task 7).
- Produces:
  - `ArticleView.diagram: string | null`.
  - `<Diagram source caption />`, which renders `<figure class="diagram"><pre class="mermaid">`.
  - `featureMapSource(site): string | null`.
  - Mermaid renders on demand, with `securityLevel: "strict"`, and redraws on a color-scheme change.

- [ ] **Step 1: Branch and add Mermaid**

```bash
git switch -c m5/diagrams
```

Append the override to `pnpm-workspace.yaml`. It must be in place before Mermaid is added.

```yaml
overrides:
  lodash-es: 4.18.1
```

```bash
pnpm --filter @repowiki/site add --save-exact mermaid@12.0.0
pnpm audit   # expect: No known vulnerabilities found
```


Without the override, `pnpm audit` reports one high and one moderate advisory in `lodash-es 4.17.23`.

- [ ] **Step 2: Write the failing tests**

`packages/site/src/feature-map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { featureMapSource } from "./feature-map.ts";
import { buildSiteModel } from "./model.ts";
import { fixtureExport } from "./test-fixtures.ts";

describe("featureMapSource", () => {
  it("draws one clickable node per active article and one edge per See also pair", () => {
    expect(featureMapSource(buildSiteModel(fixtureExport(), null))).toBe(
      [
        "flowchart LR",
        '  n0["Deliverables"]',
        '  n1["Signal ingestion"]',
        "  n0 --- n1",
        '  click n0 "/wiki/deliverables/"',
        '  click n1 "/wiki/signals/"',
      ].join("\n"),
    );
  });

  it("escapes quotes in titles and is null without articles", () => {
    const wiki = fixtureExport();
    const features = wiki.manifest.features.map((f) =>
      f.id === "signals" ? { ...f, title: 'The "signals"' } : f,
    );
    const site = buildSiteModel({ ...wiki, manifest: { ...wiki.manifest, features } }, null);
    expect(featureMapSource(site)).toContain('n1["The #quot;signals#quot;"]');
    expect(featureMapSource(buildSiteModel({ ...wiki, pages: [], history: {} }, null))).toBeNull();
  });
});
```

In `packages/site/src/site.test.ts`, add `readdirSync` to the `node:fs` import and append the diagram tests:

Replace:
```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
```
with:
```ts
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
```

Replace:
```ts
    await expect(normalized("index.html")).toMatchFileSnapshot("__snapshots__/index.html");
  });
});
```
with:
```ts
    await expect(normalized("index.html")).toMatchFileSnapshot("__snapshots__/index.html");
  });
});

describe("diagrams", () => {
  it("draws the page's diagram at the top of its Data flow section", () => {
    const html = site.read("wiki/signals/index.html");
    const section = html.slice(
      html.indexOf('<h2 id="data-flow">'),
      html.indexOf('<h2 id="history">'),
    );
    expect(section).toContain(
      '<pre class="mermaid">flowchart LR\n  fetch[Fetcher] --&gt; ingest[ingest_chunk]',
    );
    expect(section).toContain("<figcaption>Data flow of Signal ingestion</figcaption>");
  });

  it("draws the feature map on the Main Page", () => {
    expect(site.read("index.html")).toContain("  click n1 &quot;/wiki/signals/&quot;</pre>");
  });

  it("bundles Mermaid locally and loads it only on demand", () => {
    const astro = readdirSync(join(site.outDir, "_astro"));
    expect(astro.some((file) => /^mermaid\.core\..+\.js$/.test(file))).toBe(true);
    const entry = site.read("index.html").match(/<script type="module" src="(\/_astro\/[^"]+)"/);
    expect(site.read(entry?.[1] ?? "")).toMatch(/import\(/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site`
Expected: FAIL with `Error: Cannot find module './feature-map.ts'`. The diagram tests fail because no `<pre class="mermaid">` is rendered.

- [ ] **Step 4: Implement**

`packages/site/src/feature-map.ts`:

```ts
import type { SiteModel } from "./model.ts";
import { articleUrl } from "./urls.ts";

/** Quotes a Mermaid node label; Mermaid reads #quot; as a literal double quote. */
function label(text: string): string {
  return `"${text.replace(/"/g, "#quot;")}"`;
}

/**
 * Main Page feature map (F10): one clickable node per active article, one undirected edge per
 * pair of articles that list each other, or one the other, in See also. Null when empty.
 */
export function featureMapSource(site: SiteModel): string | null {
  const ids = [...site.pages.keys()]
    .filter((id) => site.features.get(id)?.status.kind === "active")
    .sort();
  if (ids.length === 0) return null;
  const node = new Map(ids.map((id, index) => [id, `n${index}`]));
  const lines = ["flowchart LR"];
  for (const id of ids) {
    lines.push(`  ${node.get(id)}[${label(site.features.get(id)?.title ?? id)}]`);
  }
  const edges = new Set<string>();
  for (const id of ids) {
    for (const other of site.pages.get(id)?.seeAlso ?? []) {
      if (!node.has(other) || other === id) continue;
      const [a, b] = [id, other].sort();
      edges.add(`  ${node.get(a as string)} --- ${node.get(b as string)}`);
    }
  }
  lines.push(...[...edges].sort());
  for (const id of ids) lines.push(`  click ${node.get(id)} "${articleUrl(id)}"`);
  return lines.join("\n");
}
```

`packages/site/src/client/mermaid.ts`:

```ts
/// <reference lib="dom" />
// Renders <pre class="mermaid"> diagrams in the browser, redrawing them when the reader's color
// scheme changes. Mermaid is bundled with the site (no CDN) and only downloaded on pages that
// have a diagram.
const blocks = [...document.querySelectorAll<HTMLElement>("pre.mermaid")];
if (blocks.length > 0) {
  const { default: mermaid } = await import("mermaid");
  const sources = blocks.map((block) => block.textContent ?? "");
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const render = async (): Promise<void> => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark.matches ? "dark" : "neutral",
    });
    blocks.forEach((block, index) => {
      block.removeAttribute("data-processed");
      block.textContent = sources[index] ?? "";
    });
    await mermaid.run({ nodes: blocks });
  };
  await render();
  dark.addEventListener("change", () => void render());
}
```

`packages/site/src/components/Diagram.astro`:

```astro
---
interface Props {
  /** Mermaid source; Astro escapes it and Mermaid reads it back as text. */
  source: string;
  caption: string;
}

const { source, caption } = Astro.props;
---
<figure class="diagram">
  <pre class="mermaid">{source}</pre>
  <figcaption>{caption}</figcaption>
</figure>
```

In `packages/site/src/article.ts`:

Replace:
```ts
  leadStale: boolean;
  toc: { anchor: string; title: string }[];
```
with:
```ts
  leadStale: boolean;
  /** Mermaid source, drawn at the top of Data flow, or after the lead when there is no such section. */
  diagram: string | null;
  toc: { anchor: string; title: string }[];
```

Replace:
```ts
    ),
    toc,
```
with:
```ts
    ),
    diagram: revision.diagram,
    toc,
```

In `packages/site/src/components/Article.astro`:

Replace:
```astro
import { getSite } from "../site.ts";
import PageTabs from "./PageTabs.astro";
```
with:
```astro
import { getSite } from "../site.ts";
import Diagram from "./Diagram.astro";
import PageTabs from "./PageTabs.astro";
```

Replace:
```astro
  <p class="lead" set:html={view.leadHtml} />
  {view.toc.length > 0 && (
```
with:
```astro
  <p class="lead" set:html={view.leadHtml} />
  {view.diagram !== null && !view.sections.some((s) => s.anchor === "data-flow") && (
    <Diagram source={view.diagram} caption={`Data flow of ${view.title}`} />
  )}
  {view.toc.length > 0 && (
```

Replace:
```astro
      {section.stale && <div class="ambox ambox-stale" role="note">{STALE_NOTICE}</div>}
      <p set:html={section.html} />
```
with:
```astro
      {section.stale && <div class="ambox ambox-stale" role="note">{STALE_NOTICE}</div>}
      {section.anchor === "data-flow" && view.diagram !== null && (
        <Diagram source={view.diagram} caption={`Data flow of ${view.title}`} />
      )}
      <p set:html={section.html} />
```

In `packages/site/src/pages/index.astro`:

Replace:
```astro
---
import Layout from "../layouts/Layout.astro";
```
with:
```astro
---
import Diagram from "../components/Diagram.astro";
import { featureMapSource } from "../feature-map.ts";
import Layout from "../layouts/Layout.astro";
```

Replace:
```astro
const view = mainPageView(site);
---
```
with:
```astro
const view = mainPageView(site);
const map = featureMapSource(site);
---
```

Replace:
```astro
  </div>
</Layout>
```
with:
```astro
  </div>
  {map !== null && (
    <section class="mp-box mp-map" aria-labelledby="mp-map">
      <h2 id="mp-map">Feature map</h2>
      <Diagram
        source={map}
        caption="Each box is an article; a line joins two articles when one lists the other under See also."
      />
      <p><a href="/special/all-pages/">All articles</a> lists every article as text.</p>
    </section>
  )}
</Layout>
```

In `packages/site/src/layouts/Layout.astro`:

Replace:
```astro
      import "../client/preview.ts";
    </script>
```
with:
```astro
      import "../client/preview.ts";
      import "../client/mermaid.ts";
    </script>
```

Append to `packages/site/src/styles/wiki.css`:

```css
/* Diagrams */
.diagram {
  margin: 1rem 0;
  padding: 0.5rem;
  border: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
  overflow-x: auto;
}

.diagram pre.mermaid {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  background: none;
}

.diagram figcaption {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.mp-map {
  margin-top: 1rem;
}
```

- [ ] **Step 5: Update the snapshots, check, and look at both themes**

```bash
pnpm vitest run packages/site -u
pnpm check
pnpm site:demo
```

Expected:
- `wiki-signals.html` gains the Data flow `<figure class="diagram">`, and `index.html` gains the Feature map.
- `pnpm check` passes (448 tests in the trial).
- In the demo, `/wiki/signals/` draws Fetcher → ingest_chunk → signals table, and `/` draws Deliverables — Signal ingestion. Each map box opens its article.
- Switching the OS between light and dark redraws the diagrams in the matching theme.
- The browser's network panel shows `mermaid.core.*.js` loaded from `/_astro/` and nothing from another host.

- [ ] **Step 6: Commit and ship**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml packages/site
git commit -m "feat(site): draw Mermaid diagrams and the Main Page feature map"
```

Ship. PR title: `feat(site): diagrams and feature map`.

---

### Task 18: Pagefind search and the local browse check

**Ticket:** `[M5] site: Pagefind search and local browse check`

**Files:**
- Create: `packages/site/src/pages/search.astro`, `packages/site/src/client/search.ts`
- Modify: `packages/site/src/layouts/Layout.astro`, `packages/site/src/styles/wiki.css` (append)
- Test: `packages/site/src/site.test.ts` (append)

**Interfaces:**
- Consumes: the Pagefind bundle that `buildSite` writes to `<out>/pagefind/` (Task 5), and the `visually-hidden` class (Task 14).
- Produces: a header search form (`GET /search/?q=`) on every page, and `/search/`, which mounts the Pagefind UI and runs `q`.

- [ ] **Step 1: Branch**

```bash
git switch -c m5/search
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/site/src/site.test.ts`:

```ts
describe("search", () => {
  it("puts a labelled search box that submits to /search/ on every page", () => {
    for (const page of htmlFiles(site.outDir)) {
      expect(site.read(page)).toContain(
        '<form class="site-search" role="search" action="/search/" method="get">',
      );
    }
  });

  it("mounts the Pagefind UI from the locally built bundle", () => {
    const html = site.read("search/index.html");
    expect(html).toContain('<link rel="stylesheet" href="/pagefind/pagefind-ui.css">');
    expect(html).toContain('<script src="/pagefind/pagefind-ui.js"></script>');
  });

  it("indexes exactly the current articles, with their aliases", () => {
    const entry = JSON.parse(site.read("pagefind/pagefind-entry.json"));
    expect(entry.languages.en.page_count).toBe(3);
    const body = site.read("wiki/signals/index.html").split("data-pagefind-body")[1] ?? "";
    expect(body).toContain("signal pipeline, SIGNALS_TABLE, /api/signals");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/site/src/site.test.ts`
Expected: FAIL. No page has the search form, and `search/index.html` is missing. The page-count test already passes, because Task 10 limited the index to current articles. Keep it as the guard.

- [ ] **Step 4: Implement**

`packages/site/src/pages/search.astro`:

```astro
---
import Layout from "../layouts/Layout.astro";
---
<Layout title="Search">
  <Fragment slot="head">
    <link rel="stylesheet" href="/pagefind/pagefind-ui.css" />
    <meta name="robots" content="noindex" />
  </Fragment>
  <h1 class="page-title">Search</h1>
  <div id="search"></div>
  <noscript><p>Search needs JavaScript. <a href="/special/all-pages/">All articles</a> lists every article.</p></noscript>
  <script is:inline src="/pagefind/pagefind-ui.js"></script>
</Layout>
<script>
  import "../client/search.ts";
</script>
```

`packages/site/src/client/search.ts`:

```ts
/// <reference lib="dom" />
// Mounts the Pagefind UI (written into /pagefind/ at build time) and runs the header query.

interface PagefindUIInstance {
  triggerSearch(term: string): void;
}

declare const PagefindUI: new (options: {
  element: string;
  showSubResults: boolean;
  showImages: boolean;
  resetStyles: boolean;
}) => PagefindUIInstance;

const ui = new PagefindUI({
  element: "#search",
  showSubResults: true,
  showImages: false,
  resetStyles: false,
});
const query = new URLSearchParams(window.location.search).get("q");
if (query !== null && query.trim() !== "") ui.triggerSearch(query);
```

In `packages/site/src/layouts/Layout.astro`:

Replace:
```astro
      <a class="site-name" href="/">{wiki.repo}<span class="site-tagline">wiki</span></a>
    </header>
```
with:
```astro
      <a class="site-name" href="/">{wiki.repo}<span class="site-tagline">wiki</span></a>
      <form class="site-search" role="search" action="/search/" method="get">
        <label class="visually-hidden" for="site-search-q">Search the {wiki.repo} wiki</label>
        <input id="site-search-q" name="q" type="search" placeholder={`Search ${wiki.repo} wiki`} />
        <button type="submit">Search</button>
      </form>
    </header>
```

Append to `packages/site/src/styles/wiki.css`:

```css
/* Search */
.site-search {
  display: flex;
  flex: 1 1 16rem;
  max-width: 28rem;
  gap: 0.25rem;
}

.site-search input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0.35rem 0.5rem;
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 2px;
}

.site-search button {
  padding: 0.35rem 0.75rem;
  font: inherit;
  color: var(--text);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 2px;
  cursor: pointer;
}

#search {
  --pagefind-ui-font: var(--font-sans);
  --pagefind-ui-text: var(--text);
  --pagefind-ui-background: var(--bg);
  --pagefind-ui-border: var(--border);
  --pagefind-ui-primary: var(--link);
  --pagefind-ui-tag: var(--bg-subtle);
}
```

- [ ] **Step 5: Update the snapshots and run the check**

```bash
pnpm vitest run packages/site -u
pnpm check
```

Expected: every snapshot changes only by the header search form. `pnpm check` passes (451 tests in the trial).

- [ ] **Step 6: The M5 exit check: the site is browsable locally**

```bash
pnpm site:demo
```

With the server running, check each of these by hand:
1. `/` shows the welcome banner, the featured article, Did you know... (three items), Recently updated and the feature map.
2. Searching `pipeline` in the header lists Signal ingestion and Deliverables. Both match through their aliases.
3. On `/wiki/signals/`:
   - hovering "deliverable records" shows a preview;
   - `[3]` jumps to reference 3, whose link points at `github.com/acme/demo-repo/blob/bbbb…/src/signals/odd%20name%231.py#L1-L9`;
   - "View history" lists two revisions, and "prev" shows the word diff.
4. `/wiki/legacy-signals/` lands on Signal ingestion with "(Redirected from Legacy signals)". `/wiki/signal-pipeline/` lists both features.
5. Random article opens one of the two active articles.
6. With the window at 390 px wide, the nav wraps under the header and the infobox sits above the lead. In OS dark mode, every page and diagram is dark.

Then build against a real export if one exists. M4 produces the first; until then the demo export is the only input.

```bash
pnpm site:build --export ~/.repowiki/<repo> --repo-url https://github.com/<owner>/<repo>
pnpm site:preview --export ~/.repowiki/<repo>
```

- [ ] **Step 7: Commit and ship**

```bash
git add packages/site
git commit -m "feat(site): add Pagefind search"
```

Ship. PR title: `feat(site): Pagefind search and local browse check`. Paste the Step 6 checklist with each item ticked into the PR body.

---

## Self-review

- **Spec coverage:** each requirement maps to a task.
  - Article, lead, contents and sections: Tasks 9 and 10.
  - Infobox: Tasks 9 and 10.
  - Numbered references with `path:Lstart-end@sha` permalinks (F03): Tasks 8 and 10.
  - See also: Task 9.
  - Redirect, disambiguation and retired pages (F26, F01): Tasks 9 and 11.
  - Alias URLs (F01): Task 11.
  - View history with diffs, dated by `commitDate` (F06, rule 5): Tasks 3 and 12–14.
  - Out-of-date banner (§6.3): Task 9.
  - Hover previews: Task 15.
  - Main Page with featured article, Did you know..., recently updated, feature map and Random article (F12, F10): Tasks 16 and 17.
  - Diagrams (F10): Task 17.
  - `[[wp:]]` links (F13): Task 7. Previews are deferred to M4, as recorded in the spec deltas.
  - Pagefind search: Tasks 5 and 18.
  - Golden snapshots from a fixture export, the schema-failure test and link integrity (§8): Tasks 4, 5 and 10–18.
  - #53's M5 items: Tasks 2 and 3.
  - Browsable locally (§11): Task 18.
- **Placeholders:** none. Every code block is the code that ran in the trial.
- **Type consistency:** each name in **Interfaces** is the name in the code. Later tasks change three things on purpose, and each is listed in its task: `hasArticleRoute` widens in Task 11, `HistoryRow.diffHref` is added in Task 14, and `ArticleView.diagram` is added in Task 17.
- **Review Focus:** each of the five items names the task whose tests pin it.
