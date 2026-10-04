# RepoWiki v1 — Design Spec

- **Date:** 2026-09-30
- **Status:** Draft, pending author review
- **Author:** Sean May

## 1. Brief

RepoWiki generates a Wikipedia-style wiki for a git repository. Pages are scoped
by **feature**, not by folder. Every claim cites the code it describes, and pages
update incrementally as PRs merge. The purpose is to help an engineer learn an
unfamiliar codebase, and to give LLM agents a precomputed, condensed
understanding of a repo so they don't have to re-read the raw code every time.

### Decisions made during brainstorming

| Topic | Decision |
|---|---|
| First user | The author, on his own repos. Runs locally as a CLI. |
| First target repo | `next-chief-of-staff` (≈40k LOC, 600 commits, 160 merge commits; Python / TSX / Terraform). |
| v1 scope | Core engine + minimal reader + freshness (sub-projects #1, #3, #2). |
| Pipeline approach | **A — analysis first, LLM on top** (§4). |
| LLM runtime | Pluggable provider interface; Claude API implementation first. Cheapest model (`claude-haiku-4-5`) for every role in v1. |
| Stack | TypeScript end to end; Astro for the reader. |
| Exit criteria | Q&A eval, author accuracy review, rabbit-hole test (§9). |
| Tracking | GitHub Issues + GitHub Project board; ADRs in `docs/decisions/` (§10). |
| Git authority | Within this repo: commit, push, open PRs, merge once CI is green. |

### Assumptions (confirmed during design review)

- PR replay is used as an **integration test**, not as a scored benchmark.
- Diagrams and outbound Wikipedia links are in v1, because the rabbit-hole test is an exit criterion.
- The v1 voice is Wikipedia NPOV. There are no human edits in v1.
- RepoWiki documents itself starting at milestone M6.

## 2. Sub-projects

| # | Sub-project | Milestone |
|---|---|---|
| 1 | Core engine: features, articles, citations, aliases, links | v1 |
| 2 | Freshness: PR-driven updates, versioned and dated pages | v1 |
| 3 | Reader: wiki UI, diagrams, outbound links, browsing design | v1 (minimal) |
| 4 | Ask sidebar: answers by routing to pages | v2 |
| 5 | Agent interface: MCP server, history queries | v2 (`llms.txt` + JSON export in v1) |
| 6 | People: contributor pages, contribution graphs | v2 |
| 7 | Editorial policy: opinions, human edits, rebuttal loop | v2 |
| 8 | Org scale: many repos, cross-team linking | v3 |
| 9 | Work in flight: issues, open PRs, future changes | v2 |

## 3. Feature register

Every point in the original idea notes is listed here with an interpretation and
a verdict. Each row becomes one GitHub feature issue titled `[Fnn] …`. Rows marked
*derived* came out of design analysis rather than the notes.

| ID | Original point | Interpretation | Verdict |
|---|---|---|---|
| F01 | Alternative names | Redirects: the LLM proposes 3–8 aliases per page, plus aliases taken from code identifiers (routes, table names, env vars). They feed search and redirect URLs (`/wiki/<alias-slug>/`, §4 Reader). | v1 |
| F02 | Hyperlinks to related pages | Links in the body text on first mention of each concept, plus a "See also" list computed from graph neighbours. | v1 |
| F03 | Works cited with code lines | A numbered References section of `path:Lstart-Lend@sha` permalinks. The citations are also the staleness mechanism (§6). | v1 |
| F04 | Pages by feature, not folder | Features come from clustering a combined import/co-change graph, and are kept in a manifest with stable IDs. | v1 (core) |
| F05 | Generated from each PR | `repowiki update` processes new commits. In v1 it is triggered locally; a GitHub Action comes later. | v1 (local) |
| F06 | Versioned, dated pages | Each page revision is stored with its commit date and sha. Pages have a "View history" view with diffs. | v1 |
| F07 | Ways an LLM can use the site | v1 ships `llms.txt` and a JSON export (the eval agent consumes these). The MCP server is part of #5. | v1 (partial) |
| F08 | LLM reads past versions | Queries such as "how did X work on date D", answered from revision history. | v2 (#5) |
| F09 | Ask-me-anything sidebar | Retrieval over the precomputed pages. Answers are a short reply plus page links. | v2 (#4) |
| F10 | Diagrams | Mermaid flowcharts drawn from real import and call edges, with clickable nodes, plus a feature map on the Main Page. | v1 |
| F11 | Pictures | Reshaped: screenshots of rendered UI for frontend features. | later (#3) |
| F12 | Addictive browsing | Hover previews, dense linking, Random article, "Did you know…", a featured article, recently updated pages. | v1 (partial) |
| F13 | Links to real Wikipedia | `[[wp:Title]]` links, checked against the Wikipedia REST API, which also supplies the hover preview. | v1 |
| F14 | People pages, war-chronicle voice | A dated narrative per contributor, linking to the features they worked on. | v2 (#6) |
| F15 | Contribution graphs, whole repo and per person | Activity over time, with zoom. | v2 (#6) |
| F16 | *Derived:* identity merge | Merging author identities (e.g. `seanpatrickmay` = `Sean May`) via a mailmap. | v2 (#6) |
| F17 | As-is vs full history | Resolved by splitting the problem in two: line authorship uses `git blame -C -C -M`; article history comes from replay (§6.2), so full history costs incremental-update tokens rather than one full regeneration per point in time. **M6:** the blame half is deferred to v2 (ADR-0003); no v1 view shows line authorship. | v1 |
| F18 | User edits | No edits in v1. Later, edits become generator guidance that is checked against the code. | v2 (#7), open |
| F19 | Hygiene so it can run on itself | The protocol in §10. | adopted |
| F20 | Opinionated articles, opinion setting | Reshaped: NPOV voice; only evidence-backed *Known limitations*. The opinion setting is deferred. | v1 (NPOV) / v2 (setting) |
| F21 | Voice learned from Wikipedia | A style guide distilled from Wikipedia's Manual of Style (§7.1). | v1 |
| F22 | Wikis for every repo in a company | A multi-repo index and links across repos. | v3 (#8) |
| F23 | Future changes, issues, PRs | "In progress" pages built from open issues and PRs. | v2 (#9) |
| F24 | Opinion → coding agent fixes it or rebuts | v1 caps extremity by allowing only evidence-backed limitations. The rebuttal channel is #7. | v2 (#7) |
| F25 | *Derived:* token savings | The core value proposition. Measured with per-call token logging and the Q&A eval (§9). | v1 (measured) |
| F26 | *Derived:* stable page identity | Feature IDs survive regeneration through redirect and disambiguation states (§5). | v1 |

## 4. Architecture

pnpm workspace with six packages. Engine stages are modules rather than separate
packages; their boundaries are enforced by import rules and tests.

```
packages/
  core/       zod schemas + types: Manifest, Feature, Revision, Section, Claim, Citation
  llm/        Provider interface, claude/ implementation, TokenLedger
  engine/
    index/      tree-sitter symbols, import graph, git co-change -> RepoIndex@sha
    cluster/    weighted graph -> candidate clusters (deterministic Louvain in plain TS)
    manifest/   LLM names/merges/splits clusters; updates the prior manifest, never rebuilds it
    write/      context pack -> sections of claims with citations
    verify/     resolves every citation at its sha; enforces citation rules
    link/       aliases, link resolution, See also, Wikipedia URL checks
    freshness/  diff(shaA, shaB) -> stale claims + coverage gaps -> RegenerationPlan
    store/      SQLite (better-sqlite3): manifests, revisions, indexed citation ranges, head sha
  site/       Astro reader; reads the JSON export only
  cli/        repowiki build | update | replay | export | serve
  eval/       Q&A harness
```

- **Data location:** outside the target repo. The default is `~/.repowiki/<repo-name>/`, overridable with `--out`. RepoWiki never writes to the repo it documents.
- **Provider interface:** `generate({ system, messages, schema, cacheKey?, batch? }) -> { output, usage }`. Every call is recorded in the `TokenLedger` (input, output, cache-read, and cache-write tokens, model, purpose, featureId). Model IDs come from config, set per role (`manifest`, `write`, `tieBreak`, `evalAgent`, `evalJudge`). Every role defaults to the cheapest current model, `claude-haiku-4-5` ($1 / $5 per MTok, 200K context). Upgrading a role is a config change, not a code change. Because Haiku 4.5 has a 200K context window, every prompt (including the manifest call) must fit under 200K tokens; the manifest call receives cluster summaries, not source code.
  - **Request fields (M3).** A request also carries `purpose` (the role: it selects the model and labels the ledger entry), an optional `featureId`, and `maxTokens`.
  - **`cacheKey`.** It names a reusable prefix. The system prompt gets the `cache_control` breakpoint, and one key must always carry the same system text and model; a mismatch throws before any request is sent. Haiku 4.5 caches only prefixes of at least 4096 tokens, so shorter prompts are simply not cached.
  - **`batch: true`.** Requests made in the same tick go out together as one Message Batch (50% off, stacking with caching). Each caller's promise settles with its own item, and an errored, expired or missing item rejects only that caller.
  - **Output.** Output is structured JSON through `output_config.format`, generated from the request's zod schema, and is validated again on receipt. No `thinking` parameter is sent.
  - **Retries.** The SDK retries failed requests itself (`maxRetries: 2`, so 3 attempts in all, per §6.3).
  - **Batch robustness (M4).** A batch item that errored (other than a permanent error such as an invalid request), expired or went missing is sent again in the next batch, up to three batches in all. A batch can have a deadline, past which it is canceled, and result downloads are retried. A journal in the store (migration 5) maps each request's key to its batch, so a rerun collects a batch it already submitted instead of paying for it again.
  - **Ledger.** Each ledger entry records `runId`, `at`, `purpose`, `model`, `featureId`, `batch`, `cacheKey` and the four token counts, and is persisted in the store's `ledger` table. From M4, rows also carry `runKind` (`build` | `update`) and the run's `sha` (§6.4). Cost is computed from the entries, never stored: each token count times the model's price for that class, halved for batch entries. For Haiku 4.5 the prices per MTok are $1 input, $5 output, $1.25 cache write (5-minute TTL) and $0.10 cache read.
- **Clustering (M3).** The file graph has these edges:
  - import edges of weight 1, scaled by `min(1, 4 / in-degree)` so barrels and shared fixtures don't glue the repo together;
  - co-change edges of weight 2 × Jaccard, for pairs that changed together at least twice;
  - a weak directory edge, 0.3 shared among each directory's siblings.

  Non-code files join only through co-change and directory. Louvain runs at resolution 3 with no randomness: nodes are visited in sorted path order, and a tie keeps the current community, then prefers the lowest id. Clusters under 5 files are absorbed into the cluster they share the most edge weight with. Cluster ids (`c01`, …) number the clusters largest first, with ties broken by first path.
- **Manifest build (M3).** One call (batched by default) receives a digest of every cluster's summary: the top files, exported symbols, directories, external packages and neighbouring clusters. The digest shrinks its listings until the estimate fits the 150K-token budget.
  - **Answer.** The call returns the features (slug, title, 3–8 aliases) and exactly one `{ cluster, feature, role: core | supporting }` assignment per cluster.
  - **Retry.** An answer that breaks a rule is retried once, with the reasons quoted and the cached prefix reused. Features left with no clusters are dropped rather than retried.
  - **Scope.** M3 builds only a repo's first manifest. Moving a stored manifest to a new sha is `update` (§6.1, M6), never a rebuild.
- **Languages in v1:** symbol-level indexing for Python, TypeScript, and TSX. Every other tracked file (including Terraform) is indexed at file level and joins features through co-change only.
- **What the index reads:** git objects at the requested sha only (`ls-tree`, `cat-file`, `log`), never the working tree, so uncommitted changes in the target repo have no effect on the index.
- **Symbols:** functions, classes, qualified methods, interfaces, type aliases, enums, and public module-level bindings (exported TS `const`s; Python top-level assignments to non-underscore names). Function bodies are not descended into. Repeated definitions of one name in a file (such as a property getter and setter) merge into one span. `.js`/`.jsx` files are indexed at file level.
- **Edges:** M2 extracts import edges. M4 adds `RepoIndex.calls`, call edges between indexed symbols, used by diagrams (§7.3). They are resolved by name only: an imported name, an attribute of an imported module binding, the file's own top-level symbol, `self.m()` inside its class, and capitalized JSX elements in TSX. Calls on any other object are not resolved.
- **Co-change:** counted over non-merge commits. A rename counts as a delete plus an add. Commits touching more than 50 files (configurable) are skipped as sweeps and counted.

### Data flow

- `build <sha>`: index → cluster → manifest → write → verify → link → store revision → export. A store already built at another sha is refused (that is an `update`); one built at the same sha is resumed, writing only the pages it lacks (M4).
- `update <shaB>`: runs the freshness algorithm (§6) from the last processed sha to `shaB`.
- `replay <fromSha> <toSha>`: runs `update` once for each merge commit along `main`'s first-parent history.
- `export`: writes the JSON for the current revisions plus `llms.txt`.
- `serve`: builds and serves the Astro site from the export.

### Reader (M5)

- **Commands:** `pnpm site:build --export <file|dir> [--out <dir>] [--repo-url <url>]` validates the export with `WikiExport` (a bad export fails the build, naming the file and field), runs `astro build`, then indexes the output with Pagefind. The default `--out` is `site/` next to the export. `pnpm site:preview` serves the result on `127.0.0.1:4321`, and `pnpm site:demo` does both for a fixture export. The `cli` package's `serve` wraps these.
- **Static and offline:** the output is plain files. Mermaid and the Pagefind UI ship with the site, Astro telemetry is off, and no page loads anything from another host.
- **Pages:** `/` (Main Page), `/wiki/<id>/` (an article, a redirect or a disambiguation), `/wiki/<id>/history/`, `/wiki/<id>/history/<n>/` (an old revision; `n` is its 1-based position, oldest first), `/wiki/<id>/diff/<n>/` (revision `n` against `n - 1`), `/wiki/<alias-slug>/`, `/random/`, `/special/all-pages/`, `/search/`, and `/api/preview/<id>.json` (hover-preview data).
- **Code citations** link to `<repo-url>/blob/<sha>/<path>#L<start>-L<end>` (GitHub-style, with each path segment percent-encoded) when `--repo-url` is given; otherwise they are plain text. The export carries no source, so there is no embedded code view.
- **Dates** shown to readers are the calendar date written in `commitDate` (rule 5), never converted to the build machine's time zone.

## 5. Data model

```ts
Feature   { id: string /* permanent slug, at most 64 chars */, title, aliases: string[],
            status: { kind: "active" }
                  | { kind: "redirect", to: string }
                  | { kind: "disambiguation", to: string[] }
                  | { kind: "retired" },
            lineage: LineageEvent[] /* rename | merge | split | create | retire, with sha */ }

Manifest  { sha, features: Feature[], membership: Record<SymbolOrFileId, { featureId, weight }> }

Revision  { id, featureId, sha, commitDate, generatedAt, parentId: string | null,
            reason: "build" | "update" | "manifest-change", pr: number | null,
            model, tokens: { in, out, cacheRead, cacheWrite },
            infobox: Infobox, diagram: string | null /* Mermaid */,
            seeAlso: FeatureId[], sections: Section[] }

Infobox   { files: number, loc: number, languages: string[], entryPoints: string[],
            firstCommitDate, lastCommitDate }

Section   { key: "lead" | "overview" | "how-it-works" | "data-flow" | "history"
               | "known-limitations",
            claims: Claim[] }
            // "See also" renders from Revision.seeAlso; "References" renders from claim citations.

Claim     { id, text /* markdown with link tokens */, kind: "fact" | "limitation" | "history",
            citations: Citation[], supports: ClaimId[], staleSince: string | null,
            hook: boolean /* candidate for "Did you know…" */ }

Citation  = { kind: "code", path, startLine, endLine, sha, symbol: string | null, contentHash }
          | { kind: "commit", sha, subject, pr: number | null }

WikiExport { schemaVersion: 2, repo, head, exportedAt, manifest: Manifest,
             pages: Revision[] /* current revision per feature */,
             history: Record<FeatureId, Revision[]> /* every revision, oldest first */ }
```

### Rules

1. **Feature IDs are permanent.** A rename keeps the ID and appends the old title to `aliases`. A merge turns the absorbed ID into a `redirect`. A split turns the original ID into a `disambiguation` page. A retired feature stays readable in history. No feature URL ever stops resolving.
   - **Lineage and status agree both ways (M3).** `create` is the first event and appears once. Every `rename`'s old title is in `aliases`.
   - **Ending events.** At most one of `merge`, `split` and `retire` appears, and the status says the same thing:
     - `merge` into X ⇔ `redirect` to X;
     - `split` into S ⇔ `disambiguation` over exactly S;
     - `retire` ⇔ `retired`;
     - none of them ⇔ `active`.
   - **Migration.** Store migration 2 repairs bodies stored under the older one-way rule.
2. **Every non-lead claim needs at least one citation.** Lead claims have no citations of their own; they list the body claims they summarize in `supports`, and they go stale when any supported claim goes stale.
3. **`limitation` claims** must cite evidence: a `TODO`/`FIXME` comment, a skipped test, or a reverting commit.
   - **Evidence, precisely (M4).** A cited code range containing a `TODO` or `FIXME` line, or a skipped, xfail or to-do test; or a commit citation whose subject starts with "revert". A code citation spans at most 120 lines.
4. **`history` claims** must cite at least one `commit` citation. The History section is append-only.
5. **`commitDate` is the date shown to readers.** `generatedAt` and `tokens` are kept as cost evidence (F25).
6. **`contentHash`** is the SHA-256 of the cited lines with line endings normalized. It is the only test of whether cited code changed.
7. **Member ids** (`SymbolOrFileId`) are `path` or `path#symbol`, produced only by `memberId()` in `@repowiki/core`. The path part percent-encodes `%` as `%25` and `#` as `%23`, so the first `#` always separates the path from the symbol, while the symbol itself may contain `#` (for TS private members).
8. **Membership covers every file and every symbol (M3).** In v1 a symbol inherits its file's feature. A member's weight is its cluster's role (`core` 1, `supporting` 0.5) × its centrality, which is the share of the file's edge weight that stays inside its feature (at least 0.05), rounded to 3 decimals.
9. **Feature ids are URL path segments.** They are lowercase kebab-case slugs of at most 64 characters (`FEATURE_ID_MAX_LENGTH`). M3's manifest step caps ids at 40 characters (`proposal.ts`), so no stored body exceeds the 64-character schema cap and no migration is needed.
10. **The export carries full history.** `history[id]` holds every stored revision body, oldest first. Its last entry is the page, and each entry's `parentId` is the previous entry's id. The reader computes diffs from these bodies.
11. **Claim text** is a small markdown subset: `**bold**`, `*italic*`, `` `code` `` and the link tokens `[[id]]`, `[[id|label]]`, `[[wp:Title]]` and `[[wp:Title|label]]`. Anything else is shown literally, HTML-escaped.
   - **Claim text (M4).** A claim's text is one paragraph of the reader's markdown subset (emphasis, inline code, `[[target]]` and `[[wp:Title]]` tokens), at most 1,000 characters as the write step produces it. Core caps stored claim text at `CLAIM_TEXT_MAX_LENGTH = 2000`; no migration is needed, since no claim was stored before M4.

## 6. Freshness

### 6.1 `update shaA → shaB`

1. **Diff and incremental index.** Run `git diff -M shaA shaB`, re-parse only the changed files, and add the new commits to the co-change matrix. No LLM calls.
   - **Index (M6).** The whole tree is re-indexed at `shaB` (about a second on next-chief-of-staff); "incremental" means only the changed files' citations and membership are re-examined.
2. **Remap citations.** For each code citation in a touched file, translate its line range through the diff hunks and follow renames. Recompute `contentHash` at `shaB`. If it matches, update the line numbers and the sha; the claim stays fresh. If it doesn't match, or the range was deleted, mark the claim stale. No LLM calls.
3. **Find coverage gaps.** New symbols that no claim cites get assigned to a feature using import neighbours, co-change, and directory. The LLM (the tie-break model) is called only when those signals disagree. Each gap is recorded against its feature. A new file has no cluster at update time, so its role in its weight is inferred until the next manifest revision: supporting (0.5) for test files and files with no language, core (1) otherwise; its centrality is computed as in §5 rule 8.
4. **Check manifest drift.** Track cumulative membership churn per feature (weight added + weight removed, divided by the weight at the last manifest revision). The last manifest revision is the drift baseline. It is persisted: the store marks every manifest an LLM produced or revised (`putManifest(m, { llmRevised: true })`), and `getDriftBaseline()` returns the latest one, so manifests that only gained members never reset the baseline. If no feature exceeds `driftThreshold` (default 0.20, configurable), the manifest changes only by adding new members. If one does, a single constrained LLM call returns operations (`rename | merge | split | create | retire`) applied to the existing manifest, and the affected pages get `reason: "manifest-change"`.
   - **Drift (M6).** Churn is the weight moved (added, removed or changed) since the baseline over the baseline's weight; a feature with no baseline weight has infinite churn once it gains any. A store with no manifest marked LLM-revised (every store built before M3) gets its earliest manifest marked by migration 8, so a built wiki always has a baseline. The operations (`rename`, `move`, `create`, `merge`, `split`, `retire`) are made over the clusters at `shaB`; ids are permanent, a cluster is used once, `retire` needs no file left, and no active feature may end up empty. An empty list is a revision (the baseline moves); two refused answers leave the manifest unrevised, and the next update asks again. Features the operations changed, and active features with no page, are written whole.
5. **Rewrite dirty sections.** A section is dirty if it contains a stale claim. Coverage gaps make the feature's `how-it-works` section dirty. Membership changes cause the diagram to be rebuilt, and new commits are appended to `history`. The LLM receives the old section with stale claims marked, plus the new code context, and is told to reproduce unchanged claims word for word. The lead is rewritten only if a claim it `supports` changed.
   - **Dirty pages (M6).** A page is dirty when a claim went stale, a coverage gap is found for its feature, or one of its member files changed. The model returns only rewrites of the stale claims and new claims for the sections the pack opens (`how-it-works` for gaps, `history` for new commits); the engine keeps every other claim word for word. A new history claim must cite a commit of this update. A claim already stale from an earlier update is tried again only when a file it cites changed. The update prefix is cached only when two or more pages of one update share it in unbatched calls (`--no-batch`); a batch runs its requests concurrently, so most of them would write the prefix rather than read it.
6. **Verify, link, store.** Only pages with changes get a new revision; all other pages carry forward unchanged. Links to merged IDs resolve through redirects.
   - **Stored links (M6).** A carried page's links are judged against the manifest at its own sha, and must still lead to a page today (a redirect counts).
   - **The About article (M6).** Rewritten after the pages are stored, in its own round, only when the features with a page differ from its basis's, a basis page's lead text changed, or a claim names a feature that is no longer active; otherwise carried forward. A changed line it cites does not make it due: its citations stay valid at its own sha.

### 6.2 Replay

`replay` calls `update(prev, merge)` for each first-parent merge commit on `main`.
The PR number is parsed from `Merge pull request #N` and stored on the revision.
Building at an old commit and replaying forward produces the full dated history (F06, F17).

**Replay (M6).** Replay walks the first-parent line of `<to>` (which need not be `main`): every merge after `<from>`, then `<to>` itself when it is not a merge. It resumes from the store's head, collecting any batch a killed run left through the batch journal; `--limit N` bounds one run. PR numbers come from "Merge pull request #N" or a squash's trailing "(#N)". After each step it records the §8 invariants in a summary file.

### 6.3 Failure handling

- If a rewritten claim fails verification, retry once with the verifier's error included in the prompt.
- If the second attempt also fails, keep the previous claim, set `staleSince: shaB`, and have the reader show the banner *"This section may be out of date."* Claims are never dropped silently during an update.
- During the initial `build`, a claim that fails verification twice is dropped, and the drop is logged.
  - **Build rounds (M4).** The first round is one batch and the retry round another. A page whose first answer is unusable (not JSON, wrong shape, no lead or no body) is asked for again whole; claims that failed verification go back once with their problems. A page left without a lead or a body claim is not stored, the build reports it, and a rerun at the same sha writes it again.
- If a provider call fails (network, rate limit), retry with exponential backoff, at most 3 attempts. After that, the update aborts without writing a partial revision. Updates are transactional per run.
  - **Update rounds (M6).** Every round is batched by default. A whole batch that fails aborts the update like a failed call; the batch journal keeps the paid answers for the next run. An unusable tie-break answer falls back deterministically (most shared edge weight, then the smallest id). An answer cut off at `max_tokens` is asked for again, shorter, with the same cap.

### 6.4 Cost accounting

Every `update` records its total tokens alongside the token cost of the most
recent full `build` of the same repo. Both figures appear in the export.
From M4, ledger rows carry `runKind` and `sha`, so both totals are sums over
`(runKind, sha)`; `manifest:build` rows count toward the full build. From M6 the export carries
them as `WikiExport.runs` (calls and tokens per run).

## 7. Generation quality

### 7.1 Style guide (F21, F20)

`packages/engine/write/style-guide.md` is checked in and is the shared,
prompt-cached prefix for every write call.

- The first sentence defines the subject, with the title in bold: "**Signal ingestion** is the subsystem of next-chief-of-staff that…".
- The lead is 2–4 sentences, stands on its own, and serves as the hover preview.
- NPOV, verifiability, no original research. Intent ("why") is stated only when a commit message says so, and that commit is cited.
- Present tense. No "we" or "you". Banned words: "simply", "just", "robust", "powerful", "clearly", "obviously", "seamless".

### 7.2 Context packs (F25)

- Each feature page gets a budget (`contextBudgetTokens`, default 30,000).
- Members are sorted by membership weight. Full source is included for members until 70% of the budget is used. The rest get signatures and docstrings only.
- The pack also includes the manifest's titles and aliases (the set of valid link targets) and the subjects of the feature's commits.
- The style guide plus the manifest form the cached prefix for every page in a run. The initial `build` goes through the Batch API.
- **Prompt layout (M4).** The shared, cached system prefix is the write instructions, the style guide and a feature directory (each active feature's id, title, aliases and top files, plus redirects). The pack goes in the user turn. The model answers sections of claims whose citations are `path:start-end` or `commit:<sha prefix>` references; the engine resolves them to `Citation`s and hashes the cited lines.

### 7.3 Computed rather than generated

- **Infobox:** computed from the index and git.
- **Aliases (F01):** LLM synonyms plus code identifiers (HTTP routes, table names, env vars, CLI commands) belonging to the feature's members. Each alias slug (ASCII kebab-case, at most 64 chars) gets a page that redirects to its feature, or a disambiguation page when two features share it. A feature id always wins over an alias slug. Aliases appear in the infobox, which is how search finds them.
  - **M4.** An identifier found in exactly one feature's files is appended to that feature's aliases in the stored manifest at the build's sha, at most 10 per feature, never colliding with another feature's id, title or alias. Ids, membership and the drift baseline are untouched.
- **Links (F02):** the LLM may emit `[[featureId]]` or `[[featureId|label]]` only for manifest IDs and aliases. Unknown targets become plain text. Each concept is linked on first mention only. "See also" lists the top 5 graph neighbours by combined edge weight.
  - **M4.** Every stored `[[target]]` is a feature id: aliases and titles are canonicalized to the id and redirects are followed. Retired, unknown and self targets become plain text, and no link or See also entry may name an id without a page.
- **Wikipedia links (F13):** `[[wp:Title]]`, checked with `GET https://en.wikipedia.org/api/rest_v1/page/summary/{title}`. A 404 makes the link plain text. Summaries are cached in the store and used as hover previews. The reader shows those previews once M4 adds the summary cache to the export; until then `[[wp:Title]]` renders as an outbound link.
  - **M4.** The cache is store migration 6 and records misses too. A disambiguation page also makes plain text, and so does an unreachable API (uncached, so the next build checks again). `WikiExport.wikipedia` carries the summaries of linked articles keyed by canonical title, and `SCHEMA_VERSION` becomes 3.
- **Diagrams (F10):** a Mermaid flowchart per page, built from import and call edges among members and to neighbouring features. The LLM chooses at most 12 nodes and labels the edges. Every node must exist in the index, and every node links to its page or its source. The reader draws diagrams in the browser with the bundled Mermaid (`securityLevel: "strict"`), redrawing them when the color scheme changes. A diagram sits at the top of Data flow, or after the lead when the page has no Data flow section.
  - **M4.** The engine draws the diagram from candidates the index proves (member files, and the neighbouring features they import from or call into); the model only picks up to 12 nodes and labels candidate edges. Labels are escaped as the site's `mermaidLabel()` escapes them. Nodes are not clickable: the engine writes no click line. Verify accepts only the four line shapes the engine writes (`flowchart LR`, a box node, a subroutine node, a labelled arrow between declared nodes) with labels in `mermaidLabel()`'s entity-encoded alphabet, so `click`, `href`, `call`, `%%{` directives, `@{` shapes, `<`, `img:` and any URL scheme are refused. This replaces "every node links to its page or its source".
- **Main Page (F12):** the feature map, a featured article (rotated per export), "Did you know…" (claims with `hook: true`), recently updated pages, and Random article. The rotation is seeded by the head sha, so one export always renders the same page. Did you know… shows up to 5 hooks from active articles as "... that <claim>?". Recently updated lists 5 pages by commit date. The feature map draws one node per active article and one edge per See also pair. Random article picks in the browser.

## 8. Testing

- **Unit tests (Vitest)** for every engine module.
- **Property tests** for citation remapping: random edits above, below, overlapping, and inside cited ranges, plus renames, each checked against the expected fresh/stale outcome. **M6:** a seeded generator in the test file instead of `fast-check`, so no dependency is added.
- **A fixture repo builder** creates small git repos with scripted histories inside tests. `index`, `freshness`, and `replay` are tested against them in CI.
- **LLM record/replay cassettes.** CI never calls a live API. Live calls happen only in `eval` and in manual runs.
  - **What a cassette is.** Record/replay works at the SDK's `fetch` layer. A cassette is committed JSON in a `__cassettes__/` directory beside its test, holding each exchange's request method, path and body and its response status, content type and body. It holds no headers, so no key can leak, and Biome skips these files.
  - **Matching.** Replay matches requests by method, path and canonical body. A request with no matching recording throws `CassetteMissError` and never reaches the network.
  - **Re-recording.** `pnpm cassettes:record <test files>` re-records live with the key from `.env`.
- **Golden snapshots** of HTML rendered from a fixture export (the site reads only the export), plus a crawl that fails on any same-site link to a missing page or anchor.
- **Schema validation:** every export is validated with the `core` zod schemas, and the site imports the same types.
- **Replay invariants** on next-chief-of-staff (run manually, results recorded in the M6 PR):
  - every code citation resolves at its sha with a matching hash;
  - there are no links to nonexistent IDs;
  - every update costs fewer tokens than the last full build.

## 9. Exit criteria

1. **Q&A eval.**
   - The author writes 30 questions with reference answers about next-chief-of-staff **before seeing any generated page**. They cover four kinds: where, how, why, and what changed when.
   - The questions are split into 20 dev and 10 held out. The held-out 10 are run once, at v1 sign-off.
   - Two agents use the same model and the same turn limit. The wiki agent has `search(query)` and `read_page(id)`. The repo agent has `list_files`, `read_file`, and `grep`.
   - An LLM judge scores each answer 0/1 against its reference answer, and the author spot-checks 10 of the judgments.
   - **Pass:** on the held-out set, wiki accuracy is at least 90% of repo accuracy, and wiki tokens are at most 40% of repo tokens.
   - The report also states the break-even point: build tokens ÷ (repo tokens per question − wiki tokens per question).
2. **Accuracy review.** The author reviews the pages for features he built. Each false claim is filed as an issue labelled `accuracy`. **Pass:** at most 1 false claim per 50 claims reviewed.
3. **Rabbit-hole test.** Three sessions, each starting from a Random article, each going at least 5 hops. Notes are recorded in an issue. **Pass:** the author judges that each hop taught something real.

## 10. Process

### 10.1 Tracking

- GitHub Issues on `seanpatrickmay/repowiki` (private) are the source of truth.
- One feature issue per F-row (`[F03] Works cited…`). Implementation tickets are sub-issues, each sized to fit one PR.
- Labels: `v1` `v2` `v3`; `area:engine` `area:site` `area:freshness` `area:eval` `area:infra`; `type:feature` `type:task` `type:bug` `type:decision`; `accuracy`.
- A GitHub Project board with the columns Backlog → Ready → In progress → In review → Done.
- When a feature is reshaped, deferred, or rejected, an ADR is written in `docs/decisions/NNNN-title.md`. ADR-0001 records approach A.
- Traceability: F-ID → issue → PR (`Closes #n`) → commits.

### 10.2 Hygiene

- `main` is always green. Branches are short-lived and named `fNN/short-description` or `mN/short-description`.
- Each PR closes exactly one ticket and stays under about 300 changed lines, not counting lockfiles, fixtures, and cassettes.
- Commits follow Conventional Commits with a scope (`feat(engine): …`). There is a commit at every green TDD step, and every commit typechecks and passes tests.
- Commits never carry `Co-Authored-By` or AI attribution. The author email is `sean.may101@gmail.com`. `--no-verify` is never used.
- CI runs on every PR: typecheck (`tsc --noEmit`, strict), Biome lint + format check, and Vitest. All checks are required to merge.
- No custom blocking hooks. The protocol is a strict convention, written in the repo's `CLAUDE.md`.

## 11. Milestones

| M | Contents | Done when |
|---|---|---|
| M0 | Repo setup: GitHub repo, pnpm workspace, strict TS, Biome, Vitest, CI, PR/issue templates, labels, board, F01–F26 issues, ADR-0001, `CLAUDE.md` | CI is green on an empty package; the board is populated |
| M1 | `core` schemas, `store` (SQLite + JSON export) | Round-trip tests pass |
| M2 | `index`: tree-sitter (Python/TS/TSX), import graph, co-change | Indexes next-chief-of-staff at a given sha |
| M3 | `llm` provider + ledger, `cluster`, `manifest` | Produces a reviewed manifest for next-chief-of-staff |
| M4 | `write`, `verify`, `link` | First full build of next-chief-of-staff |
| M5 | `site`: article, infobox, references, history, hover previews, Main Page, Pagefind search | The site is browsable locally |
| M6 | `freshness`, `replay` | Replay invariants hold; RepoWiki builds its own wiki |
| M7 | `eval` harness | Exit-criteria run is recorded |

## 12. Out of scope for v1

Sub-projects #4–#9; human edits; an opinion setting; screenshots; symbol-level
indexing for languages other than Python, TS, and TSX; hosted deployment; any
write access to target repos.
