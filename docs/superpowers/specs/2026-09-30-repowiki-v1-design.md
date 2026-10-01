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
| F01 | Alternative names | Redirects: the LLM proposes 3–8 aliases per page, plus aliases taken from code identifiers (routes, table names, env vars). They feed search and redirect URLs. | v1 |
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
| F17 | As-is vs full history | Resolved by splitting the problem in two: line authorship uses `git blame -C -C -M`; article history comes from replay (§6.2), so full history costs incremental-update tokens rather than one full regeneration per point in time. | v1 |
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
    cluster/    weighted graph -> candidate clusters (Louvain via graphology, fixed seed)
    manifest/   LLM names/merges/splits clusters; updates the prior manifest, never rebuilds it
    write/      context pack -> sections of claims with citations
    verify/     resolves every citation at its sha; enforces citation rules
    link/       aliases, link resolution, See also, Wikipedia URL checks
    freshness/  diff(shaA, shaB) -> stale claims + coverage gaps -> RegenerationPlan
    store/      SQLite (better-sqlite3): revisions, claims, indexed citation ranges
  site/       Astro reader; reads the JSON export only
  cli/        repowiki build | update | replay | export | serve
  eval/       Q&A harness
```

- **Data location:** outside the target repo. The default is `~/.repowiki/<repo-name>/`, overridable with `--out`. RepoWiki never writes to the repo it documents.
- **Provider interface:** `generate({ system, messages, schema, cacheKey?, batch? }) -> { output, usage }`. Every call is recorded in the `TokenLedger` (input, output, cache-read, and cache-write tokens, model, purpose, featureId). Model IDs come from config, set per role (`manifest`, `write`, `tieBreak`, `evalAgent`, `evalJudge`). Every role defaults to the cheapest current model, `claude-haiku-4-5` ($1 / $5 per MTok, 200K context). Upgrading a role is a config change, not a code change. Because Haiku 4.5 has a 200K context window, every prompt (including the manifest call) must fit under 200K tokens; the manifest call receives cluster summaries, not source code.
- **Languages in v1:** symbol-level indexing for Python, TypeScript, and TSX. Every other tracked file (including Terraform) is indexed at file level and joins features through co-change only.

### Data flow

- `build <sha>`: index → cluster → manifest → write → verify → link → store revision → export.
- `update <shaB>`: runs the freshness algorithm (§6) from the last processed sha to `shaB`.
- `replay <fromSha> <toSha>`: runs `update` once for each merge commit along `main`'s first-parent history.
- `export`: writes the JSON for the current revisions plus `llms.txt`.
- `serve`: builds and serves the Astro site from the export.

## 5. Data model

```ts
Feature   { id: string /* permanent slug */, title, aliases: string[],
            status: { kind: "active" }
                  | { kind: "redirect", to: string }
                  | { kind: "disambiguation", to: string[] }
                  | { kind: "retired" },
            lineage: LineageEvent[] /* rename | merge | split | create | retire, with sha */ }

Manifest  { sha, features: Feature[], membership: Record<SymbolOrFileId, { featureId, weight }> }

Revision  { id, featureId, sha, commitDate, generatedAt, parentId: string | null,
            reason: "build" | "update" | "manifest-change", pr: number | null,
            model, tokens: { in, out, cacheRead, cacheWrite },
            infobox: Infobox, sections: Section[] }

Infobox   { files: number, loc: number, languages: string[], entryPoints: string[],
            firstCommitDate, lastCommitDate }

Section   { key: "lead" | "overview" | "how-it-works" | "data-flow" | "history"
               | "known-limitations" | "see-also" | "references",
            claims: Claim[] }

Claim     { id, text /* markdown with link tokens */, kind: "fact" | "limitation" | "history",
            citations: Citation[], supports: ClaimId[], staleSince: string | null,
            hook: boolean /* candidate for "Did you know…" */ }

Citation  = { kind: "code", path, startLine, endLine, sha, symbol: string | null, contentHash }
          | { kind: "commit", sha, subject, pr: number | null }
```

### Rules

1. **Feature IDs are permanent.** A rename keeps the ID and appends the old title to `aliases`. A merge turns the absorbed ID into a `redirect`. A split turns the original ID into a `disambiguation` page. A retired feature stays readable in history. No feature URL ever stops resolving.
2. **Every non-lead claim needs at least one citation.** Lead claims have no citations of their own; they list the body claims they summarize in `supports`, and they go stale when any supported claim goes stale.
3. **`limitation` claims** must cite evidence: a `TODO`/`FIXME` comment, a skipped test, or a reverting commit.
4. **`history` claims** must cite at least one `commit` citation. The History section is append-only.
5. **`commitDate` is the date shown to readers.** `generatedAt` and `tokens` are kept as cost evidence (F25).
6. **`contentHash`** is the SHA-256 of the cited lines with line endings normalized. It is the only test of whether cited code changed.

## 6. Freshness

### 6.1 `update shaA → shaB`

1. **Diff and incremental index.** Run `git diff -M shaA shaB`, re-parse only the changed files, and add the new commits to the co-change matrix. No LLM calls.
2. **Remap citations.** For each code citation in a touched file, translate its line range through the diff hunks and follow renames. Recompute `contentHash` at `shaB`. If it matches, update the line numbers and the sha; the claim stays fresh. If it doesn't match, or the range was deleted, mark the claim stale. No LLM calls.
3. **Find coverage gaps.** New symbols that no claim cites get assigned to a feature using import neighbours, co-change, and directory. The LLM (the tie-break model) is called only when those signals disagree. Each gap is recorded against its feature.
4. **Check manifest drift.** Track cumulative membership churn per feature (weight added + weight removed, divided by the weight at the last manifest revision). If no feature exceeds `driftThreshold` (default 0.20, configurable), the manifest changes only by adding new members. If one does, a single constrained LLM call returns operations (`rename | merge | split | create | retire`) applied to the existing manifest, and the affected pages get `reason: "manifest-change"`.
5. **Rewrite dirty sections.** A section is dirty if it contains a stale claim. Coverage gaps make the feature's `how-it-works` section dirty. Membership changes cause the diagram to be rebuilt, and new commits are appended to `history`. The LLM receives the old section with stale claims marked, plus the new code context, and is told to reproduce unchanged claims word for word. The lead is rewritten only if a claim it `supports` changed.
6. **Verify, link, store.** Only pages with changes get a new revision; all other pages carry forward unchanged. Links to merged IDs resolve through redirects.

### 6.2 Replay

`replay` calls `update(prev, merge)` for each first-parent merge commit on `main`.
The PR number is parsed from `Merge pull request #N` and stored on the revision.
Building at an old commit and replaying forward produces the full dated history (F06, F17).

### 6.3 Failure handling

- If a rewritten claim fails verification, retry once with the verifier's error included in the prompt.
- If the second attempt also fails, keep the previous claim, set `staleSince: shaB`, and have the reader show the banner *"This section may be out of date."* Claims are never dropped silently during an update.
- During the initial `build`, a claim that fails verification twice is dropped, and the drop is logged.
- If a provider call fails (network, rate limit), retry with exponential backoff, at most 3 attempts. After that, the update aborts without writing a partial revision. Updates are transactional per run.

### 6.4 Cost accounting

Every `update` records its total tokens alongside the token cost of the most
recent full `build` of the same repo. Both figures appear in the export.

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

### 7.3 Computed rather than generated

- **Infobox:** computed from the index and git.
- **Aliases (F01):** LLM synonyms plus code identifiers (HTTP routes, table names, env vars, CLI commands) belonging to the feature's members.
- **Links (F02):** the LLM may emit `[[featureId]]` or `[[featureId|label]]` only for manifest IDs and aliases. Unknown targets become plain text. Each concept is linked on first mention only. "See also" lists the top 5 graph neighbours by combined edge weight.
- **Wikipedia links (F13):** `[[wp:Title]]`, checked with `GET https://en.wikipedia.org/api/rest_v1/page/summary/{title}`. A 404 makes the link plain text. Summaries are cached in the store and used as hover previews.
- **Diagrams (F10):** a Mermaid flowchart per page, built from import and call edges among members and to neighbouring features. The LLM chooses at most 12 nodes and labels the edges. Every node must exist in the index, and every node links to its page or its source.
- **Main Page (F12):** the feature map, a featured article (rotated per export), "Did you know…" (claims with `hook: true`), recently updated pages, and Random article.

## 8. Testing

- **Unit tests (Vitest)** for every engine module.
- **Property tests (`fast-check`)** for citation remapping: random edits above, below, overlapping, and inside cited ranges, plus renames, each checked against the expected fresh/stale outcome.
- **A fixture repo builder** creates small git repos with scripted histories inside tests. `index`, `freshness`, and `replay` are tested against them in CI.
- **LLM record/replay cassettes.** CI never calls a live API. Live calls happen only in `eval` and in manual runs.
- **Golden snapshots** of HTML rendered from a fixture store.
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
