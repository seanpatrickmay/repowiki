# RepoWiki M3 (LLM provider, cluster, manifest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a `RepoIndex` into a stored, reviewed feature manifest for next-chief-of-staff. The pieces are an `llm` package (Claude provider with structured output, prompt caching and the Message Batches API, plus a persisted token ledger), `engine/cluster` (a deterministic import/co-change/directory graph and Louvain), and `engine/manifest` (one budgeted Haiku 4.5 call that names and groups the clusters).

**Architecture:**
- **llm.** `packages/llm` owns the `Provider` interface. It has a single Claude implementation built on `@anthropic-ai/sdk`, with a fetch-level record/replay cassette layer so that tests never touch the network.
- **cluster.** `engine/cluster` turns the index into a weighted file graph and clusters it with a plain-TypeScript Louvain whose output depends only on its input. It summarizes each cluster as names and structure, never source.
- **manifest.** `engine/manifest` sends those summaries in one call. The system prompt is the cached prefix, and the call goes through the Batches API by default. The answer is validated and retried once with the reasons, then converted into a `Manifest` whose member ids come from the index's `memberId()` ids. That manifest is stored as the drift baseline, and every call lands in the store's ledger.
- **Boundaries.** Engine modules still meet only through their `index.ts`.

**Tech Stack:** As in M2 (Node 24, pnpm 10.15.0, TypeScript 7.0.2, Biome 2.5.15, Vitest 5.0.3, zod 4.6.5, web-tree-sitter 0.27.0), plus `@anthropic-ai/sdk 0.131.0`. The model is `claude-haiku-4-5` for every role.

**Spec:** `docs/superpowers/specs/2026-09-30-repowiki-v1-design.md`. This plan relies on §4 (architecture, provider interface, data location), §5 (data model, rules 1 and 7), §6.1 (how the manifest evolves later), §6.3 (retries), §8 (cassettes) and §11 (M3 is done when it "Produces a reviewed manifest for next-chief-of-staff"). It also carries out the M3 items of issue #53.

**Builds on:** M2 at its final state, including the final-review fix wave on `m2/final-review-fixes`. M3's hand-built `RepoIndex` test fixtures set the fix wave's new `invalidPaths: string[]` field (Tasks 10 and 15). If M2 merged without that field, delete the `invalidPaths: []` line from the two fixtures and nothing else changes. No other M3 code reads `invalidPaths` or depends on the fix wave's changes (genuinely-external `external`, dunder exports, locale-free sort). They only improve what the summaries show. Every edit to an M2 file in this plan is a targeted replacement, never a whole-file rewrite, so the fix wave's own edits (such as `scrubbedGitEnv` in `packages/engine/src/index.ts`) survive.

**Verification note:** before this plan was committed, all 19 tasks were replayed mechanically, exactly as written here (every file, every replacement, every run step), onto two throwaway worktrees:
- **Base A:** the `m2/final-review-fixes` tip `82650cd`, the real fix wave. `pnpm check` went from 325 tests to 453.
- **Base B:** `main` at `9229b1a` plus M2 Tasks 5–10 from the M2 plan, with `RepoIndex.invalidPaths` simulated. `pnpm check` went from 243 tests to 371.

Results:
- **Per task:** on both bases, each "verify it fails" run failed and each `pnpm check` passed, with the "N new tests" counts below (128 in all).
- **Against the prototype:** on base B, the M3 files came out byte-identical to the prototype the numbers below were measured on.
- **Cassettes:** all four were recorded live with Haiku 4.5 from this code. The replay used those recordings, so the requests the plan's code sends are byte-identical to the recorded ones.
- **Exit gate:** it ran live on next-chief-of-staff at `7247d28` (Task 19 has the numbers).
- **Spend:** about $0.26 across the cassettes, the gate runs, and eight prompt-tuning calls.
- **Fixes folded in:** the prototype surfaced five plan fixes, all folded in:
  - The answer assigns each cluster once, because the nested shape made Haiku put clusters in two features.
  - Features with no clusters are dropped rather than rejected.
  - Cassettes are kept out of Biome.
  - Hubs are down-weighted.
  - The token estimate uses 2.5 characters per token, because 3 underestimated by 10%.

## Global Constraints

- Node `>=24`. pnpm is pinned with `"packageManager": "pnpm@10.15.0"`.
- Dependency versions are pinned exactly, and every `pnpm add` uses `--save-exact` (workspace links stay `workspace:*`). New in M3: `@anthropic-ai/sdk 0.131.0` (MIT, official, ~49M weekly downloads, published 2026-09-30; dependencies `json-schema-to-ts` and `standardwebhooks`; peer `zod` ^3.25 or ^4, satisfied by 4.6.5). Clustering uses no library (Task 11 says why).
- ESM only. Relative imports use the `.ts` extension. No `enum` or `namespace`. No parameter properties (`erasableSyntaxOnly`). No build step.
- Engine modules import each other only through `<module>/index.ts`, and `boundaries.test.ts` enforces it. `packages/llm` is a separate package, imported as `@repowiki/llm`.
- **Models and cost.** Every LLM role defaults to `claude-haiku-4-5`. Per-role model ids come from config (`resolveModels`, `--config`), never from code.
  - Every call with a reusable prefix passes a `cacheKey`, which puts `cache_control` on the system prompt. Haiku 4.5 caches only prefixes of 4096 tokens or more.
  - Every call that no one waits on uses `batch: true` (the Message Batches API, 50% off, stacking with caching).
  - No `thinking` parameter is ever sent: Haiku 4.5 predates adaptive thinking.
  - Structured output uses `output_config.format`, which Haiku 4.5 supports.
- **Ledger and pricing.** Every answered call is recorded in the `TokenLedger` and persisted in the store's `ledger` table. Prices are Haiku 4.5's: $1 / $5 per MTok in/out, cache write 1.25×, cache read 0.1×, batch 0.5×. They were checked on https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-01.
- **The key.** The API key is `ANTHROPIC_API_KEY` in the repo-root `.env`, which is gitignored. Code reads it only from `process.env`, and live commands run with `node --env-file=.env` (`pnpm cassettes:record`, `pnpm manifest:build`). Never read, print, paste or commit its value.
- **Tests.** Tests are co-located `*.test.ts` files and never touch the network. LLM tests either fake the API with `canned.ts` or replay committed cassettes in `__cassettes__/` directories, which hold no headers. CI never sets `REPOWIKI_CASSETTE`, so it always replays.
- **Writes.** RepoWiki never writes inside a repo it documents. Wiki data goes to `~/.repowiki/<repo>/` or `--out`, and both pass `resolveOutDir`.
- **Schema changes.** Any `@repowiki/core` change that rejects previously stored bodies ships with a store migration that rewrites them (Task 2). Shipped migrations are never edited; new ones are appended. M3 appends migrations 2, 3 and 4.
- Commits follow Conventional Commits with a scope. Author: `seanpatrickmay <sean.may101@gmail.com>`. Never `Co-Authored-By`, never `--no-verify`.
- `pnpm check` passes before every commit.
- One task = one branch = one PR, under ~300 changed lines (not counting `pnpm-lock.yaml`, `seed.json`, cassettes, and test fixtures). Branches are named `m3/short-description`. The PR body starts with `Closes #<ticket>`.
- Merge with `gh pr merge --merge --delete-branch --author-email sean.may101@gmail.com` (merge commits only; ADR-0002).
- Biome style: 2-space indent, double quotes, semicolons, line width 100. If lint fails only on formatting, run `pnpm format`.

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

1. **An LLM answer that breaks the manifest rules.** Examples are a cluster assigned twice or not at all, an unknown feature, a bad slug, or under 3 aliases. It gets one retry that quotes the reasons and reuses the cached prefix, then a clear `ManifestBuildError`. Harmless extras are repaired instead of retried: features with no clusters are dropped, and aliases beyond 8 are cut. *Tests: Task 14 (each problem), Task 15 (drop and cap), Task 17 (retry, second rejection, raw-text retry).*
2. **A repository too large for one prompt.** Spec §4 requires every prompt to fit under 200K tokens. The file and symbol listings shrink until the estimate fits 150K, without dropping clusters, and the build refuses if even the minimum doesn't fit. *Test: Task 17.*
3. **Running `manifest:build` twice, or against a store that has moved on.** The same sha reuses the stored manifest with no LLM call. A different sha is refused, because rebuilding would break the "IDs are permanent" rule; that is M6's update. *Tests: Task 18; live check in Task 19.*
4. **A batch where some requests fail.** An errored, expired or missing item rejects only its own promise, the ledger records only answered calls, and a batch that cannot be created rejects every caller. *Tests: Task 7, Task 8.*
5. **A cached prefix that silently changes.** A `cacheKey` reused with different system text or model throws before any request; that is the invalidator the caching docs warn costs money without failing. A cassette that no longer matches the code's requests throws `CassetteMissError` naming the re-record command, never a network call. *Tests: Task 8, Task 6.*

## Spec deltas made by this plan

These are recorded in the spec in the same commit as this plan:
- **Lineage and status agree both ways (§5 rule 1).** `create` is first and appears once. Each `rename`'s old title is in `aliases`. At most one `merge`, `split` or `retire` appears, and the status matches it: merge ⇔ redirect to its target, split ⇔ disambiguation over its targets, retire ⇔ retired, none ⇔ active. Store migration 2 repairs older bodies. This resolves #53's first M3 item.
- **Drift baseline (§6.1 step 4).** The store marks the manifests an LLM produced or revised (`putManifest(m, { llmRevised: true })`), and drift is measured against `getDriftBaseline()`, the latest such manifest. This resolves #53's second M3 item.
- **Provider interface (§4).** The request also carries `purpose` (the role: it picks the model and labels the ledger entry), `featureId` and `maxTokens`.
  - `cacheKey` names the cached prefix: the system prompt gets the cache breakpoint, and one key must always carry the same system text and model.
  - `batch: true` calls made in the same tick share one Message Batch.
  - Output is structured JSON via `output_config.format`, and no thinking is requested.
  - Ledger entries also record `runId`, `at`, `batch` and `cacheKey`, and live in the store's `ledger` table. Cost is computed from them, with the batch discount.
- **Clustering (§4).** Louvain is implemented in plain TypeScript and is deterministic by construction (no RNG), replacing "Louvain via graphology, fixed seed". The graph's edges:
  - Imports weigh 1, scaled down into hubs with in-degree above 4.
  - Co-change weighs 2 × Jaccard, for pairs that changed together at least twice.
  - Directory siblings share 0.3.
  - The defaults are resolution 3 and absorption of clusters under 5 files.
- **Membership (§5).** Every file and every symbol is a member, and in v1 a symbol inherits its file's feature. A member's weight is its role (core 1, supporting 0.5) × its centrality, the share of its edge weight inside its feature.
- **Manifest build (§4).** One call (batched by default) returns the features and one assignment per cluster, with at most one retry. M3 builds only a first manifest; moving an existing manifest to a new sha is the M6 update.
- **Cassettes (§8).** Record/replay works at the fetch level. Recordings are committed JSON in `__cassettes__/` with no headers, re-recorded with `pnpm cassettes:record`, and excluded from Biome.

## Decisions on the M2 review's open questions

- **Barrels and test-fixture hubs.** These are handled in M3 by down-weighting imports into hubs (Task 10). Edges still carry no imported names or kinds. M3 doesn't need them, and M4's diagrams decide call and import kinds.
- **Commit shas and dates.** M3 doesn't need them. Recency weighting is not used, and the M4 plan owns `firstCommitDate`/`lastCommitDate` for the Infobox.
- **`RepoIndex` schema.** M3 never stores, caches or passes a `RepoIndex` across a process boundary: `manifest:build` indexes in-process, and the manifest is what gets stored (validated by the core `Manifest` schema). So no `RepoIndex` schema is added. The first milestone that persists an index adds one.

---

## File map

```
scripts/tracker/seed.json                    + M3 tickets (Task 1)
packages/core/src/
  feature.ts            two-way lineage/status rule (Task 2)
  llm.ts                LlmRole, LedgerEntry, LlmConfigFile (Task 3)
  test-fixtures.ts      + makeLedgerEntry (Task 3)
packages/engine/src/store/
  migrations.ts         + migration 2 lineage repair (Task 2), 3 ledger (Task 3), 4 llm_revised (Task 4)
  store.ts              appendLedger/listLedger (Task 3), putManifest options + getDriftBaseline (Task 4)
packages/llm/                                 new package (Task 5)
  src/provider.ts       Provider, GenerateRequest, errors, DEFAULT_MODELS, resolveModels (Task 5)
  src/pricing.ts        Haiku 4.5 prices, callCostUsd (Task 5)
  src/ledger.ts         createLedger, totalsOf (Task 5)
  src/cassette.ts       cassetteFetch, cassetteMode (Task 6)
  src/batcher.ts        createBatcher (Task 7)
  src/canned.ts         canned API responses, test-only (Task 7)
  src/claude.ts         createClaudeProvider (Task 8)
  src/claude.cassette.test.ts + src/__cassettes__/   recorded API exchanges (Task 9)
packages/engine/src/cluster/
  graph.ts              buildFileGraph (Task 10)
  test-index.ts         makeIndex, test-only (Task 10)
  louvain.ts            louvain (Task 11)
  clusters.ts           clusterFiles (Task 12)
  summaries.ts          summarizeClusters (Task 13)
  index.ts              module entry (Task 13)
packages/engine/src/manifest/
  proposal.ts           ManifestProposal, proposalProblems (Task 14)
  to-manifest.ts        proposalToManifest (Task 15)
  test-index.ts         sampleIndex, test-only (Task 15)
  prompt.ts             instructions, digest, retry turn (Task 16)
  build.ts              buildManifest (Task 17)
  test-provider.ts      scriptedProvider, test-only (Task 17)
  ensure.ts             ensureManifest (Task 18)
  summary.ts            renderManifestSummary (Task 18)
  index.ts              module entry (Tasks 17, 18)
  claude.test.ts + __cassettes__/sample-manifest.json  recorded end-to-end run (Task 18)
scripts/out-dir.ts                           resolveOutDir (Task 19)
scripts/manifest-build.ts                    pnpm manifest:build (Task 19)
```

---

### Task 1: M3 tickets in the tracker

**Files:**
- Modify: `scripts/tracker/seed.json` (append to `issues`)

**Interfaces:**
- Produces: GitHub issues `[M3] …` that Tasks 2–19 close.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/tracker-tickets
```

- [ ] **Step 2: Append these entries to the end of the `issues` array in `scripts/tracker/seed.json`**

Add a comma after the closing `}` of the current last entry (`M2-10`), then paste the following. It is already in Biome format.

```json
    {
      "key": "M3-1",
      "title": "[M3] tracker: M3 tickets",
      "labels": ["v1", "type:task", "area:infra"],
      "parent": "F19",
      "closed": true,
      "body": "**Deliverable:** M3 tickets in seed.json.\n\n**Done when:** the seed creates M3-1..M3-19. Plan: docs/superpowers/plans/2026-10-01-repowiki-m3-manifest.md Task 1."
    },
    {
      "key": "M3-2",
      "title": "[M3] core: two-way lineage and status",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F26",
      "body": "**Deliverable:** Feature rejects lineage/status disagreements both ways (merge, split, retire, rename aliases) plus store migration 2 that repairs stored manifests (issue #53).\n\n**Done when:** lineage variant and migration tests pass. Plan Task 2."
    },
    {
      "key": "M3-3",
      "title": "[M3] store: token ledger",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F25",
      "body": "**Deliverable:** LlmRole, LedgerEntry, LlmConfigFile schemas; store migration 3 and appendLedger/listLedger.\n\n**Done when:** ledger round-trip tests pass. Plan Task 3."
    },
    {
      "key": "M3-4",
      "title": "[M3] store: drift baseline",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F05",
      "body": "**Deliverable:** store migration 4, putManifest({ llmRevised }) and getDriftBaseline() (issue #53).\n\n**Done when:** baseline tests pass. Plan Task 4."
    },
    {
      "key": "M3-5",
      "title": "[M3] llm: package, pricing, and ledger",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F25",
      "body": "**Deliverable:** packages/llm with the Provider interface, per-role model config, Haiku 4.5 pricing, and TokenLedger.\n\n**Done when:** pricing and ledger tests pass. Plan Task 5."
    },
    {
      "key": "M3-6",
      "title": "[M3] llm: record/replay cassettes",
      "labels": ["v1", "type:task", "area:infra"],
      "parent": "F19",
      "body": "**Deliverable:** cassetteFetch (header-free recordings, replay by request) and pnpm cassettes:record.\n\n**Done when:** cassette tests pass. Plan Task 6."
    },
    {
      "key": "M3-7",
      "title": "[M3] llm: Message Batches client",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F25",
      "body": "**Deliverable:** createBatcher: same-tick requests share one Message Batch; per-item failures.\n\n**Done when:** batcher tests pass. Plan Task 7."
    },
    {
      "key": "M3-8",
      "title": "[M3] llm: Claude provider",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F25",
      "body": "**Deliverable:** createClaudeProvider: structured output, cache breakpoint per cacheKey, batching, ledger.\n\n**Done when:** provider tests pass. Plan Task 8."
    },
    {
      "key": "M3-9",
      "title": "[M3] llm: recorded Claude cassettes",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F25",
      "body": "**Deliverable:** cassette tests for structured output, prompt caching, and batching, recorded live once.\n\n**Done when:** the cassettes replay green in CI. Plan Task 9."
    },
    {
      "key": "M3-10",
      "title": "[M3] cluster: file graph",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** buildFileGraph: import, co-change, and directory edges over every file.\n\n**Done when:** graph tests pass. Plan Task 10."
    },
    {
      "key": "M3-11",
      "title": "[M3] cluster: Louvain",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** deterministic Louvain in plain TypeScript.\n\n**Done when:** louvain tests pass. Plan Task 11."
    },
    {
      "key": "M3-12",
      "title": "[M3] cluster: clusters",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** clusterFiles: Louvain plus small-cluster absorption and stable ids.\n\n**Done when:** cluster tests pass. Plan Task 12."
    },
    {
      "key": "M3-13",
      "title": "[M3] cluster: summaries",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** summarizeClusters, the cluster module entry, and engine exports.\n\n**Done when:** summary tests pass. Plan Task 13."
    },
    {
      "key": "M3-14",
      "title": "[M3] manifest: proposal validation",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F26",
      "body": "**Deliverable:** ManifestProposal schema and proposalProblems.\n\n**Done when:** proposal tests pass. Plan Task 14."
    },
    {
      "key": "M3-15",
      "title": "[M3] manifest: membership and weights",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** proposalToManifest: every file and symbol a member via memberId, weights by role and centrality.\n\n**Done when:** to-manifest tests pass. Plan Task 15."
    },
    {
      "key": "M3-16",
      "title": "[M3] manifest: prompt",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** the manifest instructions and cluster digest (the cached prefix).\n\n**Done when:** prompt tests pass. Plan Task 16."
    },
    {
      "key": "M3-17",
      "title": "[M3] manifest: buildManifest",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** buildManifest: clusters, budgeted prompt, one batched call, one retry with reasons.\n\n**Done when:** build tests pass. Plan Task 17."
    },
    {
      "key": "M3-18",
      "title": "[M3] manifest: store, summary, recorded run",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** ensureManifest, renderManifestSummary, engine exports, and a recorded Claude run on a sample index.\n\n**Done when:** tests pass, cassette included. Plan Task 18."
    },
    {
      "key": "M3-19",
      "title": "[M3] manifest: dev command and next-chief-of-staff run",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** pnpm manifest:build.\n\n**Done when:** next-chief-of-staff at 7247d28 produces a stored manifest and a saved summary for review. Plan Task 19."
    }
```

- [ ] **Step 3: Verify, commit, ship**

Run: `pnpm check && pnpm tracker:seed --dry-run | grep -E '^(create|link|close)'`
Expected: `pnpm check` passes, and the dry run lists exactly 19 `create`, 19 `link` and 1 `close` line, all for M3 keys.

Run: `pnpm check`
Expected: PASS.

```bash
git add scripts/tracker/seed.json
git commit -m "chore(tracker): add M3 tickets"
```

Ship. PR title: `chore(tracker): add M3 tickets`. There is no `Closes` line, since the tickets don't exist yet.

- [ ] **Step 4: Seed from `main` after the merge**

```bash
pnpm tracker:seed --project 2
pnpm tracker:seed --dry-run | grep -cE '^(create|link|close)'   # expect 0
```

---

### Task 2: Two-way lineage and status

**Ticket:** `[M3] core: two-way lineage and status`

**Files:**
- Modify: `packages/core/src/feature.ts` (the status/lineage checks), `packages/engine/src/store/migrations.ts` (append migration 2)
- Test: `packages/core/src/feature.test.ts`, `packages/engine/src/store/migrations.test.ts` (add cases)

**Interfaces:**
- Produces: the rule set below, enforced by `Feature` (and so by `Manifest`, the store, and the export):
  - `create` is the first lineage event and appears once.
  - Every `rename` event's `fromTitle` is in `aliases`.
  - At most one of `merge`, `split`, `retire` appears, and the status says the same thing: `merge(into X)` ⇔ `redirect` to X; `split(into S)` ⇔ `disambiguation` over exactly S; `retire` ⇔ `retired`; none of them ⇔ `active`.
  - `MIGRATIONS[1]` (store schema version 2) rewrites stored manifest bodies so they pass: it adds missing rename titles to `aliases`, and gives an `active` feature with exactly one ending event the status that event implies. Issue #53, first M3 item.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/lineage-status
```

- [ ] **Step 2: Write the failing tests**

In `packages/core/src/feature.test.ts`, replace the feature import:
```ts
import { Feature, FeatureId } from "./feature.ts";
```
with:
```ts
import { Feature, FeatureId, LineageEvent } from "./feature.ts";
```

Then append to the end of the same file:
```ts
describe("lineage variants", () => {
  it.each([
    { kind: "create", sha: SHA_A },
    { kind: "rename", sha: SHA_B, fromTitle: "Signals" },
    { kind: "merge", sha: SHA_B, into: "deliverables" },
    { kind: "split", sha: SHA_B, into: ["signal-ingest", "signal-scoring"] },
    { kind: "retire", sha: SHA_B },
  ])("parses a $kind event", (event) => {
    expect(LineageEvent.parse(event)).toEqual(event);
  });

  it.each([
    { kind: "rename", sha: SHA_B },
    { kind: "merge", sha: SHA_B },
    { kind: "retire", sha: "abc" },
  ])("rejects a malformed $kind event", (event) => {
    expect(LineageEvent.safeParse(event).success).toBe(false);
  });
});

describe("Feature lineage and status agree both ways (issue #53)", () => {
  const create = { kind: "create" as const, sha: SHA_A };
  const issues = (feature: Feature) =>
    Feature.safeParse(feature).error?.issues.map((issue) => issue.message) ?? [];

  it("accepts a merged feature that redirects to its merge target", () => {
    const merged = makeFeature({
      lineage: [create, { kind: "merge", sha: SHA_B, into: "deliverables" }],
      status: { kind: "redirect", to: "deliverables" },
    });
    expect(Feature.parse(merged)).toEqual(merged);
  });

  it("rejects a merge event on an active feature", () => {
    const feature = makeFeature({
      lineage: [create, { kind: "merge", sha: SHA_B, into: "deliverables" }],
    });
    expect(issues(feature)).toContain("a merge lineage event requires redirect status");
  });

  it("rejects a redirect to a feature other than the merge target", () => {
    const feature = makeFeature({
      lineage: [create, { kind: "merge", sha: SHA_B, into: "deliverables" }],
      status: { kind: "redirect", to: "billing" },
    });
    expect(issues(feature)).toContain(
      "redirect status requires a merge lineage event into its target",
    );
  });

  it("rejects a split event on an active feature", () => {
    const feature = makeFeature({
      lineage: [create, { kind: "split", sha: SHA_B, into: ["signal-ingest", "signal-scoring"] }],
    });
    expect(issues(feature)).toContain("a split lineage event requires disambiguation status");
  });

  it("accepts a renamed feature that keeps its old title as an alias", () => {
    const renamed = makeFeature({
      aliases: ["signal pipeline", "Signals"],
      lineage: [create, { kind: "rename", sha: SHA_B, fromTitle: "Signals" }],
    });
    expect(Feature.parse(renamed)).toEqual(renamed);
  });

  it("rejects a rename whose old title is not an alias", () => {
    const feature = makeFeature({
      lineage: [create, { kind: "rename", sha: SHA_B, fromTitle: "Signals" }],
    });
    expect(issues(feature)).toContain('rename lineage requires "Signals" in aliases');
  });

  it("accepts a retired feature with a retire event", () => {
    const retired = makeFeature({
      lineage: [create, { kind: "retire", sha: SHA_B }],
      status: { kind: "retired" },
    });
    expect(Feature.parse(retired)).toEqual(retired);
  });

  it("rejects a retire event on an active feature", () => {
    const feature = makeFeature({ lineage: [create, { kind: "retire", sha: SHA_B }] });
    expect(issues(feature)).toContain("a retire lineage event requires retired status");
  });

  it("rejects retired status without a retire event", () => {
    const feature = makeFeature({ status: { kind: "retired" } });
    expect(issues(feature)).toContain("retired status requires a retire lineage event");
  });

  it("rejects more than one ending event", () => {
    const feature = makeFeature({
      lineage: [create, { kind: "retire", sha: SHA_B }, { kind: "retire", sha: SHA_B }],
      status: { kind: "retired" },
    });
    expect(issues(feature)).toContain(
      "lineage may contain at most one merge, split, or retire event",
    );
  });

  it("rejects a second create event", () => {
    const feature = makeFeature({ lineage: [create, create] });
    expect(issues(feature)).toContain("create may only be the first lineage event");
  });
});
```

In `packages/engine/src/store/migrations.test.ts`, replace the fixtures import:
```ts
import { makeManifest } from "@repowiki/core/test-fixtures";
```
with:
```ts
import { makeFeature, makeManifest, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
```

Then append to the end of the same file:
```ts
describe("migration 2: two-way lineage and status", () => {
  it("repairs manifests stored under the one-way rules", () => {
    const path = tempDbPath();
    const old = new Database(path);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    const stored = makeManifest({
      features: [
        makeFeature({
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "rename", sha: SHA_B, fromTitle: "Signals" },
          ],
        }),
        makeFeature({
          id: "deliverables",
          title: "Deliverables",
          aliases: [],
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "retire", sha: SHA_B },
          ],
        }),
      ],
      membership: { "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 } },
    });
    old
      .prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, 1, ?)")
      .run(stored.sha, JSON.stringify(stored));
    old.close();

    const store = openStore(path);
    const [signals, deliverables] = store.getManifest(stored.sha)?.features ?? [];
    expect(signals?.aliases).toEqual(["signal pipeline", "Signals"]);
    expect(deliverables?.status).toEqual({ kind: "retired" });
    store.close();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/core/src/feature.test.ts packages/engine/src/store/migrations.test.ts`
Expected: FAIL. Eight of the new "agree both ways" cases fail because today's schema only checks one direction (the "accepts …" and lineage-variant cases already pass), and the migration test fails because the stored rename title never reaches `aliases`.

- [ ] **Step 4: Implement**

The old check only demanded a merge event *somewhere* for a redirect, and a split for a disambiguation. Replace it with the two-way rule.

In `packages/core/src/feature.ts`, replace everything from the `// Status-lineage correspondence` comment to the end of the `superRefine` callback:
```ts
    // Status-lineage correspondence
    if (feature.status.kind === "redirect") {
      const redirectTo = feature.status.to;
      const hasMerge = feature.lineage.some((e) => e.kind === "merge" && e.into === redirectTo);
      if (!hasMerge) {
        ctx.addIssue({
          code: "custom",
          message: "redirect status requires a merge lineage event",
          path: ["status"],
        });
      }
    }

    if (feature.status.kind === "disambiguation") {
      const targetSet = new Set(feature.status.to);
      const hasSplit = feature.lineage.some(
        (e) =>
          e.kind === "split" &&
          new Set(e.into).size === targetSet.size &&
          e.into.every((t) => targetSet.has(t)),
      );
      if (!hasSplit) {
        ctx.addIssue({
          code: "custom",
          message: "disambiguation status requires a matching split lineage event",
          path: ["status"],
        });
      }
    }
  });
```
with:
```ts
    // Lineage <-> status, both ways (issue #53). create opens the lineage and appears once; a
    // rename keeps the old title as an alias; merge, split and retire end a feature's life, so at
    // most one of them appears and the status must say the same thing.
    feature.lineage.forEach((event, index) => {
      if (event.kind === "create" && index > 0) {
        ctx.addIssue({
          code: "custom",
          message: "create may only be the first lineage event",
          path: ["lineage", index],
        });
      }
      if (event.kind === "rename" && !feature.aliases.includes(event.fromTitle)) {
        ctx.addIssue({
          code: "custom",
          message: `rename lineage requires "${event.fromTitle}" in aliases`,
          path: ["aliases"],
        });
      }
    });
    const endings = feature.lineage.filter(
      (e) => e.kind === "merge" || e.kind === "split" || e.kind === "retire",
    );
    if (endings.length > 1) {
      ctx.addIssue({
        code: "custom",
        message: "lineage may contain at most one merge, split, or retire event",
        path: ["lineage"],
      });
    }
    const ending = endings[0];
    const status = feature.status;
    const statusIssue = (message: string) =>
      ctx.addIssue({ code: "custom", message, path: ["status"] });
    if (status.kind === "redirect") {
      if (ending?.kind !== "merge" || ending.into !== status.to) {
        statusIssue("redirect status requires a merge lineage event into its target");
      }
    } else if (status.kind === "disambiguation") {
      const targets = new Set(status.to);
      const matches =
        ending?.kind === "split" &&
        new Set(ending.into).size === targets.size &&
        ending.into.every((t) => targets.has(t));
      if (!matches) statusIssue("disambiguation status requires a matching split lineage event");
    } else if (status.kind === "retired") {
      if (ending?.kind !== "retire") statusIssue("retired status requires a retire lineage event");
    } else if (ending !== undefined) {
      const expected = { merge: "redirect", split: "disambiguation", retire: "retired" }[
        ending.kind
      ];
      statusIssue(`a ${ending.kind} lineage event requires ${expected} status`);
    }
  });
```

In `packages/engine/src/store/migrations.ts`, append migration 2 to `MIGRATIONS` and define it below the array. It works on raw JSON, never on the `@repowiki/core` schemas, so later schema changes can never change what a shipped migration does. Replace the end of the array:
```ts
  CREATE INDEX citation_ranges_lookup ON citation_ranges(path, start_line, end_line);
  `,
];
```
with:
```ts
  CREATE INDEX citation_ranges_lookup ON citation_ranges(path, start_line, end_line);
  `,
  repairLineageStatus,
];

interface StoredFeature {
  aliases: string[];
  status: { kind: string; to?: string | string[] };
  lineage: { kind: string; fromTitle?: string; into?: string | string[] }[];
}

/**
 * Migration 2: lineage and status became two-way (issue #53). In every stored manifest, a rename's
 * old title joins the aliases, and an active feature with one merge, split, or retire event takes
 * the status that event implies. Works on raw JSON so later schema changes cannot alter it.
 */
function repairLineageStatus(db: Database.Database): void {
  const rows = db.prepare("SELECT sha, body FROM manifests").all() as {
    sha: string;
    body: string;
  }[];
  const update = db.prepare("UPDATE manifests SET body = ? WHERE sha = ?");
  for (const row of rows) {
    const manifest = JSON.parse(row.body) as { features: StoredFeature[] };
    for (const feature of manifest.features) {
      for (const event of feature.lineage) {
        if (event.kind === "rename" && event.fromTitle !== undefined) {
          if (!feature.aliases.includes(event.fromTitle)) feature.aliases.push(event.fromTitle);
        }
      }
      const endings = feature.lineage.filter((e) => ["merge", "split", "retire"].includes(e.kind));
      const ending = endings[0];
      if (feature.status.kind !== "active" || endings.length !== 1 || ending === undefined) {
        continue;
      }
      if (ending.kind === "retire") feature.status = { kind: "retired" };
      else if (ending.kind === "merge") feature.status = { kind: "redirect", to: ending.into };
      else feature.status = { kind: "disambiguation", to: ending.into };
    }
    update.run(JSON.stringify(manifest), row.sha);
  }
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS. The existing feature, manifest and store tests are unchanged and still pass: they only build features whose lineage and status already agree, or expect a rejection that the new rule also gives.

- [ ] **Step 6: Commit and ship**

```bash
git add packages/core packages/engine/src/store
git commit -m "feat(core): make lineage and status agree both ways"
```

Ship. PR title: `feat(core): two-way lineage and status`.

---

### Task 3: Token ledger in core and the store

**Ticket:** `[M3] store: token ledger`

**Files:**
- Create: `packages/core/src/llm.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/test-fixtures.ts`, `packages/engine/src/store/migrations.ts`, `packages/engine/src/store/store.ts`
- Test: `packages/core/src/llm.test.ts`, `packages/engine/src/store/ledger.test.ts`

**Interfaces:**
- Produces (all exported from `@repowiki/core`):
  ```ts
  const LlmRole = z.enum(["manifest", "write", "tieBreak", "evalAgent", "evalJudge"])
  const LedgerEntry = z.object({ runId, at: IsoDateTime, purpose: LlmRole, model, featureId: FeatureId | null, batch: boolean, cacheKey: string | null, tokens: TokenUsage })
  const LlmConfigFile = z.strictObject({ models: z.partialRecord(LlmRole, z.string().min(1)).default({}) })
  makeLedgerEntry(overrides?: Partial<LedgerEntry>): LedgerEntry   // @repowiki/core/test-fixtures
  ```
- Produces on `Store`: `appendLedger(entry: LedgerEntry): void` and `listLedger(runId?: string): LedgerEntry[]` (append order). Both parse with `LedgerEntry`.
- `MIGRATIONS[2]` (schema version 3) creates the `ledger` table.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/store-ledger
```

- [ ] **Step 2: Add the test fixture and write the failing tests**

In `packages/core/src/test-fixtures.ts`, add the type import after the `Feature` import:
```ts
import type { Feature } from "./feature.ts";
```
with:
```ts
import type { Feature } from "./feature.ts";
import type { LedgerEntry } from "./llm.ts";
```

and add `makeLedgerEntry` directly above `makeRevision`. Replace the line:
```ts
export function makeRevision(
```
with:
```ts
export function makeLedgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    runId: "run-1",
    at: "2026-10-01T12:00:00.000Z",
    purpose: "manifest",
    model: "claude-haiku-4-5-20251001",
    featureId: null,
    batch: false,
    cacheKey: null,
    tokens: { in: 1000, out: 200, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

export function makeRevision(
```

`packages/core/src/llm.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { LedgerEntry, LlmConfigFile } from "./llm.ts";
import { makeLedgerEntry } from "./test-fixtures.ts";

describe("LedgerEntry", () => {
  it("accepts a recorded call", () => {
    expect(LedgerEntry.parse(makeLedgerEntry())).toEqual(makeLedgerEntry());
  });

  it.each([
    ["an unknown purpose", { purpose: "summarize" }],
    ["negative tokens", { tokens: { in: -1, out: 0, cacheRead: 0, cacheWrite: 0 } }],
    ["a timestamp without offset", { at: "2026-10-01 12:00" }],
    ["a non-slug feature id", { featureId: "Signals" }],
  ])("rejects %s", (_name, overrides) => {
    expect(LedgerEntry.safeParse({ ...makeLedgerEntry(), ...overrides }).success).toBe(false);
  });
});

describe("LlmConfigFile", () => {
  it("accepts per-role overrides and defaults to none", () => {
    expect(LlmConfigFile.parse({ models: { write: "claude-sonnet-5-5" } })).toEqual({
      models: { write: "claude-sonnet-5-5" },
    });
    expect(LlmConfigFile.parse({})).toEqual({ models: {} });
  });

  it.each([
    ["an unknown role", { models: { summarize: "claude-haiku-4-5" } }],
    ["an empty model id", { models: { manifest: "" } }],
    ["an unknown top-level key", { model: "claude-haiku-4-5" }],
  ])("rejects %s", (_name, file) => {
    expect(LlmConfigFile.safeParse(file).success).toBe(false);
  });
});
```

`packages/engine/src/store/ledger.test.ts`:
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLedgerEntry } from "@repowiki/core/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("token ledger", () => {
  it("returns entries in append order, across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-ledger-"));
    dirs.push(dir);
    const path = join(dir, "wiki.db");
    const first = makeLedgerEntry();
    const second = makeLedgerEntry({ purpose: "write", featureId: "signals", batch: true });
    const store = openStore(path);
    store.appendLedger(first);
    store.appendLedger(second);
    store.close();
    const reopened = openStore(path);
    expect(reopened.listLedger()).toEqual([first, second]);
    reopened.close();
  });

  it("filters by run", () => {
    const store = openStore(":memory:");
    const mine = makeLedgerEntry({ runId: "run-b" });
    store.appendLedger(makeLedgerEntry({ runId: "run-a" }));
    store.appendLedger(mine);
    expect(store.listLedger("run-b")).toEqual([mine]);
    expect(store.listLedger("run-c")).toEqual([]);
    store.close();
  });

  it("validates entries before storing them", () => {
    const store = openStore(":memory:");
    const bad = makeLedgerEntry({ tokens: { in: -1, out: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(() => store.appendLedger(bad)).toThrow();
    expect(store.listLedger()).toEqual([]);
    store.close();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/core/src/llm.test.ts packages/engine/src/store/ledger.test.ts`
Expected: FAIL, because `./llm.ts` does not exist and the store has no `appendLedger`.

- [ ] **Step 4: Implement**

`packages/core/src/llm.ts`:
```ts
import { z } from "zod";
import { FeatureId } from "./feature.ts";
import { IsoDateTime } from "./primitives.ts";
import { TokenUsage } from "./revision.ts";

/** What an LLM call is for. Each role has its own model id in config (spec §4). */
export const LlmRole = z.enum(["manifest", "write", "tieBreak", "evalAgent", "evalJudge"]);
export type LlmRole = z.infer<typeof LlmRole>;

/** One provider call, as recorded in the TokenLedger and stored by the store. */
export const LedgerEntry = z.object({
  /** Groups the calls of one CLI run (build, update, manifest:build). */
  runId: z.string().min(1),
  at: IsoDateTime,
  purpose: LlmRole,
  /** The model id the API reported, e.g. "claude-haiku-4-5-20251001". */
  model: z.string().min(1),
  featureId: FeatureId.nullable(),
  /** True when the call went through the Message Batches API (billed at 50%). */
  batch: z.boolean(),
  cacheKey: z.string().min(1).nullable(),
  tokens: TokenUsage,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** A config file's LLM section: per-role model id overrides; unnamed roles keep the default. */
export const LlmConfigFile = z.strictObject({
  models: z.partialRecord(LlmRole, z.string().min(1)).default({}),
});
export type LlmConfigFile = z.infer<typeof LlmConfigFile>;
```

In `packages/core/src/index.ts`, add the export above the manifest line:
```ts
export { Manifest, MemberId, Membership } from "./manifest.ts";
```
with:
```ts
export { LedgerEntry, LlmConfigFile, LlmRole } from "./llm.ts";
export { Manifest, MemberId, Membership } from "./manifest.ts";
```

In `packages/engine/src/store/migrations.ts`, append migration 3 to the array:
```ts
  repairLineageStatus,
];
```
with:
```ts
  repairLineageStatus,
  `
  CREATE TABLE ledger (
    seq INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX ledger_run ON ledger(run_id);
  `,
];
```

In `packages/engine/src/store/store.ts`, import the schema:
```ts
import { GitSha, Manifest, Revision } from "@repowiki/core";
```
with:
```ts
import { GitSha, LedgerEntry, Manifest, Revision } from "@repowiki/core";
```

add the two methods to the `Store` interface, after `getLatestManifest`:
```ts
  getLatestManifest(): Manifest | null;
  /** The last sha
```
with:
```ts
  getLatestManifest(): Manifest | null;
  /** Appends one LLM call to the token ledger. */
  appendLedger(entry: LedgerEntry): void;
  /** Ledger entries in the order they were appended, optionally only those of one run. */
  listLedger(runId?: string): LedgerEntry[];
  /** The last sha
```

and implement them in the returned object, directly above `getManifest`:
```ts
    getManifest: (sha) =>
```
with:
```ts
    appendLedger(entry) {
      const parsed = LedgerEntry.parse(entry);
      db.prepare("INSERT INTO ledger (run_id, body) VALUES (?, ?)").run(
        parsed.runId,
        JSON.stringify(parsed),
      );
    },

    listLedger: (runId) =>
      (
        (runId === undefined
          ? db.prepare("SELECT body FROM ledger ORDER BY seq").all()
          : db
              .prepare("SELECT body FROM ledger WHERE run_id = ? ORDER BY seq")
              .all(runId)) as BodyRow[]
      ).map((row) => LedgerEntry.parse(JSON.parse(row.body))),

    getManifest: (sha) =>
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS. The migrations test "brings a new database to the latest schema version" now expects version 3, since it reads `MIGRATIONS.length`.

- [ ] **Step 6: Commit and ship**

```bash
git add packages/core packages/engine/src/store
git commit -m "feat(store): persist the token ledger"
```

Ship. PR title: `feat(store): token ledger`.

---

### Task 4: Drift baseline

**Ticket:** `[M3] store: drift baseline`

**Files:**
- Modify: `packages/engine/src/store/migrations.ts`, `packages/engine/src/store/store.ts`, `packages/engine/src/store/index.ts`, `packages/engine/src/index.ts`
- Test: `packages/engine/src/store/manifests.test.ts` (add cases)

**Interfaces:**
- Produces: `interface PutManifestOptions { llmRevised?: boolean }`; `Store.putManifest(manifest, options?: PutManifestOptions)`; `Store.getDriftBaseline(): Manifest | null` — the most recent manifest stored with `llmRevised: true`. Spec §6.1 step 4 measures drift against it; a manifest that only gained members (`llmRevised` false) leaves it in place. Issue #53, second M3 item.
- `MIGRATIONS[3]` (schema version 4) adds `manifests.llm_revised`, defaulting to 0 for manifests stored earlier.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/drift-baseline
```

- [ ] **Step 2: Write the failing tests**

In `packages/engine/src/store/manifests.test.ts`, replace the fixtures import:
```ts
import { makeFeature, makeManifest, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
```
with:
```ts
import { makeFeature, makeManifest, SHA_A, SHA_B, SHA_C } from "@repowiki/core/test-fixtures";
```

Then append to the end of the same file:
```ts
describe("drift baseline", () => {
  it("is null until an LLM-revised manifest is stored", () => {
    store.putManifest(makeManifest());
    expect(store.getDriftBaseline()).toBeNull();
  });

  it("is the latest LLM-revised manifest; member-only manifests do not move it", () => {
    store.putManifest(makeManifest(), { llmRevised: true });
    store.putManifest(makeManifest({ sha: SHA_B }));
    expect(store.getLatestManifest()?.sha).toBe(SHA_B);
    expect(store.getDriftBaseline()?.sha).toBe(SHA_A);
    store.putManifest(makeManifest({ sha: SHA_C }), { llmRevised: true });
    expect(store.getDriftBaseline()?.sha).toBe(SHA_C);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/store/manifests.test.ts`
Expected: FAIL with `store.getDriftBaseline is not a function`. (Typecheck would also reject the new `putManifest` argument.)

- [ ] **Step 4: Implement**

In `packages/engine/src/store/migrations.ts`, append migration 4:
```ts
  CREATE INDEX ledger_run ON ledger(run_id);
  `,
];
```
with:
```ts
  CREATE INDEX ledger_run ON ledger(run_id);
  `,
  "ALTER TABLE manifests ADD COLUMN llm_revised INTEGER NOT NULL DEFAULT 0",
];
```

In `packages/engine/src/store/store.ts`, change the `putManifest` signature in `Store`:
```ts
  putManifest(manifest: Manifest): void;
```
with:
```ts
  putManifest(manifest: Manifest, options?: PutManifestOptions): void;
```

declare `getDriftBaseline` after `getLatestManifest`:
```ts
  getLatestManifest(): Manifest | null;
  /** Appends one LLM call
```
with:
```ts
  getLatestManifest(): Manifest | null;
  /**
   * The most recent manifest stored with llmRevised: true. Manifest drift (spec §6.1 step 4) is
   * measured against it; manifests that only gained members do not move the baseline.
   */
  getDriftBaseline(): Manifest | null;
  /** Appends one LLM call
```

add the options type above `interface BodyRow`:
```ts
interface BodyRow {
```
with:
```ts
export interface PutManifestOptions {
  /** True when an LLM call produced or revised this manifest (build, or a drift revision). */
  llmRevised?: boolean;
}

interface BodyRow {
```

take the options in the implementation:
```ts
    putManifest(manifest) {
```
with:
```ts
    putManifest(manifest, options = {}) {
```

record them in the insert:
```ts
        db.prepare(
          "INSERT INTO manifests (sha, seq, body) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM manifests), ?)",
        ).run(parsed.sha, JSON.stringify(parsed));
```
with:
```ts
        db.prepare(
          "INSERT INTO manifests (sha, seq, body, llm_revised) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM manifests), ?, ?)",
        ).run(parsed.sha, JSON.stringify(parsed), options.llmRevised === true ? 1 : 0);
```

and implement the query directly above `appendLedger`:
```ts
    appendLedger(entry) {
```
with:
```ts
    getDriftBaseline: () =>
      readManifest(
        db
          .prepare("SELECT body FROM manifests WHERE llm_revised = 1 ORDER BY seq DESC LIMIT 1")
          .get() as BodyRow | undefined,
      ),

    appendLedger(entry) {
```

Export the type from `packages/engine/src/store/index.ts`:
```ts
export { type CitingClaim, openStore, type Store } from "./store.ts";
```
with:
```ts
export { type CitingClaim, openStore, type PutManifestOptions, type Store } from "./store.ts";
```

and from the engine. In `packages/engine/src/index.ts`, replace these lines of the store export block:
```ts
  openStore,
  StaleParentError,
```
with:
```ts
  openStore,
  type PutManifestOptions,
  StaleParentError,
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src
git commit -m "feat(store): persist the drift baseline"
```

Ship. PR title: `feat(store): drift baseline`.

---

### Task 5: The llm package: provider interface, pricing, ledger

**Ticket:** `[M3] llm: package, pricing, and ledger`

**Files:**
- Create: `packages/llm/package.json`, `packages/llm/src/provider.ts`, `packages/llm/src/pricing.ts`, `packages/llm/src/ledger.ts`, `packages/llm/src/index.ts`
- Modify: `CLAUDE.md` (layout), `pnpm-lock.yaml`
- Test: `packages/llm/src/ledger.test.ts`

**Interfaces:**
- Consumes: `LlmRole`, `LedgerEntry`, `LlmConfigFile`, `TokenUsage` from `@repowiki/core` (Task 3).
- Produces (exported from `@repowiki/llm`):
  ```ts
  interface LlmMessage { role: "user" | "assistant"; content: string }
  interface GenerateRequest<T> { purpose: LlmRole; featureId?: string | null; system: string; messages: readonly LlmMessage[]; schema: z.ZodType<T>; maxTokens: number; cacheKey?: string; batch?: boolean }
  interface GenerateResult<T> { output: T; usage: TokenUsage; model: string }
  interface Provider { generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> }
  class LlmError extends Error; class LlmOutputError extends LlmError { readonly text: string }
  type ModelConfig = Readonly<Record<LlmRole, string>>
  const DEFAULT_MODELS: ModelConfig            // every role "claude-haiku-4-5"
  resolveModels(configFile?: unknown): ModelConfig   // LlmConfigFile overrides over the defaults
  interface ModelPrice { input; output; cacheWrite; cacheRead }   // USD per MTok
  const MODEL_PRICES; const BATCH_PRICE_FACTOR = 0.5
  priceFor(model: string): ModelPrice | null    // accepts dated ids
  callCostUsd(model: string, tokens: TokenUsage, batch: boolean): number | null
  interface LedgerTotals { calls; batchCalls; tokens: TokenUsage; usd; unpricedCalls }
  interface TokenLedger { record(entry: LedgerEntry): void; entries(): LedgerEntry[]; totals(): LedgerTotals }
  createLedger(sink?: (entry: LedgerEntry) => void): TokenLedger
  totalsOf(entries: readonly LedgerEntry[]): LedgerTotals
  ```
- `system` is the stable prefix and `messages` the varying tail. The spec's `generate({ system, messages, schema, cacheKey?, batch? })` gains `purpose` (the role, which picks the model and labels the ledger entry), `featureId`, and `maxTokens`.

- [ ] **Step 1: Branch and create the package**

```bash
git switch -c m3/llm-package
mkdir -p packages/llm/src
```

`packages/llm/package.json`:
```json
{
  "name": "@repowiki/llm",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@repowiki/core": "workspace:*"
  }
}
```

```bash
pnpm --filter @repowiki/llm add --save-exact zod@4.6.5
```

`pnpm-workspace.yaml` already globs `packages/*`, and the root `tsconfig.json` and `vitest.config.ts` already include `packages/*/src`, so nothing else needs wiring.

- [ ] **Step 2: Write the failing test**

`packages/llm/src/ledger.test.ts`:
```ts
import { makeLedgerEntry } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { createLedger } from "./ledger.ts";
import { callCostUsd, priceFor } from "./pricing.ts";
import { DEFAULT_MODELS, resolveModels } from "./provider.ts";

const million = { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 };

describe("pricing", () => {
  it("knows Haiku 4.5 by alias and by dated id", () => {
    expect(priceFor("claude-haiku-4-5")).toEqual({
      input: 1,
      output: 5,
      cacheWrite: 1.25,
      cacheRead: 0.1,
    });
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(priceFor("claude-haiku-4-5"));
    expect(priceFor("claude-unknown-1")).toBeNull();
  });

  it.each([
    ["input", million, false, 1],
    ["output", { ...million, in: 0, out: 1_000_000 }, false, 5],
    ["cache writes", { ...million, in: 0, cacheWrite: 1_000_000 }, false, 1.25],
    ["cache reads", { ...million, in: 0, cacheRead: 1_000_000 }, false, 0.1],
    ["batched output", { ...million, in: 0, out: 1_000_000 }, true, 2.5],
    ["batched cache reads", { ...million, in: 0, cacheRead: 1_000_000 }, true, 0.05],
  ])("prices a million tokens of %s", (_name, tokens, batch, usd) => {
    expect(callCostUsd("claude-haiku-4-5-20251001", tokens, batch)).toBeCloseTo(usd, 10);
  });
});

describe("createLedger", () => {
  it("totals tokens and dollars, and forwards each entry to the sink", () => {
    const sunk: unknown[] = [];
    const ledger = createLedger((entry) => sunk.push(entry));
    ledger.record(makeLedgerEntry({ tokens: { in: 2000, out: 400, cacheRead: 0, cacheWrite: 0 } }));
    ledger.record(
      makeLedgerEntry({
        batch: true,
        tokens: { in: 0, out: 1000, cacheRead: 10_000, cacheWrite: 0 },
      }),
    );
    ledger.record(makeLedgerEntry({ model: "mystery-model" }));
    expect(ledger.totals()).toEqual({
      calls: 3,
      batchCalls: 1,
      tokens: { in: 3000, out: 1600, cacheRead: 10_000, cacheWrite: 0 },
      usd: expect.closeTo(0.002 + 0.002 + (0.005 + 0.001) / 2, 10),
      unpricedCalls: 1,
    });
    expect(sunk).toEqual(ledger.entries());
  });

  it("rejects an invalid entry without recording it", () => {
    const ledger = createLedger();
    expect(() => ledger.record(makeLedgerEntry({ runId: "" }))).toThrow();
    expect(ledger.entries()).toEqual([]);
  });
});

describe("resolveModels", () => {
  it("defaults every role to Haiku 4.5 and applies per-role overrides", () => {
    expect(Object.values(DEFAULT_MODELS)).toEqual(Array(5).fill("claude-haiku-4-5"));
    expect(resolveModels({ models: { write: "claude-sonnet-5-5" } })).toEqual({
      ...DEFAULT_MODELS,
      write: "claude-sonnet-5-5",
    });
  });

  it("rejects an invalid config file", () => {
    expect(() => resolveModels({ models: { summarize: "x" } })).toThrow();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run packages/llm/src/ledger.test.ts`
Expected: FAIL, because `./ledger.ts` does not exist.

- [ ] **Step 4: Implement**

Prices come from https://platform.claude.com/docs/en/about-claude/pricing, checked on 2026-10-01: Haiku 4.5 is $1 input, $5 output, $1.25 for 5-minute cache writes (1.25×), and $0.10 for cache reads (0.1×), per million tokens. The Batch API halves every token class, and the page says the discounts stack.

`packages/llm/src/provider.ts`:
```ts
import { LlmConfigFile, type LlmRole, type TokenUsage } from "@repowiki/core";
import type { z } from "zod";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest<T> {
  purpose: LlmRole;
  featureId?: string | null;
  /**
   * The stable prefix: instructions plus any shared context. With a cacheKey it is prompt-cached,
   * so it must be byte-identical across calls that share the key.
   */
  system: string;
  /** The varying part of the prompt, after the cached prefix. */
  messages: readonly LlmMessage[];
  /** The output must be a JSON object matching this schema. */
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Names the cached prefix. Calls sharing a key must send the same system text and model. */
  cacheKey?: string;
  /** Route through the Message Batches API (50% price, answer within 24h). */
  batch?: boolean;
}

export interface GenerateResult<T> {
  output: T;
  usage: TokenUsage;
  /** The model id the API reported. */
  model: string;
}

export interface Provider {
  generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The model answered, but not with valid output. Its tokens are already in the ledger. */
export class LlmOutputError extends LlmError {
  /** The raw text the model returned, for a retry prompt. */
  readonly text: string;

  constructor(message: string, text: string) {
    super(message);
    this.text = text;
  }
}

export type ModelConfig = Readonly<Record<LlmRole, string>>;

/** Every role defaults to the cheapest current model (spec §4). */
export const DEFAULT_MODELS: ModelConfig = {
  manifest: "claude-haiku-4-5",
  write: "claude-haiku-4-5",
  tieBreak: "claude-haiku-4-5",
  evalAgent: "claude-haiku-4-5",
  evalJudge: "claude-haiku-4-5",
};

/** Merges a parsed config file over the defaults; throws a ZodError on an invalid file. */
export function resolveModels(configFile: unknown = {}): ModelConfig {
  return { ...DEFAULT_MODELS, ...LlmConfigFile.parse(configFile).models };
}
```

`packages/llm/src/pricing.ts`:
```ts
import type { TokenUsage } from "@repowiki/core";

/** USD per million tokens. Cache writes are the 5-minute TTL rate, the only TTL RepoWiki uses. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** From https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-01). */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/** The Message Batches API bills every token class at half price; it stacks with caching. */
export const BATCH_PRICE_FACTOR = 0.5;

/** Price for a model id, accepting dated ids ("claude-haiku-4-5-20251001"); null if unknown. */
export function priceFor(model: string): ModelPrice | null {
  return MODEL_PRICES[model] ?? MODEL_PRICES[model.replace(/-\d{8}$/, "")] ?? null;
}

/** Dollar cost of one call, or null when the model has no known price. */
export function callCostUsd(model: string, tokens: TokenUsage, batch: boolean): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  const perMillion =
    tokens.in * price.input +
    tokens.out * price.output +
    tokens.cacheWrite * price.cacheWrite +
    tokens.cacheRead * price.cacheRead;
  return (perMillion / 1_000_000) * (batch ? BATCH_PRICE_FACTOR : 1);
}
```

`packages/llm/src/ledger.ts`:
```ts
import { LedgerEntry, type TokenUsage } from "@repowiki/core";
import { callCostUsd } from "./pricing.ts";

export interface LedgerTotals {
  calls: number;
  batchCalls: number;
  tokens: TokenUsage;
  /** Sum over priced calls. */
  usd: number;
  /** Calls whose model has no known price; their tokens are counted but not their cost. */
  unpricedCalls: number;
}

/** Records every provider call (spec §4, F25). */
export interface TokenLedger {
  record(entry: LedgerEntry): void;
  entries(): LedgerEntry[];
  totals(): LedgerTotals;
}

/** An in-memory ledger; `sink` also receives each validated entry (e.g. store.appendLedger). */
export function createLedger(sink?: (entry: LedgerEntry) => void): TokenLedger {
  const recorded: LedgerEntry[] = [];
  return {
    record(entry) {
      const parsed = LedgerEntry.parse(entry);
      sink?.(parsed);
      recorded.push(parsed);
    },
    entries: () => [...recorded],
    totals: () => totalsOf(recorded),
  };
}

export function totalsOf(entries: readonly LedgerEntry[]): LedgerTotals {
  const totals: LedgerTotals = {
    calls: 0,
    batchCalls: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    usd: 0,
    unpricedCalls: 0,
  };
  for (const entry of entries) {
    totals.calls++;
    if (entry.batch) totals.batchCalls++;
    totals.tokens.in += entry.tokens.in;
    totals.tokens.out += entry.tokens.out;
    totals.tokens.cacheRead += entry.tokens.cacheRead;
    totals.tokens.cacheWrite += entry.tokens.cacheWrite;
    const usd = callCostUsd(entry.model, entry.tokens, entry.batch);
    if (usd === null) totals.unpricedCalls++;
    else totals.usd += usd;
  }
  return totals;
}
```

`packages/llm/src/index.ts`:
```ts
export { createLedger, type LedgerTotals, type TokenLedger, totalsOf } from "./ledger.ts";
export {
  BATCH_PRICE_FACTOR,
  callCostUsd,
  MODEL_PRICES,
  type ModelPrice,
  priceFor,
} from "./pricing.ts";
export {
  DEFAULT_MODELS,
  type GenerateRequest,
  type GenerateResult,
  LlmError,
  type LlmMessage,
  LlmOutputError,
  type ModelConfig,
  type Provider,
  resolveModels,
} from "./provider.ts";
```

In `CLAUDE.md`, update the layout:
```markdown
- `packages/llm`, `site`, `cli`, `eval` — added in later milestones
```
with:
```markdown
- `packages/llm` — the `Provider` interface, the Claude implementation (structured output, prompt caching, Message Batches), the `TokenLedger`, and record/replay cassettes
- `site`, `cli`, `eval` — added in later milestones
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (13 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/llm CLAUDE.md pnpm-lock.yaml
git commit -m "feat(llm): add the provider interface, pricing, and token ledger"
```

Ship. PR title: `feat(llm): package, pricing, and ledger`.

---

### Task 6: Record/replay cassettes

**Ticket:** `[M3] llm: record/replay cassettes`

**Files:**
- Create: `packages/llm/src/cassette.ts`
- Modify: `packages/llm/src/index.ts`, `biome.json`, root `package.json` (script), `CLAUDE.md` (commands)
- Test: `packages/llm/src/cassette.test.ts`

**Interfaces:**
- Produces (exported from `@repowiki/llm`):
  ```ts
  type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  interface CassetteEntry { request: { method; path; body: unknown }; response: { status; contentType: string | null; body: string } }
  type CassetteMode = "replay" | "record"
  cassetteMode(): CassetteMode                 // "record" only when REPOWIKI_CASSETTE=record
  cassetteFetch(file: string, mode: CassetteMode, upstream?: FetchLike): FetchLike
  class CassetteMissError extends Error
  ```
- A cassette is a JSON array in a `__cassettes__/` directory next to its test. It holds no headers at all, so no key or auth header can leak. Replay matches on method, path and body (object keys sorted), and identical requests replay in recorded order. Recording replaces the file.
- `pnpm cassettes:record <test files>` runs Vitest in record mode with the repo-root `.env`.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/cassettes
```

- [ ] **Step 2: Write the failing tests**

`packages/llm/src/cassette.test.ts`:
```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CassetteMissError, cassetteFetch, cassetteMode, type FetchLike } from "./cassette.ts";

const dirs: string[] = [];
function tempCassette(): string {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-cassette-"));
  dirs.push(dir);
  return join(dir, "nested", "exchange.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the real API that numbers its answers. */
function upstream(): FetchLike & { calls: number } {
  const fake = Object.assign(
    async (_input: string | URL | Request, _init?: RequestInit) => {
      fake.calls++;
      return new Response(JSON.stringify({ answer: fake.calls }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "request-id": "req_secret",
          "set-cookie": "x",
        },
      });
    },
    { calls: 0 },
  );
  return fake;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "x-api-key": "sk-ant-test-key", "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("cassetteFetch", () => {
  it("records method, path, body, status, and content type, and nothing else", async () => {
    const file = tempCassette();
    const fetch = cassetteFetch(file, "record", upstream());
    const response = await fetch("https://api.anthropic.com/v1/messages?beta=true", post({ q: 1 }));
    expect(await response.json()).toEqual({ answer: 1 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([
      {
        request: { method: "POST", path: "/v1/messages?beta=true", body: { q: 1 } },
        response: { status: 200, contentType: "application/json", body: '{"answer":1}' },
      },
    ]);
    expect(readFileSync(file, "utf8")).not.toMatch(/sk-ant|x-api-key|request-id|cookie/);
  });

  it("replays by method, path, and body, whatever the key order", async () => {
    const file = tempCassette();
    const record = cassetteFetch(file, "record", upstream());
    await record("https://api.anthropic.com/v1/messages", post({ a: 1, b: 2 }));
    await record("https://api.anthropic.com/v1/other", { method: "GET" });
    const offline = upstream();
    const replay = cassetteFetch(file, "replay", offline);
    expect(await (await replay("https://x.test/v1/other")).json()).toEqual({ answer: 2 });
    const reordered = await replay("https://x.test/v1/messages", post({ b: 2, a: 1 }));
    expect(await reordered.json()).toEqual({ answer: 1 });
    expect(reordered.headers.get("content-type")).toBe("application/json");
    expect(offline.calls).toBe(0);
  });

  it("replays identical requests in recorded order, each once", async () => {
    const file = tempCassette();
    const record = cassetteFetch(file, "record", upstream());
    for (let i = 0; i < 2; i++)
      await record("https://api.anthropic.com/v1/poll", { method: "GET" });
    const replay = cassetteFetch(file, "replay");
    const answers = [];
    for (let i = 0; i < 2; i++) answers.push(await (await replay("https://a.test/v1/poll")).json());
    expect(answers).toEqual([{ answer: 1 }, { answer: 2 }]);
    await expect(replay("https://a.test/v1/poll")).rejects.toThrow(CassetteMissError);
  });

  it("fails loudly on a request it has no recording for", async () => {
    const replay = cassetteFetch(tempCassette(), "replay");
    await expect(replay("https://a.test/v1/messages", post({ q: 2 }))).rejects.toThrow(
      /no unused recording for POST \/v1\/messages; re-record with pnpm cassettes:record/,
    );
  });
});

describe("cassetteMode", () => {
  it("records only when REPOWIKI_CASSETTE=record", () => {
    const saved = process.env.REPOWIKI_CASSETTE;
    try {
      process.env.REPOWIKI_CASSETTE = "record";
      expect(cassetteMode()).toBe("record");
      process.env.REPOWIKI_CASSETTE = "yes";
      expect(cassetteMode()).toBe("replay");
      delete process.env.REPOWIKI_CASSETTE;
      expect(cassetteMode()).toBe("replay");
    } finally {
      if (saved === undefined) delete process.env.REPOWIKI_CASSETTE;
      else process.env.REPOWIKI_CASSETTE = saved;
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/llm/src/cassette.test.ts`
Expected: FAIL, because `./cassette.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/llm/src/cassette.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One recorded HTTP exchange. Only the method, path, and JSON body of the request are kept, and
 * only the status, content type, and body of the response: no headers, so no API key, ever.
 */
export interface CassetteEntry {
  request: { method: string; path: string; body: unknown };
  response: { status: number; contentType: string | null; body: string };
}

export type CassetteMode = "replay" | "record";

/** "record" only when REPOWIKI_CASSETTE=record; every other run, CI included, replays. */
export function cassetteMode(): CassetteMode {
  return process.env.REPOWIKI_CASSETTE === "record" ? "record" : "replay";
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class CassetteMissError extends Error {
  constructor(file: string, method: string, path: string) {
    super(
      `${file} has no unused recording for ${method} ${path}; re-record with pnpm cassettes:record`,
    );
    this.name = new.target.name;
  }
}

/** JSON with object keys sorted, so key order never decides whether a request matches. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function parseBody(body: RequestInit["body"]): unknown {
  if (body === undefined || body === null) return null;
  if (typeof body !== "string") throw new Error("cassettes only support string request bodies");
  return JSON.parse(body);
}

/**
 * A fetch that replays exchanges from `file`, or in record mode forwards to `upstream` and writes
 * every exchange to `file` (replacing its previous contents). Identical requests replay in order.
 */
export function cassetteFetch(
  file: string,
  mode: CassetteMode,
  upstream: FetchLike = fetch,
): FetchLike {
  const entries: CassetteEntry[] =
    mode === "replay" && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const used = new Set<number>();
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = `${url.pathname}${url.search}`;
    const body = parseBody(init?.body);
    if (mode === "replay") {
      const key = canonical({ method, path, body });
      const index = entries.findIndex(
        (entry, i) => !used.has(i) && canonical(entry.request) === key,
      );
      const entry = entries[index];
      if (entry === undefined) throw new CassetteMissError(file, method, path);
      used.add(index);
      return toResponse(entry);
    }
    const response = await upstream(input, init);
    const recorded: CassetteEntry = {
      request: { method, path, body },
      response: {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.text(),
      },
    };
    entries.push(recorded);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
    return toResponse(recorded);
  };
}

function toResponse({ response }: CassetteEntry): Response {
  const headers =
    response.contentType === null ? undefined : { "content-type": response.contentType };
  return new Response(response.body, { status: response.status, headers });
}
```

Replace `packages/llm/src/index.ts` with:
```ts
export {
  type CassetteEntry,
  CassetteMissError,
  type CassetteMode,
  cassetteFetch,
  cassetteMode,
  type FetchLike,
} from "./cassette.ts";
export { createLedger, type LedgerTotals, type TokenLedger, totalsOf } from "./ledger.ts";
export {
  BATCH_PRICE_FACTOR,
  callCostUsd,
  MODEL_PRICES,
  type ModelPrice,
  priceFor,
} from "./pricing.ts";
export {
  DEFAULT_MODELS,
  type GenerateRequest,
  type GenerateResult,
  LlmError,
  type LlmMessage,
  LlmOutputError,
  type ModelConfig,
  type Provider,
  resolveModels,
} from "./provider.ts";
```

Cassettes are written by `JSON.stringify`, not Biome, so keep Biome out of them. In `biome.json`, replace:
```json
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
```
with:
```json
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/__cassettes__"] },
```

Add to the root `package.json` `scripts`: `"cassettes:record": "REPOWIKI_CASSETTE=record node --env-file=.env node_modules/vitest/vitest.mjs run"`.

In `CLAUDE.md`, add the command:
```markdown
- `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm format`
```
with:
```markdown
- `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm format`
- `pnpm cassettes:record <test files>` — re-record LLM cassettes live (needs `ANTHROPIC_API_KEY` in `.env`; costs money; review the diff)
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (5 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/llm biome.json package.json CLAUDE.md
git commit -m "feat(llm): record and replay HTTP exchanges as cassettes"
```

Ship. PR title: `feat(llm): record/replay cassettes`.

---

### Task 7: Message Batches client

**Ticket:** `[M3] llm: Message Batches client`

**Files:**
- Create: `packages/llm/src/batcher.ts`, `packages/llm/src/canned.ts` (test support)
- Modify: `packages/llm/package.json` (SDK dependency), `packages/llm/src/index.ts`, `pnpm-lock.yaml`
- Test: `packages/llm/src/batcher.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface BatchProgress { id: string; status: string; processing: number; succeeded: number; errored: number }   // exported
  interface BatcherOptions { pollIntervalMs: number; onProgress?: (progress: BatchProgress) => void }
  type Batcher = (params: MessageCreateParamsNonStreaming) => Promise<Message>
  createBatcher(client: Anthropic, options: BatcherOptions): Batcher
  // test-only (canned.ts): cannedMessageBody, cannedMessagesApi, cannedBatchApi, succeededLine
  ```
- Calls made in the same tick share one `client.messages.batches.create`, with `custom_id`s `req-0`, `req-1`, … in call order. The batcher polls `retrieve` until `ended`, then reads `results`. Each request settles on its own (errored, expired, or missing items reject only their own promise), and a failure of the batch itself rejects them all.

- [ ] **Step 1: Branch and add the SDK**

`@anthropic-ai/sdk` is the official client: MIT, about 49M downloads a week, published 2026-09-30. 0.131.0 is the current version (`npm view @anthropic-ai/sdk version`). Its only dependencies are `json-schema-to-ts` and `standardwebhooks`, and it takes `zod` ^3.25 or ^4 as a peer, which the package already has.

```bash
git switch -c m3/llm-batcher
pnpm --filter @repowiki/llm add --save-exact @anthropic-ai/sdk@0.131.0
```

- [ ] **Step 2: Add the canned API and write the failing tests**

`canned.ts` fakes the documented Messages and Batches response shapes, for tests that need exact control over what the API answers. It is test support, like `test-repo.ts` in the index module.

`packages/llm/src/canned.ts`:
```ts
import type { FetchLike } from "./cassette.ts";

/** A Messages API response body with one text block. Test-only. */
export function cannedMessageBody(text: string, stopReason = "end_turn") {
  return {
    id: "msg_canned",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Answers every Messages API call with one canned message and keeps each request body. */
export function cannedMessagesApi(text: string, stopReason = "end_turn") {
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json(cannedMessageBody(text, stopReason));
  };
  return { bodies, fetch };
}

/**
 * The Batches API as canned routes: the create call answers "in_progress", every later status
 * call "ended", and the results URL serves `results` as JSONL. POST bodies are kept. Test-only.
 */
export function cannedBatchApi(results: unknown[]) {
  const posts: Record<string, unknown>[] = [];
  const batch = (status: "in_progress" | "ended") => ({
    id: "msgbatch_canned",
    type: "message_batch",
    processing_status: status,
    request_counts: {
      processing: status === "ended" ? 0 : 2,
      succeeded: 0,
      errored: 0,
      canceled: 0,
      expired: 0,
    },
    results_url:
      status === "ended"
        ? "https://api.anthropic.com/v1/messages/batches/msgbatch_canned/results"
        : null,
    created_at: "2026-10-01T12:00:00Z",
    ended_at: null,
    expires_at: "2026-10-02T12:00:00Z",
    archived_at: null,
    cancel_initiated_at: null,
  });
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path.endsWith("/results")) {
      return new Response(results.map((line) => JSON.stringify(line)).join("\n"), {
        status: 200,
        headers: { "content-type": "application/x-jsonl" },
      });
    }
    if (init?.method !== "POST") return json(batch("ended"));
    posts.push(JSON.parse(String(init.body)));
    return json(batch("in_progress"));
  };
  return { fetch, posts };
}

/** One line of a batch results file for a request that succeeded. */
export const succeededLine = (customId: string, text: string) => ({
  custom_id: customId,
  result: { type: "succeeded", message: cannedMessageBody(text) },
});
```

`packages/llm/src/batcher.test.ts`:
```ts
import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it } from "vitest";
import { type BatchProgress, createBatcher } from "./batcher.ts";
import { cannedBatchApi, succeededLine } from "./canned.ts";

const params = (content: string): MessageCreateParamsNonStreaming => ({
  model: "claude-haiku-4-5",
  max_tokens: 50,
  messages: [{ role: "user", content }],
});

function setup(results: unknown[]) {
  const api = cannedBatchApi(results);
  const progress: BatchProgress[] = [];
  const client = new Anthropic({ apiKey: "canned", fetch: api.fetch, maxRetries: 0 });
  const batcher = createBatcher(client, { pollIntervalMs: 0, onProgress: (p) => progress.push(p) });
  return { batcher, posts: api.posts, progress };
}

describe("createBatcher", () => {
  it("sends requests made in the same tick as one batch, with stable custom ids", async () => {
    const { batcher, posts, progress } = setup([
      succeededLine("req-1", "b"),
      succeededLine("req-0", "a"),
    ]);
    const [a, b] = await Promise.all([batcher(params("first")), batcher(params("second"))]);
    expect(posts).toEqual([
      {
        requests: [
          { custom_id: "req-0", params: params("first") },
          { custom_id: "req-1", params: params("second") },
        ],
      },
    ]);
    expect([a.content, b.content]).toEqual([
      [{ type: "text", text: "a" }],
      [{ type: "text", text: "b" }],
    ]);
    expect(progress).toEqual([
      { id: "msgbatch_canned", status: "in_progress", processing: 2, succeeded: 0, errored: 0 },
    ]);
  });

  it("starts a new batch for a request made in a later tick", async () => {
    const { batcher, posts } = setup([succeededLine("req-0", "a")]);
    await batcher(params("first"));
    await batcher(params("second"));
    expect(posts).toHaveLength(2);
  });

  it("rejects only the items that errored, expired, or have no result", async () => {
    const { batcher } = setup([
      succeededLine("req-0", "a"),
      {
        custom_id: "req-1",
        result: {
          type: "errored",
          error: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        },
      },
      { custom_id: "req-2", result: { type: "expired" } },
    ]);
    const settled = await Promise.allSettled(["a", "b", "c", "d"].map((q) => batcher(params(q))));
    expect(settled.map((s) => (s.status === "fulfilled" ? "ok" : String(s.reason)))).toEqual([
      "ok",
      "LlmError: batch msgbatch_canned request req-1 did not succeed: overloaded_error",
      "LlmError: batch msgbatch_canned request req-2 did not succeed: expired",
      "LlmError: batch msgbatch_canned request req-3 did not succeed: missing",
    ]);
  });

  it("rejects every item when the batch itself cannot be created", async () => {
    const refusal = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "bad request" },
    });
    const client = new Anthropic({
      apiKey: "canned",
      maxRetries: 0,
      fetch: async () =>
        new Response(refusal, { status: 400, headers: { "content-type": "application/json" } }),
    });
    const batcher = createBatcher(client, { pollIntervalMs: 0 });
    const settled = await Promise.allSettled([batcher(params("a")), batcher(params("b"))]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/llm/src/batcher.test.ts`
Expected: FAIL, because `./batcher.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/llm/src/batcher.ts`:
```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageBatchResult } from "@anthropic-ai/sdk/resources/messages/batches";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { LlmError } from "./provider.ts";

export interface BatchProgress {
  id: string;
  status: string;
  processing: number;
  succeeded: number;
  errored: number;
}

export interface BatcherOptions {
  /** Wait between status polls while the batch is in progress. */
  pollIntervalMs: number;
  onProgress?: (progress: BatchProgress) => void;
}

/** Sends one request through the Message Batches API and resolves with its message. */
export type Batcher = (params: MessageCreateParamsNonStreaming) => Promise<Message>;

interface Queued {
  params: MessageCreateParamsNonStreaming;
  resolve: (message: Message) => void;
  reject: (error: unknown) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Requests made in the same tick of the event loop go out together as one Message Batch (half
 * price). Each request settles on its own: an errored, expired, or missing item rejects only its
 * own promise; a failure of the batch itself rejects them all.
 */
export function createBatcher(client: Anthropic, options: BatcherOptions): Batcher {
  let queue: Queued[] = [];

  const run = async (items: Queued[]): Promise<void> => {
    try {
      let batch = await client.messages.batches.create({
        requests: items.map((item, i) => ({ custom_id: `req-${i}`, params: item.params })),
      });
      while (batch.processing_status !== "ended") {
        options.onProgress?.({
          id: batch.id,
          status: batch.processing_status,
          processing: batch.request_counts.processing,
          succeeded: batch.request_counts.succeeded,
          errored: batch.request_counts.errored,
        });
        await sleep(options.pollIntervalMs);
        batch = await client.messages.batches.retrieve(batch.id);
      }
      const results = new Map<string, MessageBatchResult>();
      for await (const line of await client.messages.batches.results(batch.id)) {
        results.set(line.custom_id, line.result);
      }
      items.forEach((item, i) => {
        const result = results.get(`req-${i}`);
        if (result?.type === "succeeded") {
          item.resolve(result.message);
          return;
        }
        const why =
          result?.type === "errored" ? result.error.error.type : (result?.type ?? "missing");
        item.reject(new LlmError(`batch ${batch.id} request req-${i} did not succeed: ${why}`));
      });
    } catch (error) {
      for (const item of items) item.reject(error);
    }
  };

  return (params) =>
    new Promise((resolve, reject) => {
      if (queue.length === 0) {
        setImmediate(() => {
          const items = queue;
          queue = [];
          void run(items);
        });
      }
      queue.push({ params, resolve, reject });
    });
}
```

Replace `packages/llm/src/index.ts` with:
```ts
export type { BatchProgress } from "./batcher.ts";
export {
  type CassetteEntry,
  CassetteMissError,
  type CassetteMode,
  cassetteFetch,
  cassetteMode,
  type FetchLike,
} from "./cassette.ts";
export { createLedger, type LedgerTotals, type TokenLedger, totalsOf } from "./ledger.ts";
export {
  BATCH_PRICE_FACTOR,
  callCostUsd,
  MODEL_PRICES,
  type ModelPrice,
  priceFor,
} from "./pricing.ts";
export {
  DEFAULT_MODELS,
  type GenerateRequest,
  type GenerateResult,
  LlmError,
  type LlmMessage,
  LlmOutputError,
  type ModelConfig,
  type Provider,
  resolveModels,
} from "./provider.ts";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (4 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/llm pnpm-lock.yaml
git commit -m "feat(llm): send same-tick requests as one Message Batch"
```

Ship. PR title: `feat(llm): Message Batches client`.

---

### Task 8: Claude provider

**Ticket:** `[M3] llm: Claude provider`

**Files:**
- Create: `packages/llm/src/claude.ts`
- Modify: `packages/llm/src/index.ts`
- Test: `packages/llm/src/claude.test.ts`

**Interfaces:**
- Consumes: `createBatcher`, `BatchProgress` (Task 7); `FetchLike` (Task 6); `TokenLedger`, `Provider`, errors (Task 5).
- Produces (exported from `@repowiki/llm`):
  ```ts
  interface ClaudeProviderOptions { models: ModelConfig; ledger: TokenLedger; runId: string; apiKey?: string; fetch?: FetchLike; pollIntervalMs?: number; onBatchProgress?: (p: BatchProgress) => void; now?: () => Date }
  createClaudeProvider(options: ClaudeProviderOptions): Provider
  ```
- Behaviour, all from the bundled Claude API docs:
  - **Structured output.** Haiku 4.5 supports structured outputs, so the request carries `output_config.format` built by the SDK's `zodOutputFormat(schema)`, which strips constraints the API rejects. The answer is then parsed with the full zod schema. No forced tool call is needed, and no `thinking` is sent: Haiku 4.5 predates adaptive thinking.
  - **Caching.** With a `cacheKey`, the single system block gets `cache_control: { type: "ephemeral" }` (5-minute TTL). Haiku 4.5 caches only prefixes of at least 4096 tokens; anything shorter silently isn't cached, at no cost. A `cacheKey` reused with a different model or system text throws `LlmError` before any request is sent, because that is exactly the silent invalidator the caching docs warn about.
  - **Batching.** `batch: true` goes through `createBatcher`.
  - **Ledger and errors.** Every answered call is ledgered (the API-reported model, the request's purpose, featureId, batch and cacheKey) before its output is checked, so tokens spent on a bad answer are still counted. A `stop_reason` other than `end_turn`, non-JSON text, or a schema mismatch throws `LlmOutputError` carrying the raw text.
  - **Retries.** The SDK client uses `maxRetries: 2`: one attempt plus two retries with backoff on 429, 5xx and network errors, which is spec §6.3's "at most 3 attempts".
  - **Key.** It is read from `ANTHROPIC_API_KEY` (or `apiKey`); without one, construction throws.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/claude-provider
```

- [ ] **Step 2: Write the failing tests**

`packages/llm/src/claude.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cannedBatchApi, cannedMessagesApi, succeededLine } from "./canned.ts";
import type { FetchLike } from "./cassette.ts";
import { createClaudeProvider } from "./claude.ts";
import { createLedger } from "./ledger.ts";
import { DEFAULT_MODELS, LlmError, LlmOutputError } from "./provider.ts";

const Capital = z.object({ city: z.string(), country: z.string() });
const PARIS = '{"city":"Paris","country":"France"}';

function setup(fetch: FetchLike, models = DEFAULT_MODELS) {
  const ledger = createLedger();
  const provider = createClaudeProvider({
    models,
    ledger,
    runId: "test-run",
    apiKey: "canned",
    fetch,
    pollIntervalMs: 0,
    now: () => new Date("2026-10-01T12:00:00Z"),
  });
  return { ledger, provider };
}

const request = {
  purpose: "manifest" as const,
  system: "Answer with JSON only.",
  messages: [{ role: "user" as const, content: "What is the capital of France?" }],
  schema: Capital,
  maxTokens: 50,
};

describe("createClaudeProvider", () => {
  it("asks for JSON matching the schema with the role's model, and ledgers the call", async () => {
    const { bodies, fetch } = cannedMessagesApi(PARIS);
    const { ledger, provider } = setup(fetch, { ...DEFAULT_MODELS, write: "claude-sonnet-5-5" });
    const result = await provider.generate({ ...request, purpose: "write", featureId: "capitals" });
    expect(result).toEqual({
      output: { city: "Paris", country: "France" },
      usage: { in: 12, out: 5, cacheRead: 0, cacheWrite: 0 },
      model: "claude-haiku-4-5-20251001",
    });
    expect(bodies[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 50,
      system: [{ type: "text", text: "Answer with JSON only." }],
      messages: [{ role: "user", content: "What is the capital of France?" }],
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(ledger.entries()).toEqual([
      {
        runId: "test-run",
        at: "2026-10-01T12:00:00.000Z",
        purpose: "write",
        model: "claude-haiku-4-5-20251001",
        featureId: "capitals",
        batch: false,
        cacheKey: null,
        tokens: { in: 12, out: 5, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it("marks the system prompt for caching only when a cacheKey is given", async () => {
    const { bodies, fetch } = cannedMessagesApi(PARIS);
    const { ledger, provider } = setup(fetch);
    await provider.generate(request);
    await provider.generate({ ...request, cacheKey: "capitals" });
    const marks = bodies.map((b) => (b.system as { cache_control?: unknown }[])[0]?.cache_control);
    expect(marks).toEqual([undefined, { type: "ephemeral" }]);
    expect(ledger.entries().map((e) => e.cacheKey)).toEqual([null, "capitals"]);
  });

  it("refuses a cacheKey reused with a different prefix, before calling the API", async () => {
    const { bodies, fetch } = cannedMessagesApi(PARIS);
    const { provider } = setup(fetch);
    await provider.generate({ ...request, cacheKey: "k" });
    const changed = provider.generate({ ...request, system: "changed", cacheKey: "k" });
    await expect(changed).rejects.toThrow(LlmError);
    expect(bodies).toHaveLength(1);
  });

  it.each([
    ["text that is not JSON", "Paris", "end_turn", /not JSON/],
    ["JSON that misses the schema", '{"city":"Paris"}', "end_turn", /country/],
    ["a truncated answer", '{"city":', "max_tokens", /max_tokens/],
  ])("rejects %s with LlmOutputError and still ledgers the tokens", async (_n, text, stop, why) => {
    const { ledger, provider } = setup(cannedMessagesApi(text, stop).fetch);
    const failure = provider.generate(request);
    await expect(failure).rejects.toThrow(LlmOutputError);
    await expect(failure).rejects.toThrow(why);
    await expect(failure).rejects.toHaveProperty("text", text);
    expect(ledger.entries()).toHaveLength(1);
  });

  it("routes batch requests through the Batches API and ledgers them as batched", async () => {
    const { fetch, posts } = cannedBatchApi([succeededLine("req-0", PARIS)]);
    const { ledger, provider } = setup(fetch);
    const result = await provider.generate({ ...request, batch: true });
    expect(result.output.city).toBe("Paris");
    expect(posts).toHaveLength(1);
    expect(ledger.entries().map((e) => e.batch)).toEqual([true]);
  });

  it("refuses to start without an API key", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() =>
        createClaudeProvider({ models: DEFAULT_MODELS, ledger: createLedger(), runId: "r" }),
      ).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/llm/src/claude.test.ts`
Expected: FAIL, because `./claude.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/llm/src/claude.ts`:
```ts
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { TokenUsage } from "@repowiki/core";
import { type BatchProgress, createBatcher } from "./batcher.ts";
import type { FetchLike } from "./cassette.ts";
import type { TokenLedger } from "./ledger.ts";
import {
  type GenerateRequest,
  LlmError,
  LlmOutputError,
  type ModelConfig,
  type Provider,
} from "./provider.ts";

export interface ClaudeProviderOptions {
  models: ModelConfig;
  ledger: TokenLedger;
  runId: string;
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Replaces global fetch, e.g. with a cassette in tests. */
  fetch?: FetchLike;
  /** Wait between batch status polls. Default 30 seconds. */
  pollIntervalMs?: number;
  onBatchProgress?: (progress: BatchProgress) => void;
  now?: () => Date;
}

function usageOf(message: Message): TokenUsage {
  return {
    in: message.usage.input_tokens,
    out: message.usage.output_tokens,
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
    cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * The Claude API provider. Output is structured JSON (output_config.format, which Haiku 4.5
 * supports); no thinking is requested. A cacheKey puts a cache breakpoint on the system prompt.
 */
export function createClaudeProvider(options: ClaudeProviderOptions): Provider {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new LlmError("ANTHROPIC_API_KEY is not set; run with node --env-file=.env");
  }
  // The SDK retries 429, 5xx, and network errors with backoff: 1 try + 2 retries = spec §6.3.
  const client = new Anthropic({ apiKey, maxRetries: 2, fetch: options.fetch });
  const batcher = createBatcher(client, {
    pollIntervalMs: options.pollIntervalMs ?? 30_000,
    onProgress: options.onBatchProgress,
  });
  const now = options.now ?? (() => new Date());
  const prefixes = new Map<string, string>();

  return {
    async generate<T>(request: GenerateRequest<T>) {
      const model = options.models[request.purpose];
      if (request.cacheKey !== undefined) {
        const prefix = createHash("sha256").update(`${model}\0${request.system}`).digest("hex");
        const seen = prefixes.get(request.cacheKey);
        if (seen !== undefined && seen !== prefix) {
          throw new LlmError(`cacheKey ${request.cacheKey} was reused with a different prefix`);
        }
        prefixes.set(request.cacheKey, prefix);
      }
      const { type, schema } = zodOutputFormat(request.schema);
      const params: MessageCreateParamsNonStreaming = {
        model,
        max_tokens: request.maxTokens,
        system: [
          {
            type: "text",
            text: request.system,
            ...(request.cacheKey === undefined ? {} : { cache_control: { type: "ephemeral" } }),
          },
        ],
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: { format: { type, schema } },
      };
      const batch = request.batch === true;
      const message = batch ? await batcher(params) : await client.messages.create(params);
      const usage = usageOf(message);
      options.ledger.record({
        runId: options.runId,
        at: now().toISOString(),
        purpose: request.purpose,
        model: message.model,
        featureId: request.featureId ?? null,
        batch,
        cacheKey: request.cacheKey ?? null,
        tokens: usage,
      });
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      if (message.stop_reason !== "end_turn") {
        throw new LlmOutputError(`model stopped with ${message.stop_reason}`, text);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmOutputError("model output is not JSON", text);
      }
      const parsed = request.schema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        throw new LlmOutputError(
          `model output does not match the schema: ${issues.join("; ")}`,
          text,
        );
      }
      return { output: parsed.data, usage, model: message.model };
    },
  };
}
```

Replace `packages/llm/src/index.ts` with:
```ts
export type { BatchProgress } from "./batcher.ts";
export {
  type CassetteEntry,
  CassetteMissError,
  type CassetteMode,
  cassetteFetch,
  cassetteMode,
  type FetchLike,
} from "./cassette.ts";
export { type ClaudeProviderOptions, createClaudeProvider } from "./claude.ts";
export { createLedger, type LedgerTotals, type TokenLedger, totalsOf } from "./ledger.ts";
export {
  BATCH_PRICE_FACTOR,
  callCostUsd,
  MODEL_PRICES,
  type ModelPrice,
  priceFor,
} from "./pricing.ts";
export {
  DEFAULT_MODELS,
  type GenerateRequest,
  type GenerateResult,
  LlmError,
  type LlmMessage,
  LlmOutputError,
  type ModelConfig,
  type Provider,
  resolveModels,
} from "./provider.ts";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (8 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/llm
git commit -m "feat(llm): add the Claude provider with structured output and caching"
```

Ship. PR title: `feat(llm): Claude provider`.

---

### Task 9: Recorded Claude cassettes

**Ticket:** `[M3] llm: recorded Claude cassettes`

**Files:**
- Create: `packages/llm/src/claude.cassette.test.ts`, and by recording `packages/llm/src/__cassettes__/{structured-output,prompt-cache,batch}.json`

**Interfaces:**
- Consumes: `createClaudeProvider` (Task 8), `cassetteFetch` (Task 6).
- Produces: three committed cassettes that prove, against the real API, that structured output parses, that a second call with the same 4096+-token prefix reads the cache, and that same-tick batched calls share one batch. CI replays them and never calls the API.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/claude-cassettes
```

- [ ] **Step 2: Write the tests**

`packages/llm/src/claude.cassette.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cassetteFetch, cassetteMode } from "./cassette.ts";
import { createClaudeProvider } from "./claude.ts";
import { createLedger } from "./ledger.ts";
import { DEFAULT_MODELS } from "./provider.ts";

const mode = cassetteMode();
/** A live batch can take many minutes; a replay finishes at once. */
const BATCH_TIMEOUT_MS = mode === "record" ? 3_600_000 : 5_000;
const cassette = (name: string) =>
  fileURLToPath(new URL(`./__cassettes__/${name}.json`, import.meta.url));

function setup(name: string) {
  const ledger = createLedger();
  const provider = createClaudeProvider({
    models: DEFAULT_MODELS,
    ledger,
    runId: "test-run",
    // Replays never reach the API, but the SDK still wants a credential.
    apiKey: mode === "record" ? undefined : "cassette-replay",
    fetch: cassetteFetch(cassette(name), mode),
    pollIntervalMs: mode === "record" ? 60_000 : 0,
    now: () => new Date("2026-10-01T12:00:00Z"),
  });
  return { ledger, provider };
}

/** Deterministic filler, well above Haiku 4.5's 4096-token minimum cacheable prefix. */
const GLOSSARY = Array.from(
  { length: 320 },
  (_, i) =>
    `Term ${String(i).padStart(3, "0")}: entry ${i} of the RepoWiki test glossary, describing component number ${i * 7} and its neighbour ${i * 7 + 3}.`,
).join("\n");

const Capital = z.object({ city: z.string(), country: z.string() });

describe("createClaudeProvider against recorded Claude API exchanges", () => {
  it("returns schema-checked JSON output", async () => {
    const { ledger, provider } = setup("structured-output");
    const result = await provider.generate({
      purpose: "manifest",
      system: "Answer with JSON only.",
      messages: [{ role: "user", content: "What is the capital of France?" }],
      schema: Capital,
      maxTokens: 200,
    });
    expect(result.output.city).toBe("Paris");
    expect(result.model).toMatch(/^claude-haiku-4-5/);
    expect(ledger.entries()[0]?.tokens.in).toBeGreaterThan(0);
  });

  it("caches a long prefix: the second call reads what the first wrote", async () => {
    const { ledger, provider } = setup("prompt-cache");
    const ask = (n: number) =>
      provider.generate({
        purpose: "write",
        system: `Use this glossary to answer.\n\n${GLOSSARY}`,
        messages: [{ role: "user", content: `Which component does term ${n} describe?` }],
        schema: z.object({ component: z.number() }),
        maxTokens: 100,
        cacheKey: "glossary",
      });
    expect((await ask(10)).output.component).toBe(70);
    expect((await ask(20)).output.component).toBe(140);
    const [first, second] = ledger.entries().map((e) => e.tokens);
    // A re-recording within five minutes of the last one reads instead of writing.
    expect((first?.cacheWrite ?? 0) + (first?.cacheRead ?? 0)).toBeGreaterThan(4096);
    expect(second?.cacheRead).toBeGreaterThan(4096);
  });

  it(
    "sends calls made in the same tick as one Message Batch",
    async () => {
      const { ledger, provider } = setup("batch");
      const ask = (country: string) =>
        provider.generate({
          purpose: "manifest",
          featureId: "capitals",
          system: "Answer with JSON only.",
          messages: [{ role: "user", content: `What is the capital of ${country}?` }],
          schema: Capital,
          maxTokens: 200,
          batch: true,
        });
      const [japan, peru] = await Promise.all([ask("Japan"), ask("Peru")]);
      expect(japan.output.city).toBe("Tokyo");
      expect(peru.output.city).toBe("Lima");
      expect(ledger.entries().map((e) => [e.batch, e.featureId])).toEqual([
        [true, "capitals"],
        [true, "capitals"],
      ]);
    },
    BATCH_TIMEOUT_MS,
  );

  it("keeps API keys and auth headers out of every cassette", () => {
    for (const name of ["structured-output", "prompt-cache", "batch"]) {
      expect(readFileSync(cassette(name), "utf8")).not.toMatch(/sk-ant|x-api-key|authorization/i);
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail without recordings**

Run: `pnpm vitest run packages/llm/src/claude.cassette.test.ts`
Expected: FAIL: the three API tests throw `CassetteMissError` ("… has no unused recording for POST /v1/messages; re-record with pnpm cassettes:record") and the scrub test cannot open the files.

- [ ] **Step 4: Record the cassettes live**

This needs `ANTHROPIC_API_KEY` in the repo-root `.env`. That file is gitignored: never print it, never commit it. It costs about $0.02, and it takes as long as the Batches API needs to finish a 2-request batch, which was 4 to 15 minutes in the prototype. The batch test allows an hour while recording.

```bash
pnpm cassettes:record packages/llm/src/claude.cassette.test.ts
```

Expected: 4 tests pass in record mode. Then check what was recorded:
- `grep -ciE 'sk-ant|x-api-key|authorization' packages/llm/src/__cassettes__/*.json` prints 0 for every file.
- In `prompt-cache.json`, the first response's `usage.cache_creation_input_tokens` is about 10,770, unless a recording in the previous 5 minutes left the prefix warm, in which case it is `cache_read_input_tokens` instead. The second response's `cache_read_input_tokens` is the same number.
- In `batch.json`, there is one POST to `/v1/messages/batches`, a run of GETs with `processing_status: "in_progress"`, and one `results` GET with `content-type: application/x-jsonl`, whose messages have `"service_tier":"batch"`.
If Haiku answered a question wrongly (say, the glossary lookup), re-run the recording; don't loosen the test.

- [ ] **Step 5: Run the check (replay) to verify it passes**

Run: `pnpm check`
Expected: PASS (4 new tests), with no network access needed.

- [ ] **Step 6: Commit and ship**

```bash
git add packages/llm/src
git commit -m "test(llm): record Claude cassettes for output, caching, and batching"
```

Ship. PR title: `test(llm): recorded Claude cassettes`. In the PR body, give the recorded usage numbers (input, output, cache-write and cache-read tokens per call).

---

### Task 10: File graph

**Ticket:** `[M3] cluster: file graph`

**Files:**
- Create: `packages/engine/src/cluster/graph.ts`, `packages/engine/src/cluster/test-index.ts` (test support)
- Test: `packages/engine/src/cluster/graph.test.ts`

**Interfaces:**
- Consumes: `RepoIndex`, `ImportEdge`, `CoChangePair` from `../index/index.ts` (M2 Task 9).
- Produces:
  ```ts
  interface WeightedEdge { a: string; b: string; weight: number }   // repo paths, a < b
  interface FileGraph { nodes: string[]; edges: WeightedEdge[] }   // nodes: every indexed file, sorted; edges sorted by (a, b)
  interface GraphWeights { import: number; coChange: number; directory: number; minCoChangeCount: number; hubInDegree: number }
  const DEFAULT_GRAPH_WEIGHTS = { import: 1, coChange: 2, directory: 0.3, minCoChangeCount: 2, hubInDegree: 4 }
  buildFileGraph(index: RepoIndex, weights?: GraphWeights): FileGraph
  makeIndex(paths, edges?: { imports?: [from, to][]; coChange?: [a, b, count][] }): RepoIndex   // test-only
  ```
- How the edge weights are built (spec F04, §4):
  - Each resolved import adds `import`, so a mutual import adds twice. An import into a hub, a file that more than `hubInDegree` files import, is scaled by `hubInDegree / inDegree`. Without that, barrels (`index.ts`) and shared test fixtures pull unrelated files into one cluster; M2's final review flagged `core/src/test-fixtures.ts` and `core/src/index.ts` as the top hubs of the self-index. Scaled down, hubs cluster with their directory and co-change partners instead.
  - A co-changed pair adds `coChange × count / (commits(a) + commits(b) − count)`, the Jaccard similarity of the two files' commit sets, but only when `count ≥ minCoChangeCount`. One shared commit is noise.
  - Directory siblings share `directory` between them, `directory / (n − 1)` per pair, so the directory signal stays weak however large the directory is.
  - Non-code files have no imports, so they join only through co-change and their directory.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/cluster-graph
```

- [ ] **Step 2: Add the index builder and write the failing tests**

`test-index.ts` builds a `RepoIndex` by hand, so cluster tests don't need git. It is test support.

`packages/engine/src/cluster/test-index.ts`:
```ts
import { memberId } from "@repowiki/core";
import type { CoChangePair, ImportEdge, RepoIndex } from "../index/index.ts";

/** A hand-built RepoIndex: file-level files only, with the given edges. Test-only. */
export function makeIndex(
  paths: readonly string[],
  edges: { imports?: [string, string][]; coChange?: [string, string, number][] } = {},
): RepoIndex {
  const imports: ImportEdge[] = (edges.imports ?? []).map(([from, to]) => ({ from, to, line: 1 }));
  const pairs: CoChangePair[] = (edges.coChange ?? []).map(([a, b, count]) => ({ a, b, count }));
  const fileCommits: Record<string, number> = {};
  for (const { a, b, count } of pairs) {
    fileCommits[a] = Math.max(fileCommits[a] ?? 0, count);
    fileCommits[b] = Math.max(fileCommits[b] ?? 0, count);
  }
  return {
    sha: "a".repeat(40),
    files: [...paths].sort().map((path) => ({
      id: memberId(path),
      path,
      language: null,
      bytes: 1,
      loc: 1,
      skipped: null,
      parseError: false,
      symbols: [],
    })),
    imports,
    unresolved: [],
    coChange: { commitsConsidered: pairs.length, commitsSkipped: 0, fileCommits, pairs },
    invalidPaths: [],
  };
}
```

`packages/engine/src/cluster/graph.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildFileGraph } from "./graph.ts";
import { makeIndex } from "./test-index.ts";

const weightOf = (graph: ReturnType<typeof buildFileGraph>, a: string, b: string) =>
  graph.edges.find((e) => e.a === a && e.b === b)?.weight;

describe("buildFileGraph", () => {
  it("has a node for every file, code or not, sorted", () => {
    const graph = buildFileGraph(makeIndex(["web/app.ts", "README.md", "api/main.py"]));
    expect(graph.nodes).toEqual(["README.md", "api/main.py", "web/app.ts"]);
  });

  it("weighs an import 1 and a mutual import 2", () => {
    const index = makeIndex(["a/x.py", "b/y.py", "c/z.py"], {
      imports: [
        ["a/x.py", "b/y.py"],
        ["b/y.py", "a/x.py"],
        ["c/z.py", "a/x.py"],
      ],
    });
    const graph = buildFileGraph(index);
    expect(weightOf(graph, "a/x.py", "b/y.py")).toBe(2);
    expect(weightOf(graph, "a/x.py", "c/z.py")).toBe(1);
  });

  it("scales down imports into a hub that more than four files import", () => {
    const importers = ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => `app/${name}.py`);
    const index = makeIndex([...importers, "lib/__init__.py"], {
      imports: importers.map((from): [string, string] => [from, "lib/__init__.py"]),
    });
    // 8 importers: each import weighs 4 / 8 = 0.5.
    expect(weightOf(buildFileGraph(index), "app/a.py", "lib/__init__.py")).toBe(0.5);
  });

  it("weighs co-change as twice the Jaccard similarity, ignoring single co-commits", () => {
    const index = makeIndex(["a/x.py", "b/y.tf", "c/z.md"], {
      coChange: [
        ["a/x.py", "b/y.tf", 3],
        ["a/x.py", "c/z.md", 1],
      ],
    });
    index.coChange.fileCommits = { "a/x.py": 4, "b/y.tf": 3, "c/z.md": 1 };
    const graph = buildFileGraph(index);
    // |x ∩ y| = 3, |x ∪ y| = 4 + 3 - 3 = 4.
    expect(weightOf(graph, "a/x.py", "b/y.tf")).toBeCloseTo(1.5);
    expect(weightOf(graph, "a/x.py", "c/z.md")).toBeUndefined();
  });

  it("links directory siblings weakly, sharing 0.3 per file", () => {
    const graph = buildFileGraph(makeIndex(["d/a.md", "d/b.md", "d/c.md", "e/only.md"]));
    expect(graph.edges).toEqual([
      { a: "d/a.md", b: "d/b.md", weight: 0.15 },
      { a: "d/a.md", b: "d/c.md", weight: 0.15 },
      { a: "d/b.md", b: "d/c.md", weight: 0.15 },
    ]);
  });

  it("sums the signals for one pair and ignores edges to unknown files", () => {
    const index = makeIndex(["d/a.py", "d/b.py"], {
      imports: [
        ["d/a.py", "d/b.py"],
        ["d/a.py", "gone.py"],
      ],
    });
    expect(buildFileGraph(index).edges).toEqual([{ a: "d/a.py", b: "d/b.py", weight: 1.3 }]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/cluster/graph.test.ts`
Expected: FAIL, because `./graph.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/cluster/graph.ts`:
```ts
import { posix } from "node:path";
import type { RepoIndex } from "../index/index.ts";

/** An undirected weighted edge between two repo files, with a < b. */
export interface WeightedEdge {
  a: string;
  b: string;
  weight: number;
}

/** Every indexed file, sorted, and the combined import / co-change / directory edges between them. */
export interface FileGraph {
  nodes: string[];
  edges: WeightedEdge[];
}

export interface GraphWeights {
  /** Weight of one resolved import between two files (mutual imports count twice). */
  import: number;
  /** Multiplier on the Jaccard similarity of two files' commit sets. */
  coChange: number;
  /** Total weight a file shares with its directory siblings (the weak signal). */
  directory: number;
  /** Co-changed pairs seen in fewer commits than this are ignored as noise. */
  minCoChangeCount: number;
  /**
   * Imports into a file that more than this many files import are scaled down by
   * hubInDegree / inDegree, so barrels (index.ts) and shared test fixtures stop pulling unrelated
   * files together; such hubs then cluster by directory and co-change.
   */
  hubInDegree: number;
}

export const DEFAULT_GRAPH_WEIGHTS: GraphWeights = {
  import: 1,
  coChange: 2,
  directory: 0.3,
  minCoChangeCount: 2,
  hubInDegree: 4,
};

const pairKey = (x: string, y: string): string => (x < y ? `${x}\0${y}` : `${y}\0${x}`);

/** Builds the file graph clustering runs on. Non-code files join through co-change and directory only. */
export function buildFileGraph(
  index: RepoIndex,
  weights: GraphWeights = DEFAULT_GRAPH_WEIGHTS,
): FileGraph {
  const nodes = index.files.map((file) => file.path).sort();
  const known = new Set(nodes);
  const sums = new Map<string, number>();
  const add = (x: string, y: string, weight: number): void => {
    if (x === y || weight <= 0 || !known.has(x) || !known.has(y)) return;
    const key = pairKey(x, y);
    sums.set(key, (sums.get(key) ?? 0) + weight);
  };

  const inDegree = new Map<string, number>();
  for (const { to } of index.imports) inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  for (const { from, to } of index.imports) {
    const hub = Math.min(1, weights.hubInDegree / (inDegree.get(to) ?? 1));
    add(from, to, weights.import * hub);
  }

  const { fileCommits, pairs } = index.coChange;
  for (const { a, b, count } of pairs) {
    if (count < weights.minCoChangeCount) continue;
    const union = (fileCommits[a] ?? 0) + (fileCommits[b] ?? 0) - count;
    if (union > 0) add(a, b, (weights.coChange * count) / union);
  }

  const byDir = new Map<string, string[]>();
  for (const path of nodes) {
    const dir = posix.dirname(path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
  }
  for (const siblings of byDir.values()) {
    const share = weights.directory / (siblings.length - 1);
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++)
        add(siblings[i] ?? "", siblings[j] ?? "", share);
    }
  }

  const edges = [...sums]
    .map(([key, weight]) => {
      const [a = "", b = ""] = key.split("\0");
      return { a, b, weight };
    })
    .sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return { nodes, edges };
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (6 new tests). The boundary test still passes: `graph.ts` imports only `../index/index.ts`.

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src/cluster
git commit -m "feat(cluster): build the import, co-change, and directory graph"
```

Ship. PR title: `feat(cluster): file graph`.

---

### Task 11: Louvain

**Ticket:** `[M3] cluster: Louvain`

**Files:**
- Create: `packages/engine/src/cluster/louvain.ts`
- Test: `packages/engine/src/cluster/louvain.test.ts`

**Interfaces:**
- Consumes: `WeightedEdge` (Task 10).
- Produces: `louvain(nodes: readonly string[], edges: readonly WeightedEdge[], resolution = 1): Map<string, number>`. This is multi-level Louvain (Blondel et al. 2008): local moving to the best modularity gain `w(i→C) − γ·Σtot(C)·k(i)/2m`, then aggregation, repeated until no node moves. Nodes are visited in the given order, ties keep the current community and then prefer the lowest community id, and no randomness is used. So the result depends only on the input, and communities are numbered 0..k−1 by their first node.

**Why plain TypeScript and not `graphology-communities-louvain`.** The spec named graphology. The library is MIT and widely used (graphology has about 1.8M downloads a week, the Louvain package about 230K). But the Louvain package was last published in December 2024, and it pulls in four more packages (`graphology-indices`, `graphology-utils`, `mnemonist`, `pandemonium`) plus a `graphology-types` peer, all on caret ranges, so pinning our direct dependency would not pin them. Its determinism also depends on a seeded RNG and on graph insertion order. The algorithm needed here is about 110 lines, and making it deterministic by construction is simpler and easier to test than seeding someone else's randomness. The spec delta records the change.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/cluster-louvain
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/cluster/louvain.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { WeightedEdge } from "./graph.ts";
import { louvain } from "./louvain.ts";

const edge = (a: string, b: string, weight = 1): WeightedEdge => ({ a, b, weight });

/** Two triangles joined by one weak edge. */
const NODES = ["a1", "a2", "a3", "b1", "b2", "b3"];
const EDGES = [
  edge("a1", "a2"),
  edge("a1", "a3"),
  edge("a2", "a3"),
  edge("b1", "b2"),
  edge("b1", "b3"),
  edge("b2", "b3"),
  edge("a3", "b1", 0.1),
];

describe("louvain", () => {
  it("separates two dense groups joined by a weak edge", () => {
    expect(Object.fromEntries(louvain(NODES, EDGES))).toEqual({
      a1: 0,
      a2: 0,
      a3: 0,
      b1: 1,
      b2: 1,
      b3: 1,
    });
  });

  it("gives the same answer whatever order the edges come in", () => {
    const reversed = [...EDGES].reverse();
    const rotated = [...EDGES.slice(3), ...EDGES.slice(0, 3)];
    expect(louvain(NODES, reversed)).toEqual(louvain(NODES, EDGES));
    expect(louvain(NODES, rotated)).toEqual(louvain(NODES, EDGES));
  });

  it("merges a chain of groups at low resolution and splits it at high resolution", () => {
    const nodes = ["p", "q", "r", "s"];
    const edges = [edge("p", "q"), edge("q", "r", 0.5), edge("r", "s")];
    expect(new Set(louvain(nodes, edges, 0.1).values()).size).toBe(1);
    expect(new Set(louvain(nodes, edges, 1).values()).size).toBe(2);
  });

  it("leaves isolated nodes alone and handles a graph with no edges", () => {
    expect(Object.fromEntries(louvain(["x", "y", "z"], [edge("x", "y")]))).toEqual({
      x: 0,
      y: 0,
      z: 1,
    });
    expect(Object.fromEntries(louvain(["x", "y"], []))).toEqual({ x: 0, y: 1 });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/cluster/louvain.test.ts`
Expected: FAIL, because `./louvain.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/cluster/louvain.ts`:
```ts
import type { WeightedEdge } from "./graph.ts";

interface Level {
  /** adjacency[i]: neighbour index → summed edge weight (self-loops included). */
  adjacency: Map<number, number>[];
  /** Weighted degree of each node; a self-loop counts twice. */
  degree: number[];
}

function buildLevel(size: number, edges: Iterable<[number, number, number]>): Level {
  const adjacency = Array.from({ length: size }, () => new Map<number, number>());
  const degree = new Array<number>(size).fill(0);
  for (const [i, j, w] of edges) {
    adjacency[i]?.set(j, (adjacency[i]?.get(j) ?? 0) + w);
    if (i !== j) adjacency[j]?.set(i, (adjacency[j]?.get(i) ?? 0) + w);
    degree[i] = (degree[i] ?? 0) + w;
    degree[j] = (degree[j] ?? 0) + w;
  }
  return { adjacency, degree };
}

/**
 * One round of local moving: each node, in index order, joins the neighbouring community with the
 * largest modularity gain. Ties keep the current community, then prefer the lowest community id,
 * so the result depends only on the input. Returns community ids renumbered 0..k-1 by first node.
 */
function localMoving(level: Level, totalWeight: number, resolution: number): number[] | null {
  const n = level.degree.length;
  const community = Array.from({ length: n }, (_, i) => i);
  const tot = [...level.degree];
  let movedAny = false;
  for (let moved = true; moved; ) {
    moved = false;
    for (let i = 0; i < n; i++) {
      const ki = level.degree[i] ?? 0;
      const current = community[i] ?? i;
      const links = new Map<number, number>();
      for (const [j, w] of level.adjacency[i] ?? []) {
        if (j === i) continue;
        const c = community[j] ?? j;
        links.set(c, (links.get(c) ?? 0) + w);
      }
      tot[current] = (tot[current] ?? 0) - ki;
      const gain = (c: number): number =>
        (links.get(c) ?? 0) - (resolution * (tot[c] ?? 0) * ki) / totalWeight;
      let best = current;
      let bestGain = gain(current);
      for (const c of [...links.keys()].sort((x, y) => x - y)) {
        const g = gain(c);
        if (g > bestGain + 1e-12) {
          best = c;
          bestGain = g;
        }
      }
      tot[best] = (tot[best] ?? 0) + ki;
      if (best !== current) {
        community[i] = best;
        moved = true;
        movedAny = true;
      }
    }
  }
  if (!movedAny) return null;
  const renumber = new Map<number, number>();
  return community.map((c) => {
    if (!renumber.has(c)) renumber.set(c, renumber.size);
    return renumber.get(c) ?? 0;
  });
}

/**
 * Louvain community detection (Blondel et al. 2008) on an undirected weighted graph. Deterministic:
 * nodes are visited in the given order and no randomness is used. Returns each node's community,
 * numbered 0..k-1 in order of each community's first node.
 */
export function louvain(
  nodes: readonly string[],
  edges: readonly WeightedEdge[],
  resolution = 1,
): Map<string, number> {
  const indexOf = new Map(nodes.map((node, i) => [node, i]));
  let level = buildLevel(
    nodes.length,
    edges.map((e): [number, number, number] => [
      indexOf.get(e.a) ?? -1,
      indexOf.get(e.b) ?? -1,
      e.weight,
    ]),
  );
  const totalWeight = level.degree.reduce((sum, d) => sum + d, 0);
  let membership = nodes.map((_, i) => i);
  if (totalWeight === 0) return new Map(nodes.map((node, i) => [node, i]));

  for (;;) {
    const communities = localMoving(level, totalWeight, resolution);
    if (communities === null) break;
    membership = membership.map((c) => communities[c] ?? c);
    const size = Math.max(...communities) + 1;
    const merged = new Map<string, [number, number, number]>();
    level.adjacency.forEach((neighbours, i) => {
      for (const [j, w] of neighbours) {
        if (j < i) continue;
        const ci = communities[i] ?? 0;
        const cj = communities[j] ?? 0;
        const [x, y] = ci <= cj ? [ci, cj] : [cj, ci];
        const key = `${x},${y}`;
        const entry = merged.get(key);
        if (entry) entry[2] += w;
        else merged.set(key, [x, y, w]);
      }
    });
    level = buildLevel(size, merged.values());
  }
  return new Map(nodes.map((node, i) => [node, membership[i] ?? i]));
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (4 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src/cluster
git commit -m "feat(cluster): detect communities with deterministic Louvain"
```

Ship. PR title: `feat(cluster): Louvain`.

---

### Task 12: Clusters

**Ticket:** `[M3] cluster: clusters`

**Files:**
- Create: `packages/engine/src/cluster/clusters.ts`
- Test: `packages/engine/src/cluster/clusters.test.ts`

**Interfaces:**
- Consumes: `FileGraph` (Task 10), `louvain` (Task 11).
- Produces:
  ```ts
  interface Cluster { id: string; files: string[] }   // "c01", "c02", …; files sorted
  interface ClusterOptions { resolution: number; minClusterSize: number }
  const DEFAULT_CLUSTER_OPTIONS = { resolution: 3, minClusterSize: 5 }
  clusterFiles(graph: FileGraph, options?: ClusterOptions): Cluster[]   // largest first, ties by first path
  ```
- How small clusters are absorbed, smallest first:
  - A cluster under `minClusterSize` files joins the cluster it shares the most edge weight with.
  - With no edges at all, it joins the cluster holding the file with the deepest shared directory prefix, then the larger cluster, then the lower community id.
  - A lone cluster stays as it is.
- The defaults come from the prototype on next-chief-of-staff at `7247d28`. Resolution 1 gave 35 raw communities, 16 of them 1–3 files, and an 88-file catch-all. Resolution 3 with absorption below 5 files gives 23 clusters of 6–71 files that read as features (the frontend views and forms apart, the orchestration agents apart, each Terraform module group together). The LLM can merge clusters but cannot split them, so erring fine is right.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/cluster-clusters
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/cluster/clusters.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { clusterFiles } from "./clusters.ts";
import { buildFileGraph } from "./graph.ts";
import { makeIndex } from "./test-index.ts";

/** Two tightly importing groups of four files plus whatever `extra` adds. */
function twoGroups(extra: string[] = [], imports: [string, string][] = []) {
  const api = ["api/a.py", "api/b.py", "api/c.py", "api/d.py"];
  const web = ["web/a.ts", "web/b.ts", "web/c.ts", "web/d.ts"];
  const clique = (files: string[]) =>
    files.flatMap((x, i) => files.slice(i + 1).map((y): [string, string] => [x, y]));
  return buildFileGraph(
    makeIndex([...api, ...web, ...extra], {
      imports: [...clique(api), ...clique(web), ...imports],
    }),
  );
}

describe("clusterFiles", () => {
  it("finds the groups, largest first, with sorted files and c01-style ids", () => {
    const clusters = clusterFiles(twoGroups(["web/e.ts"], [["web/e.ts", "web/a.ts"]]), {
      resolution: 1,
      minClusterSize: 1,
    });
    expect(clusters).toEqual([
      { id: "c01", files: ["web/a.ts", "web/b.ts", "web/c.ts", "web/d.ts", "web/e.ts"] },
      { id: "c02", files: ["api/a.py", "api/b.py", "api/c.py", "api/d.py"] },
    ]);
  });

  it("absorbs a small cluster into the cluster it shares the most weight with", () => {
    const graph = twoGroups(
      ["tools/x.py", "tools/y.py"],
      [
        ["tools/x.py", "api/a.py"],
        ["tools/x.py", "tools/y.py"],
        ["tools/y.py", "tools/x.py"],
      ],
    );
    const tools = ["tools/x.py", "tools/y.py"];
    const api = ["api/a.py", "api/b.py", "api/c.py", "api/d.py"];
    expect(clusterFiles(graph, { resolution: 1, minClusterSize: 1 })[2]?.files).toEqual(tools);
    expect(clusterFiles(graph, { resolution: 1, minClusterSize: 3 })[0]?.files).toEqual([
      ...api,
      ...tools,
    ]);
  });

  it("absorbs an unconnected small cluster into the cluster with the deepest shared directory", () => {
    const clusters = clusterFiles(twoGroups(["web/assets/logo.svg"]), {
      resolution: 1,
      minClusterSize: 2,
    });
    expect(clusters.find((c) => c.files.includes("web/assets/logo.svg"))?.files).toContain(
      "web/a.ts",
    );
  });

  it("keeps a lone cluster even when it is below the minimum size", () => {
    expect(clusterFiles(buildFileGraph(makeIndex(["README.md"])))).toEqual([
      { id: "c01", files: ["README.md"] },
    ]);
  });

  it("does not depend on the order of the index's edges", () => {
    const index = makeIndex(["a/1.py", "a/2.py", "b/1.py", "b/2.py", "b/3.py"], {
      imports: [
        ["a/1.py", "a/2.py"],
        ["b/1.py", "b/2.py"],
        ["b/2.py", "b/3.py"],
        ["a/2.py", "b/1.py"],
      ],
    });
    const reversed = { ...index, imports: [...index.imports].reverse() };
    const options = { resolution: 1, minClusterSize: 1 };
    expect(clusterFiles(buildFileGraph(reversed), options)).toEqual(
      clusterFiles(buildFileGraph(index), options),
    );
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/cluster/clusters.test.ts`
Expected: FAIL, because `./clusters.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/cluster/clusters.ts`:
```ts
import { posix } from "node:path";
import type { FileGraph } from "./graph.ts";
import { louvain } from "./louvain.ts";

export interface Cluster {
  /** "c01", "c02", …: largest cluster first, ties broken by first path. */
  id: string;
  /** Sorted repo paths. */
  files: string[];
}

export interface ClusterOptions {
  /** Louvain resolution; higher gives more, smaller clusters. */
  resolution: number;
  /** Clusters with fewer files are absorbed into their best neighbour. */
  minClusterSize: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = { resolution: 3, minClusterSize: 5 };

function sharedPrefixDepth(a: string, b: string): number {
  const x = posix.dirname(a).split("/");
  const y = posix.dirname(b).split("/");
  let depth = 0;
  while (depth < x.length && depth < y.length && x[depth] === y[depth]) depth++;
  return depth;
}

/**
 * Clusters the file graph: Louvain, then small clusters are absorbed into the cluster they share
 * the most edge weight with, or, with no edges, the one sharing the deepest directory prefix.
 * Deterministic: the same graph always yields the same clusters and ids.
 */
export function clusterFiles(
  graph: FileGraph,
  options: ClusterOptions = DEFAULT_CLUSTER_OPTIONS,
): Cluster[] {
  const communityOf = louvain(graph.nodes, graph.edges, options.resolution);
  const groups = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const c = communityOf.get(node) ?? -1;
    groups.set(c, [...(groups.get(c) ?? []), node]);
  }

  const neighbours = new Map<string, Map<string, number>>();
  for (const { a, b, weight } of graph.edges) {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const map = neighbours.get(x) ?? new Map<string, number>();
      map.set(y, (map.get(y) ?? 0) + weight);
      neighbours.set(x, map);
    }
  }

  const bySize = (x: [number, string[]], y: [number, string[]]) =>
    x[1].length - y[1].length || x[0] - y[0];
  for (;;) {
    const small = [...groups]
      .sort(bySize)
      .find(([, files]) => files.length < options.minClusterSize);
    if (small === undefined || groups.size === 1) break;
    const [id, files] = small;
    const weightTo = new Map<number, number>();
    for (const file of files) {
      for (const [other, w] of neighbours.get(file) ?? []) {
        const c = communityOf.get(other) ?? -1;
        if (c !== id) weightTo.set(c, (weightTo.get(c) ?? 0) + w);
      }
    }
    const score = (c: number, members: string[]): [number, number, number] => [
      weightTo.get(c) ?? 0,
      Math.max(...members.map((m) => sharedPrefixDepth(m, files[0] ?? ""))),
      members.length,
    ];
    let target: number | null = null;
    let best: [number, number, number] = [-1, -1, -1];
    for (const [c, members] of [...groups].sort((x, y) => x[0] - y[0])) {
      if (c === id) continue;
      const s = score(c, members);
      if (
        s[0] > best[0] ||
        (s[0] === best[0] && (s[1] > best[1] || (s[1] === best[1] && s[2] > best[2])))
      ) {
        target = c;
        best = s;
      }
    }
    if (target === null) break;
    for (const file of files) communityOf.set(file, target);
    groups.set(target, [...(groups.get(target) ?? []), ...files].sort());
    groups.delete(id);
  }

  return [...groups.values()]
    .map((files) => [...files].sort())
    .sort((x, y) => y.length - x.length || ((x[0] ?? "") < (y[0] ?? "") ? -1 : 1))
    .map((files, i) => ({ id: `c${String(i + 1).padStart(2, "0")}`, files }));
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (5 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src/cluster
git commit -m "feat(cluster): cluster files with small-cluster absorption and stable ids"
```

Ship. PR title: `feat(cluster): clusters`.

---

### Task 13: Cluster summaries and the cluster module entry

**Ticket:** `[M3] cluster: summaries`

**Files:**
- Create: `packages/engine/src/cluster/summaries.ts`, `packages/engine/src/cluster/index.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/cluster/summaries.test.ts`

**Interfaces:**
- Consumes: `RepoIndex`, `SymbolKind` (M2), `Cluster` (Task 12), `FileGraph` (Task 10).
- Produces:
  ```ts
  interface ClusterSummary { id; fileCount; symbolCount; languages: string[]; directories: { dir; files }[]; files: string[]; symbols: string[]; externalImports: string[]; neighbours: { id; weight }[] }
  interface SummaryLimits { files; symbols; directories; externalImports; neighbours }
  const DEFAULT_SUMMARY_LIMITS = { files: 25, symbols: 25, directories: 6, externalImports: 8, neighbours: 4 }
  summarizeClusters(index: RepoIndex, graph: FileGraph, clusters: readonly Cluster[], limits?: SummaryLimits): ClusterSummary[]
  ```
- A summary holds names and structure only: paths, symbol ids, package names, counts. It never holds source text, which the RepoIndex doesn't carry anyway (spec §4: "the manifest call receives cluster summaries, not source code"). The fields:
  - `files`: the cluster's best-connected files first, ranked by the edge weight they keep inside the cluster.
  - `symbols`: those files' exported, non-method symbols, with types, classes and enums before functions, and functions before variables.
  - `externalImports`: package roots, "os.path" → "os" for Python and "@scope/pkg/x" → "@scope/pkg" for ES.
- `cluster/index.ts` is the module entry for graph, clusters and summaries. The engine re-exports it.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/cluster-summaries
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/cluster/summaries.test.ts`:
```ts
import { memberId } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import type { SymbolDef } from "../index/index.ts";
import { buildFileGraph } from "./graph.ts";
import { summarizeClusters } from "./summaries.ts";
import { makeIndex } from "./test-index.ts";

function symbol(path: string, qualifiedName: string, kind: SymbolDef["kind"], exported = true) {
  return {
    id: memberId(path, qualifiedName),
    qualifiedName,
    kind,
    startLine: 1,
    endLine: 2,
    exported,
  };
}

const index = makeIndex(["api/app.py", "api/routes.py", "api/README.md", "web/main.ts"], {
  imports: [
    ["api/routes.py", "api/app.py"],
    ["web/main.ts", "api/app.py"],
  ],
});
for (const file of index.files) {
  if (file.path.endsWith(".py")) file.language = "python";
  if (file.path.endsWith(".ts")) file.language = "typescript";
}
const app = index.files.find((f) => f.path === "api/app.py");
if (app) {
  app.symbols = [
    symbol("api/app.py", "logger", "variable"),
    symbol("api/app.py", "create_app", "function"),
    symbol("api/app.py", "App", "class"),
    symbol("api/app.py", "App.run", "method"),
    symbol("api/app.py", "_private", "function", false),
  ];
}
index.unresolved = [
  { from: "api/app.py", specifier: "fastapi.routing", line: 1, external: true },
  { from: "api/routes.py", specifier: "fastapi", line: 1, external: true },
  { from: "api/routes.py", specifier: "os", line: 2, external: true },
  { from: "web/main.ts", specifier: "@tanstack/react-query/devtools", line: 1, external: true },
  { from: "api/routes.py", specifier: "missing_internal", line: 3, external: false },
];
const clusters = [
  { id: "c01", files: ["api/README.md", "api/app.py", "api/routes.py"] },
  { id: "c02", files: ["web/main.ts"] },
];

describe("summarizeClusters", () => {
  const [api, web] = summarizeClusters(index, buildFileGraph(index), clusters);

  it("counts files, symbols, languages, and directories", () => {
    expect(api).toMatchObject({
      id: "c01",
      fileCount: 3,
      symbolCount: 5,
      languages: ["python 2", "other 1"],
      directories: [{ dir: "api", files: 3 }],
    });
  });

  it("lists best-connected files first and exported non-method symbols, types first", () => {
    expect(api?.files[0]).toBe("api/app.py");
    expect(api?.symbols).toEqual(["api/app.py#App", "api/app.py#create_app", "api/app.py#logger"]);
  });

  it("names external packages, most used first, ignoring unresolved internal imports", () => {
    expect(api?.externalImports).toEqual(["fastapi", "os"]);
    expect(web?.externalImports).toEqual(["@tanstack/react-query"]);
  });

  it("lists neighbouring clusters with the weight they share", () => {
    expect(api?.neighbours).toEqual([{ id: "c02", weight: 1 }]);
    expect(web?.neighbours).toEqual([{ id: "c01", weight: 1 }]);
  });

  it("caps each listing at the given limits", () => {
    const limits = { files: 1, symbols: 1, directories: 1, externalImports: 1, neighbours: 0 };
    const [small] = summarizeClusters(index, buildFileGraph(index), clusters, limits);
    expect(small).toMatchObject({
      files: ["api/app.py"],
      symbols: ["api/app.py#App"],
      externalImports: ["fastapi"],
      neighbours: [],
    });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/cluster/summaries.test.ts`
Expected: FAIL, because `./summaries.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/cluster/summaries.ts`:
```ts
import { posix } from "node:path";
import type { RepoIndex, SymbolKind } from "../index/index.ts";
import type { Cluster } from "./clusters.ts";
import type { FileGraph } from "./graph.ts";

/** What the manifest LLM call sees of a cluster: names and structure, never source text. */
export interface ClusterSummary {
  id: string;
  fileCount: number;
  symbolCount: number;
  /** "python 12", "tsx 3", "other 2": file counts by language, largest first. */
  languages: string[];
  /** Directories holding the cluster's files, most files first. */
  directories: { dir: string; files: number }[];
  /** The best-connected files inside the cluster. */
  files: string[];
  /** Exported symbols of those files, as "path#name". */
  symbols: string[];
  /** Third-party packages the cluster imports, most used first. */
  externalImports: string[];
  /** The clusters it shares the most edge weight with. */
  neighbours: { id: string; weight: number }[];
}

export interface SummaryLimits {
  files: number;
  symbols: number;
  directories: number;
  externalImports: number;
  neighbours: number;
}

export const DEFAULT_SUMMARY_LIMITS: SummaryLimits = {
  files: 25,
  symbols: 25,
  directories: 6,
  externalImports: 8,
  neighbours: 4,
};

const round = (n: number): number => Math.round(n * 100) / 100;

/** Types and functions say more about a cluster than module-level variables. Sorting is stable. */
const KIND_RANK: Record<SymbolKind, number> = {
  class: 0,
  interface: 0,
  type: 0,
  enum: 0,
  function: 1,
  method: 1,
  variable: 2,
};

/** Most common first; ties alphabetical. */
function ranked(counts: Map<string, number>): [string, number][] {
  return [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
}

/** "os.path" from a .py file is "os"; "@scope/pkg/sub" is "@scope/pkg"; "react-dom/client" is "react-dom". */
function packageOf(from: string, specifier: string): string {
  if (from.endsWith(".py")) return specifier.split(".")[0] ?? specifier;
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

export function summarizeClusters(
  index: RepoIndex,
  graph: FileGraph,
  clusters: readonly Cluster[],
  limits: SummaryLimits = DEFAULT_SUMMARY_LIMITS,
): ClusterSummary[] {
  const clusterOf = new Map<string, string>();
  for (const cluster of clusters) for (const file of cluster.files) clusterOf.set(file, cluster.id);
  const fileByPath = new Map(index.files.map((file) => [file.path, file]));

  const inner = new Map<string, number>();
  const between = new Map<string, Map<string, number>>();
  for (const { a, b, weight } of graph.edges) {
    const ca = clusterOf.get(a) ?? "";
    const cb = clusterOf.get(b) ?? "";
    if (ca === cb) {
      inner.set(a, (inner.get(a) ?? 0) + weight);
      inner.set(b, (inner.get(b) ?? 0) + weight);
      continue;
    }
    for (const [x, y] of [
      [ca, cb],
      [cb, ca],
    ] as const) {
      const map = between.get(x) ?? new Map<string, number>();
      map.set(y, (map.get(y) ?? 0) + weight);
      between.set(x, map);
    }
  }

  const external = new Map<string, Map<string, number>>();
  for (const miss of index.unresolved) {
    const id = clusterOf.get(miss.from);
    if (!miss.external || id === undefined) continue;
    const pkg = packageOf(miss.from, miss.specifier);
    const map = external.get(id) ?? new Map<string, number>();
    map.set(pkg, (map.get(pkg) ?? 0) + 1);
    external.set(id, map);
  }

  return clusters.map((cluster) => {
    const files = cluster.files.flatMap((path) => fileByPath.get(path) ?? []);
    const languages = new Map<string, number>();
    const dirs = new Map<string, number>();
    for (const file of files) {
      const language = file.language ?? "other";
      languages.set(language, (languages.get(language) ?? 0) + 1);
      const dir = posix.dirname(file.path);
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
    const central = [...files].sort(
      (x, y) => (inner.get(y.path) ?? 0) - (inner.get(x.path) ?? 0) || (x.path < y.path ? -1 : 1),
    );
    const symbols = central
      .flatMap((file) => file.symbols.filter((s) => s.exported && s.kind !== "method"))
      .sort((x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind])
      .slice(0, limits.symbols)
      .map((s) => s.id);
    return {
      id: cluster.id,
      fileCount: files.length,
      symbolCount: files.reduce((total, file) => total + file.symbols.length, 0),
      languages: ranked(languages).map(([language, n]) => `${language} ${n}`),
      directories: ranked(dirs)
        .slice(0, limits.directories)
        .map(([dir, n]) => ({ dir: dir === "." ? "(root)" : dir, files: n })),
      files: central.slice(0, limits.files).map((file) => file.path),
      symbols,
      externalImports: ranked(external.get(cluster.id) ?? new Map())
        .slice(0, limits.externalImports)
        .map(([pkg]) => pkg),
      neighbours: ranked(between.get(cluster.id) ?? new Map())
        .slice(0, limits.neighbours)
        .map(([id, weight]) => ({ id, weight: round(weight) })),
    };
  });
}
```

`packages/engine/src/cluster/index.ts`:
```ts
export {
  type Cluster,
  type ClusterOptions,
  clusterFiles,
  DEFAULT_CLUSTER_OPTIONS,
} from "./clusters.ts";
export {
  buildFileGraph,
  DEFAULT_GRAPH_WEIGHTS,
  type FileGraph,
  type GraphWeights,
  type WeightedEdge,
} from "./graph.ts";
export {
  type ClusterSummary,
  DEFAULT_SUMMARY_LIMITS,
  type SummaryLimits,
  summarizeClusters,
} from "./summaries.ts";
```

In `packages/engine/src/index.ts`, put the cluster exports first (Biome sorts export blocks by source). Replace the opening of the index export block:
```ts
export {
  type CoChange,
```
with:
```ts
export {
  buildFileGraph,
  type Cluster,
  type ClusterOptions,
  type ClusterSummary,
  clusterFiles,
  DEFAULT_CLUSTER_OPTIONS,
  DEFAULT_GRAPH_WEIGHTS,
  DEFAULT_SUMMARY_LIMITS,
  type FileGraph,
  type GraphWeights,
  type SummaryLimits,
  summarizeClusters,
  type WeightedEdge,
} from "./cluster/index.ts";
export {
  type CoChange,
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (5 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src
git commit -m "feat(cluster): summarize clusters for the manifest call"
```

Ship. PR title: `feat(cluster): summaries`.

---

### Task 14: Proposal validation

**Ticket:** `[M3] manifest: proposal validation`

**Files:**
- Create: `packages/engine/src/manifest/proposal.ts`
- Modify: `packages/engine/package.json` (zod), `pnpm-lock.yaml`
- Test: `packages/engine/src/manifest/proposal.test.ts`

**Interfaces:**
- Consumes: `FeatureId` from `@repowiki/core`; `Cluster` from `../cluster/index.ts`.
- Produces:
  ```ts
  const ManifestProposal = z.object({
    features: z.array(z.object({ id: z.string(), title: z.string(), aliases: z.array(z.string()) })),
    clusters: z.array(z.object({ cluster: z.string(), feature: z.string(), role: z.enum(["core", "supporting"]) })),
  })
  const MIN_ALIASES = 3, MAX_ALIASES = 8, MAX_FEATURE_ID_LENGTH = 40
  cleanAliases(title: string, aliases: readonly string[]): string[]   // trimmed, case-insensitively unique, never the title
  proposalProblems(proposal: ManifestProposal, clusters: readonly Cluster[]): string[]   // [] when acceptable
  ```
- The answer assigns each cluster once (`clusters`), instead of listing clusters under each feature. In the prototype, Haiku 4.5 put a cluster under two features in three of four tries with the nested shape. With one entry per cluster, it got the assignment right in all four live tries.
- A problem is anything a retry can fix: a bad or too-long slug, a duplicate id or title, fewer than 3 distinct aliases, a cluster assigned twice, not at all, or to an unknown feature, or an unknown cluster id. Features with no clusters, and more than 8 aliases, are not problems; Task 15 drops or caps them.

- [ ] **Step 1: Branch and add zod to the engine**

```bash
git switch -c m3/manifest-proposal
pnpm --filter @repowiki/engine add --save-exact zod@4.6.5
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/manifest/proposal.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { type ManifestProposal, proposalProblems } from "./proposal.ts";

const clusters = ["c01", "c02", "c03"].map((id) => ({ id, files: [] }));

const API = { id: "http-api", title: "HTTP API", aliases: ["API server", "FastAPI app", "routes"] };
const WEB = {
  id: "web-frontend",
  title: "Web frontend",
  aliases: ["UI", "React app", "dashboard"],
};

function proposal(overrides: Partial<ManifestProposal> = {}): ManifestProposal {
  return {
    features: [API, WEB],
    clusters: [
      { cluster: "c01", feature: "http-api", role: "core" },
      { cluster: "c02", feature: "http-api", role: "supporting" },
      { cluster: "c03", feature: "web-frontend", role: "core" },
    ],
    ...overrides,
  };
}

describe("proposalProblems", () => {
  it("accepts a proposal that assigns every cluster once", () => {
    expect(proposalProblems(proposal(), clusters)).toEqual([]);
  });

  it.each([
    [
      "a bad slug",
      { features: [{ ...API, id: "HTTP_API" }, WEB] },
      'feature id "HTTP_API" is not a kebab-case slug of at most 40 characters',
    ],
    [
      "a slug over 40 characters",
      { features: [{ ...API, id: "a".repeat(41) }, WEB] },
      `feature id "${"a".repeat(41)}" is not a kebab-case slug of at most 40 characters`,
    ],
    [
      "a duplicate title",
      { features: [API, { ...WEB, title: "http api" }] },
      'title "http api" is used twice',
    ],
    [
      "too few distinct aliases",
      {
        features: [{ ...API, aliases: ["API", "api", "HTTP API"] }, WEB],
      },
      'feature "http-api" has 1 distinct aliases; give 3 to 8',
    ],
    [
      "a cluster assigned twice",
      {
        clusters: [
          ...proposal().clusters,
          { cluster: "c01", feature: "web-frontend", role: "core" },
        ],
      },
      "cluster c01 is assigned twice",
    ],
    [
      "an unassigned cluster",
      { clusters: proposal().clusters.slice(0, 2) },
      "cluster c03 is not assigned",
    ],
    [
      "an unknown cluster",
      { clusters: [...proposal().clusters, { cluster: "c09", feature: "http-api", role: "core" }] },
      "cluster c09 does not exist",
    ],
    [
      "an unknown feature",
      {
        clusters: [
          ...proposal().clusters.slice(0, 2),
          { cluster: "c03", feature: "frontend", role: "core" },
        ],
      },
      'cluster c03 is assigned to unknown feature "frontend"',
    ],
  ] as [string, Partial<ManifestProposal>, string][])("reports %s", (_name, overrides, problem) => {
    expect(proposalProblems(proposal(overrides), clusters)).toContain(problem);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/manifest/proposal.test.ts`
Expected: FAIL, because `./proposal.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/manifest/proposal.ts`:
```ts
import { FeatureId } from "@repowiki/core";
import { z } from "zod";
import type { Cluster } from "../cluster/index.ts";

/**
 * What the manifest call returns: the features, then one assignment per cluster. Assigning each
 * cluster once (rather than listing clusters under features) keeps the model from putting a
 * cluster in two features. Structured output enforces the shape; proposalProblems checks the
 * rules a JSON schema cannot express, so a rejected answer can be sent back with reasons.
 */
export const ManifestProposal = z.object({
  features: z.array(z.object({ id: z.string(), title: z.string(), aliases: z.array(z.string()) })),
  clusters: z.array(
    z.object({ cluster: z.string(), feature: z.string(), role: z.enum(["core", "supporting"]) }),
  ),
});
export type ManifestProposal = z.infer<typeof ManifestProposal>;

export const MIN_ALIASES = 3;
export const MAX_ALIASES = 8;
export const MAX_FEATURE_ID_LENGTH = 40;

/** Trimmed, de-duplicated (case-insensitively), and never equal to the title. */
export function cleanAliases(title: string, aliases: readonly string[]): string[] {
  const seen = new Set([title.trim().toLowerCase()]);
  const out: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (trimmed === "" || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

/** Every reason the proposal cannot become a manifest; empty when it can. */
export function proposalProblems(
  proposal: ManifestProposal,
  clusters: readonly Cluster[],
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const feature of proposal.features) {
    if (!FeatureId.safeParse(feature.id).success || feature.id.length > MAX_FEATURE_ID_LENGTH) {
      problems.push(`feature id "${feature.id}" is not a kebab-case slug of at most 40 characters`);
    }
    if (ids.has(feature.id)) problems.push(`feature id "${feature.id}" is used twice`);
    ids.add(feature.id);
    const title = feature.title.trim();
    if (title === "") problems.push(`feature "${feature.id}" has an empty title`);
    if (titles.has(title.toLowerCase())) problems.push(`title "${title}" is used twice`);
    titles.add(title.toLowerCase());
    const aliases = cleanAliases(title, feature.aliases).length;
    if (aliases < MIN_ALIASES) {
      problems.push(
        `feature "${feature.id}" has ${aliases} distinct aliases; give ${MIN_ALIASES} to ${MAX_ALIASES}`,
      );
    }
  }
  const known = new Set(clusters.map((c) => c.id));
  const assigned = new Set<string>();
  for (const { cluster, feature } of proposal.clusters) {
    if (!known.has(cluster)) problems.push(`cluster ${cluster} does not exist`);
    if (assigned.has(cluster)) problems.push(`cluster ${cluster} is assigned twice`);
    if (!ids.has(feature))
      problems.push(`cluster ${cluster} is assigned to unknown feature "${feature}"`);
    assigned.add(cluster);
  }
  for (const id of known) if (!assigned.has(id)) problems.push(`cluster ${id} is not assigned`);
  return problems;
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (9 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine pnpm-lock.yaml
git commit -m "feat(manifest): validate the manifest proposal"
```

Ship. PR title: `feat(manifest): proposal validation`.

---

### Task 15: Membership and weights

**Ticket:** `[M3] manifest: membership and weights`

**Files:**
- Create: `packages/engine/src/manifest/to-manifest.ts`, `packages/engine/src/manifest/test-index.ts` (test support)
- Test: `packages/engine/src/manifest/to-manifest.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `memberId` from `@repowiki/core`; `Cluster`, `FileGraph` (Tasks 10–13); `ManifestProposal`, `cleanAliases`, `MAX_ALIASES` (Task 14).
- Produces:
  ```ts
  proposalToManifest(proposal: ManifestProposal, index: RepoIndex, graph: FileGraph, clusters: readonly Cluster[]): Manifest
  sampleIndex(): RepoIndex   // test-only: a Python API, its test, a docs/C#.md, and a TSX frontend
  ```
- What the manifest holds:
  - **Features.** Each is `active`, with lineage `[{ kind: "create", sha }]`. Features with no clusters are dropped, and aliases are cleaned and capped at 8.
  - **Members.** Every file and every symbol is a member. The keys are the ids the index already built with `memberId()`, so the `#`/`%` encoding of spec rule 7 carries through, e.g. `docs/C%23.md`. A symbol shares its file's feature and weight. Files are the unit of clustering in v1, so a symbol can only move to another feature in a later update (spec §6.1 step 3).
  - **Weights.** A member's weight is `round3(role × max(0.05, centrality))`. `role` is 1 for a `core` cluster and 0.5 for a `supporting` one. `centrality` is the share of the file's edge weight that stays inside its feature. So weights fall in (0, 1], and spec §7.2's context packs, which take the heaviest members first, start with the files most central to the feature.
- The result is validated with `Manifest.parse`.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/manifest-membership
```

- [ ] **Step 2: Add the sample index and write the failing tests**

`packages/engine/src/manifest/test-index.ts`:
```ts
import { memberId } from "@repowiki/core";
import type { IndexedFile, RepoIndex, SourceLanguage, SymbolKind } from "../index/index.ts";

function file(path: string, language: SourceLanguage | null, symbols: [string, SymbolKind][] = []) {
  const indexed: IndexedFile = {
    id: memberId(path),
    path,
    language,
    bytes: 100,
    loc: 10,
    skipped: null,
    parseError: false,
    symbols: symbols.map(([qualifiedName, kind], i) => ({
      id: memberId(path, qualifiedName),
      qualifiedName,
      kind,
      startLine: i + 1,
      endLine: i + 1,
      exported: true,
    })),
  };
  return indexed;
}

/**
 * A small two-feature repository as a hand-built RepoIndex: a Python API with its tests and a
 * doc whose path needs escaping, and a TSX frontend. Test-only.
 */
export function sampleIndex(): RepoIndex {
  return {
    sha: "c".repeat(40),
    files: [
      file("docs/C#.md", null),
      file("src/api/app.py", "python", [
        ["App", "class"],
        ["App.run", "method"],
        ["create_app", "function"],
      ]),
      file("src/api/routes.py", "python", [["router", "variable"]]),
      file("tests/test_routes.py", "python", [["test_list", "function"]]),
      file("web/src/api.ts", "typescript", [["fetchJson", "function"]]),
      file("web/src/main.tsx", "tsx", [["Main", "function"]]),
    ],
    imports: [
      { from: "src/api/routes.py", to: "src/api/app.py", line: 1 },
      { from: "tests/test_routes.py", to: "src/api/routes.py", line: 1 },
      { from: "web/src/main.tsx", to: "web/src/api.ts", line: 1 },
    ],
    unresolved: [
      { from: "src/api/app.py", specifier: "fastapi", line: 1, external: true },
      { from: "web/src/main.tsx", specifier: "react", line: 1, external: true },
    ],
    coChange: {
      commitsConsidered: 4,
      commitsSkipped: 0,
      fileCommits: { "docs/C#.md": 2, "src/api/app.py": 3, "web/src/api.ts": 1 },
      pairs: [{ a: "docs/C#.md", b: "src/api/app.py", count: 2 }],
    },
    invalidPaths: [],
  };
}
```

`packages/engine/src/manifest/to-manifest.test.ts`:
```ts
import { Manifest } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import { buildFileGraph, clusterFiles } from "../cluster/index.ts";
import type { ManifestProposal } from "./proposal.ts";
import { sampleIndex } from "./test-index.ts";
import { proposalToManifest } from "./to-manifest.ts";

const index = sampleIndex();
const graph = buildFileGraph(index);
// c01: docs/C#.md + src/api/app.py; c02: routes + its test; c03: the web frontend.
const clusters = clusterFiles(graph, { resolution: 1, minClusterSize: 1 });

const API = { id: "http-api", title: "HTTP API", aliases: ["API server", "FastAPI app", "routes"] };
const WEB = {
  id: "web-frontend",
  title: "Web frontend",
  aliases: ["UI", "React app", "dashboard"],
};

function proposal(overrides: Partial<ManifestProposal> = {}): ManifestProposal {
  return {
    features: [API, WEB],
    clusters: [
      { cluster: "c01", feature: "http-api", role: "core" },
      { cluster: "c02", feature: "http-api", role: "supporting" },
      { cluster: "c03", feature: "web-frontend", role: "core" },
    ],
    ...overrides,
  };
}

describe("proposalToManifest", () => {
  const manifest = proposalToManifest(proposal(), index, graph, clusters);

  it("produces a valid manifest of new, active features created at the index sha", () => {
    expect(clusters.map((c) => c.files.length)).toEqual([2, 2, 2]);
    expect(Manifest.parse(manifest)).toEqual(manifest);
    expect(manifest.sha).toBe(index.sha);
    expect(manifest.features.map((f) => [f.id, f.status, f.lineage])).toEqual([
      ["http-api", { kind: "active" }, [{ kind: "create", sha: index.sha }]],
      ["web-frontend", { kind: "active" }, [{ kind: "create", sha: index.sha }]],
    ]);
  });

  it("makes every file and every symbol a member, keyed by memberId", () => {
    expect(Object.keys(manifest.membership).sort()).toEqual([
      "docs/C%23.md",
      "src/api/app.py",
      "src/api/app.py#App",
      "src/api/app.py#App.run",
      "src/api/app.py#create_app",
      "src/api/routes.py",
      "src/api/routes.py#router",
      "tests/test_routes.py",
      "tests/test_routes.py#test_list",
      "web/src/api.ts",
      "web/src/api.ts#fetchJson",
      "web/src/main.tsx",
      "web/src/main.tsx#Main",
    ]);
    expect(manifest.membership["src/api/app.py#App.run"]).toEqual(
      manifest.membership["src/api/app.py"],
    );
  });

  it("weighs members by role and by how much of their edge weight stays in the feature", () => {
    expect(manifest.membership["src/api/app.py"]).toEqual({ featureId: "http-api", weight: 1 });
    expect(manifest.membership["tests/test_routes.py"]).toEqual({
      featureId: "http-api",
      weight: 0.5,
    });
    const split = proposal({
      clusters: [
        { cluster: "c01", feature: "http-api", role: "core" },
        { cluster: "c02", feature: "web-frontend", role: "core" },
        { cluster: "c03", feature: "web-frontend", role: "core" },
      ],
    });
    // app.py's edges: 4/3 to docs (same feature) and 1.3 to routes.py (now another feature).
    expect(proposalToManifest(split, index, graph, clusters).membership["src/api/app.py"]).toEqual({
      featureId: "http-api",
      weight: 0.506,
    });
  });

  it("drops features with no clusters and caps aliases at eight", () => {
    const extra = proposal({
      features: [
        { ...API, aliases: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] },
        WEB,
        { id: "unused", title: "Unused", aliases: ["x", "y", "z"] },
      ],
    });
    const result = proposalToManifest(extra, index, graph, clusters);
    expect(result.features.map((f) => f.id)).toEqual(["http-api", "web-frontend"]);
    expect(result.features[0]?.aliases).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/manifest/to-manifest.test.ts`
Expected: FAIL, because `./to-manifest.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/manifest/to-manifest.ts`:
```ts
import { Manifest, type Membership } from "@repowiki/core";
import type { Cluster, FileGraph } from "../cluster/index.ts";
import type { RepoIndex } from "../index/index.ts";
import { cleanAliases, MAX_ALIASES, type ManifestProposal } from "./proposal.ts";

const ROLE_FACTOR = { core: 1, supporting: 0.5 } as const;
/** The lowest centrality a member can have, so every weight stays above zero. */
const MIN_CENTRALITY = 0.05;

/**
 * Turns an accepted proposal into a new manifest. Features no cluster was assigned to are left
 * out (they would be empty pages), and aliases are capped at MAX_ALIASES. Every file and every
 * symbol is a member of its cluster's feature. A member's weight is its role factor (core 1,
 * supporting 0.5) times its centrality: the share of its edge weight that stays in its feature.
 */
export function proposalToManifest(
  proposal: ManifestProposal,
  index: RepoIndex,
  graph: FileGraph,
  clusters: readonly Cluster[],
): Manifest {
  const filesOf = new Map(clusters.map((c) => [c.id, c.files]));
  const owner = new Map<string, { featureId: string; role: "core" | "supporting" }>();
  for (const { cluster, feature, role } of proposal.clusters) {
    for (const file of filesOf.get(cluster) ?? []) owner.set(file, { featureId: feature, role });
  }
  const inside = new Map<string, number>();
  const total = new Map<string, number>();
  for (const { a, b, weight } of graph.edges) {
    const same = owner.get(a)?.featureId === owner.get(b)?.featureId;
    for (const file of [a, b]) {
      total.set(file, (total.get(file) ?? 0) + weight);
      if (same) inside.set(file, (inside.get(file) ?? 0) + weight);
    }
  }

  const membership: Record<string, Membership> = {};
  for (const file of index.files) {
    const assigned = owner.get(file.path);
    if (assigned === undefined) continue;
    const all = total.get(file.path) ?? 0;
    const centrality = Math.max(MIN_CENTRALITY, all === 0 ? 0 : (inside.get(file.path) ?? 0) / all);
    const weight = Math.round(ROLE_FACTOR[assigned.role] * centrality * 1000) / 1000;
    const member = { featureId: assigned.featureId, weight };
    membership[file.id] = member;
    for (const symbol of file.symbols) membership[symbol.id] = member;
  }

  return Manifest.parse({
    sha: index.sha,
    features: proposal.features
      .filter((feature) => proposal.clusters.some((c) => c.feature === feature.id))
      .map((feature) => ({
        id: feature.id,
        title: feature.title.trim(),
        aliases: cleanAliases(feature.title, feature.aliases).slice(0, MAX_ALIASES),
        status: { kind: "active" },
        lineage: [{ kind: "create", sha: index.sha }],
      })),
    membership,
  });
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (4 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src/manifest
git commit -m "feat(manifest): turn a proposal into weighted membership"
```

Ship. PR title: `feat(manifest): membership and weights`.

---

### Task 16: Manifest prompt

**Ticket:** `[M3] manifest: prompt`

**Files:**
- Create: `packages/engine/src/manifest/prompt.ts`
- Test: `packages/engine/src/manifest/prompt.test.ts`

**Interfaces:**
- Consumes: `ClusterSummary` (Task 13).
- Produces:
  ```ts
  const MANIFEST_INSTRUCTIONS: string   // frozen; heads the cached prefix
  manifestSystemPrompt(repoName: string, sha: string, summaries: readonly ClusterSummary[]): string
  const MANIFEST_REQUEST = "Group these clusters into the wiki's feature pages."
  retryMessages(rejected: string, problems: readonly string[]): LlmMessage[]   // assistant turn, then user turn
  estimateTokens(text: string): number   // ceil(chars / 2.5)
  ```
- How the prompt is split for caching:
  - The system prompt (instructions plus every cluster) is the stable prefix. It is byte-identical for the same index: no timestamps, no unordered iteration.
  - The user turn is the short request, and on a retry the rejected answer and its problems follow it, so a retry reuses the cached prefix.
  - On next-chief-of-staff the prefix is about 14,200 real tokens, above Haiku 4.5's 4096-token cache minimum, so it caches.
  - `estimateTokens` is deliberately pessimistic: the prototype measured 2.7 characters per token on these path-heavy digests (38,396 characters, 14,239 tokens).

- [ ] **Step 1: Branch**

```bash
git switch -c m3/manifest-prompt
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/manifest/prompt.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { ClusterSummary } from "../cluster/index.ts";
import {
  estimateTokens,
  MANIFEST_INSTRUCTIONS,
  manifestSystemPrompt,
  retryMessages,
} from "./prompt.ts";

const full: ClusterSummary = {
  id: "c01",
  fileCount: 4,
  symbolCount: 7,
  languages: ["python 3", "other 1"],
  directories: [
    { dir: "src/api", files: 3 },
    { dir: "(root)", files: 1 },
  ],
  files: ["src/api/app.py", "src/api/routes.py"],
  symbols: ["src/api/app.py#App", "src/api/app.py#create_app"],
  externalImports: ["fastapi", "pydantic"],
  neighbours: [{ id: "c02", weight: 2.5 }],
};
const bare: ClusterSummary = {
  ...full,
  id: "c02",
  fileCount: 1,
  symbolCount: 0,
  languages: ["other 1"],
  directories: [{ dir: "docs", files: 1 }],
  files: ["docs/C#.md"],
  symbols: [],
  externalImports: [],
  neighbours: [],
};

describe("manifestSystemPrompt", () => {
  const prompt = manifestSystemPrompt("demo", "a".repeat(40), [full, bare]);

  it("puts the frozen instructions first, then the repository and every cluster", () => {
    expect(prompt.startsWith(MANIFEST_INSTRUCTIONS)).toBe(true);
    expect(prompt).toContain(`# Repository demo at ${"a".repeat(40)}: 2 clusters`);
  });

  it("renders a cluster's names and structure, noting files left out", () => {
    expect(prompt).toContain(
      [
        "## c01: 4 files, 7 symbols (python 3, other 1)",
        "directories: src/api (3), (root) (1)",
        "files: src/api/app.py, src/api/routes.py, and 2 more",
        "symbols: src/api/app.py#App, src/api/app.py#create_app",
        "external imports: fastapi, pydantic",
        "connected to: c02 (2.5)",
      ].join("\n"),
    );
  });

  it("leaves out empty listings", () => {
    expect(
      prompt.endsWith(
        "## c02: 1 files, 0 symbols (other 1)\ndirectories: docs (1)\nfiles: docs/C#.md",
      ),
    ).toBe(true);
  });

  it("is byte-identical for the same input, so the prefix caches", () => {
    expect(manifestSystemPrompt("demo", "a".repeat(40), [full, bare])).toBe(prompt);
  });
});

describe("estimateTokens", () => {
  it("assumes 2.5 characters per token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("abcdef")).toBe(3);
  });
});

describe("retryMessages", () => {
  it("replays the rejected answer and lists the reasons", () => {
    expect(retryMessages('{"features":[]}', ["cluster c01 is not assigned", "x"])).toEqual([
      { role: "assistant", content: '{"features":[]}' },
      {
        role: "user",
        content:
          "That answer was rejected:\n- cluster c01 is not assigned\n- x\nReturn the corrected JSON object.",
      },
    ]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/manifest/prompt.test.ts`
Expected: FAIL, because `./prompt.ts` does not exist.

- [ ] **Step 4: Implement**

Keep the instruction text exactly as written. The Task 18 cassette replays only if the request bytes match, and the wording was tuned live (see the Task 19 notes).

`packages/engine/src/manifest/prompt.ts`:
```ts
import type { ClusterSummary } from "../cluster/index.ts";

/** Instructions for the manifest call. Frozen text: it heads the prompt-cached prefix. */
export const MANIFEST_INSTRUCTIONS = `You are the editor of RepoWiki, a Wikipedia-style wiki that documents one git repository. Pages are scoped by feature, not by folder. Your job is to decide the wiki's feature pages.

You receive clusters of files. Each cluster was computed from the repository's import graph, from which files change together in commits, and weakly from directories. A cluster lists its size, languages, directories, its best-connected files, exported symbols, the packages it imports from outside the repository, and the clusters it is most connected to. You never see source code.

How to group clusters into features:
- A feature is a capability a reader would look up: "Signal ingestion", "GitHub integration", "Deployment infrastructure". It is not a folder name and not a layer such as "utils" or "models".
- Prefer focused pages: most clusters become a feature of their own. Merge clusters only when they implement the same capability, and keep them apart when they serve different purposes, even if they share a directory.
- Tests, fixtures, scripts, configuration, CI and documentation join the feature they serve. Make a separate feature (for example "Continuous integration" or "Developer tooling") only for a cluster that serves the repository as a whole.

Return two lists.

features: one entry per feature, with
- id: a permanent URL slug, lowercase kebab-case (a-z, 0-9, single hyphens), 2 to 4 words, at most 40 characters, unique, e.g. "signal-ingestion". Ids are never reused, so name the capability, not the current folder.
- title: a Wikipedia article title in sentence case, e.g. "Signal ingestion". Titles are unique.
- aliases: 3 to 8 other names a reader might search for: synonyms, abbreviations, and names taken from the code (module, class, route, table or command names). Do not repeat the title.

clusters: exactly one entry per cluster, in cluster id order, with
- cluster: the cluster id.
- feature: the id of the feature it belongs to.
- role: "core" when the cluster implements the feature, "supporting" when it holds tests, fixtures, configuration or documentation for it.

Every feature needs at least one cluster. Answer with the JSON object only.`;

/**
 * Rough token count, deliberately pessimistic: path-heavy digests measured 2.7 characters per
 * token on Haiku 4.5, so this assumes 2.5.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function renderCluster(summary: ClusterSummary): string {
  const more = summary.fileCount - summary.files.length;
  const lines = [
    `## ${summary.id}: ${summary.fileCount} files, ${summary.symbolCount} symbols (${summary.languages.join(", ")})`,
    `directories: ${summary.directories.map((d) => `${d.dir} (${d.files})`).join(", ")}`,
    `files: ${summary.files.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
  ];
  if (summary.symbols.length > 0) lines.push(`symbols: ${summary.symbols.join(", ")}`);
  if (summary.externalImports.length > 0) {
    lines.push(`external imports: ${summary.externalImports.join(", ")}`);
  }
  if (summary.neighbours.length > 0) {
    lines.push(
      `connected to: ${summary.neighbours.map((n) => `${n.id} (${n.weight})`).join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** The cached prefix: instructions, then every cluster. Deterministic for a given index. */
export function manifestSystemPrompt(
  repoName: string,
  sha: string,
  summaries: readonly ClusterSummary[],
): string {
  return [
    MANIFEST_INSTRUCTIONS,
    `# Repository ${repoName} at ${sha}: ${summaries.length} clusters`,
    ...summaries.map(renderCluster),
  ].join("\n\n");
}

export const MANIFEST_REQUEST = "Group these clusters into the wiki's feature pages.";

/** The retry turn: the rejected answer and why it was rejected (spec §6.3: retry once). */
export function retryMessages(rejected: string, problems: readonly string[]) {
  return [
    { role: "assistant" as const, content: rejected },
    {
      role: "user" as const,
      content: `That answer was rejected:\n${problems.map((p) => `- ${p}`).join("\n")}\nReturn the corrected JSON object.`,
    },
  ];
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (6 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src/manifest
git commit -m "feat(manifest): write the manifest prompt and cluster digest"
```

Ship. PR title: `feat(manifest): prompt`.

---

### Task 17: buildManifest

**Ticket:** `[M3] manifest: buildManifest`

**Files:**
- Create: `packages/engine/src/manifest/build.ts`, `packages/engine/src/manifest/index.ts`, `packages/engine/src/manifest/test-provider.ts` (test support)
- Modify: `packages/engine/package.json` (`@repowiki/llm`), `pnpm-lock.yaml`
- Test: `packages/engine/src/manifest/build.test.ts`

**Interfaces:**
- Consumes: `Provider`, `LlmMessage`, `LlmOutputError` from `@repowiki/llm` (Tasks 5, 8); cluster functions (Tasks 10–13); Tasks 14–16.
- Produces:
  ```ts
  interface ManifestBuildOptions { provider: Provider; repoName: string; batch?: boolean /* default true */; maxPromptTokens?: number; graphWeights?: GraphWeights; clusterOptions?: ClusterOptions }
  interface ManifestBuild { manifest: Manifest; clusters: Cluster[]; summaries: ClusterSummary[]; rejected: string[]; promptTokens: number }
  class ManifestBuildError extends Error
  const DEFAULT_MAX_PROMPT_TOKENS = 150_000
  buildManifest(index: RepoIndex, options: ManifestBuildOptions): Promise<ManifestBuild>
  // test-only (test-provider.ts): SAMPLE_CLUSTER_OPTIONS, SAMPLE_PROPOSAL, scriptedProvider(...answers)
  ```
- How a build runs:
  - **The call.** One `manifest` call with `cacheKey: "manifest-<sha>"`, `maxTokens: 16000`, and `batch: true` by default, since no one waits on a build and the Batches API halves the price.
  - **The budget.** If the estimated prompt exceeds `maxPromptTokens`, the file and symbol listings are halved until it fits; the clusters stay. 150K plus 16K of output stays under Haiku 4.5's 200K context. If nothing fits, it throws.
  - **The retry.** A rejected answer (an `LlmOutputError`, or any `proposalProblems`) is retried once with the problems (spec §6.3), keeping the same system prefix and cacheKey. A second rejection throws `ManifestBuildError`.
  - **Provider errors.** These are not retried here, because the SDK already retried them.
  - **Empty commits.** An index with no files throws.
- `rejected` holds the first answer's problems when a retry happened, and is `[]` otherwise.

- [ ] **Step 1: Branch and depend on the llm package**

```bash
git switch -c m3/manifest-build
pnpm --filter @repowiki/engine add "@repowiki/llm@workspace:*"
```

- [ ] **Step 2: Add the scripted provider and write the failing tests**

`packages/engine/src/manifest/test-provider.ts`:
```ts
import type { GenerateRequest, Provider } from "@repowiki/llm";
import type { ManifestProposal } from "./proposal.ts";

/** Splits sampleIndex() into c01 (docs + app), c02 (routes + test), c03 (frontend). */
export const SAMPLE_CLUSTER_OPTIONS = { resolution: 1, minClusterSize: 1 };

/** An answer that sampleIndex() accepts. */
export const SAMPLE_PROPOSAL: ManifestProposal = {
  features: [
    { id: "http-api", title: "HTTP API", aliases: ["API server", "FastAPI app", "routes"] },
    { id: "web-frontend", title: "Web frontend", aliases: ["UI", "React app", "dashboard"] },
  ],
  clusters: [
    { cluster: "c01", feature: "http-api", role: "core" },
    { cluster: "c02", feature: "http-api", role: "supporting" },
    { cluster: "c03", feature: "web-frontend", role: "core" },
  ],
};

/** A provider that answers from a script, in order, and remembers every request. Test-only. */
export function scriptedProvider(...answers: (ManifestProposal | Error)[]) {
  const requests: GenerateRequest<unknown>[] = [];
  const provider: Provider = {
    async generate<T>(request: GenerateRequest<T>) {
      requests.push(request as GenerateRequest<unknown>);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("no scripted answer left");
      if (answer instanceof Error) throw answer;
      const usage = { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 };
      return { output: request.schema.parse(answer), usage, model: "claude-haiku-4-5" };
    },
  };
  return { provider, requests };
}
```

`packages/engine/src/manifest/build.test.ts`:
```ts
import { LlmError, LlmOutputError, type Provider } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { buildManifest, ManifestBuildError } from "./build.ts";
import type { ManifestProposal } from "./proposal.ts";
import { sampleIndex } from "./test-index.ts";
import { SAMPLE_CLUSTER_OPTIONS, SAMPLE_PROPOSAL, scriptedProvider } from "./test-provider.ts";

const GOOD = SAMPLE_PROPOSAL;
const MISSING_C03: ManifestProposal = { ...GOOD, clusters: GOOD.clusters.slice(0, 2) };
const options = (provider: Provider) => ({
  provider,
  repoName: "sample",
  clusterOptions: SAMPLE_CLUSTER_OPTIONS,
});

describe("buildManifest", () => {
  it("makes one batched, cached manifest call over the cluster digest", async () => {
    const { provider, requests } = scriptedProvider(GOOD);
    const build = await buildManifest(sampleIndex(), options(provider));
    expect(build.manifest.features.map((f) => f.id)).toEqual(["http-api", "web-frontend"]);
    expect(build.rejected).toEqual([]);
    expect(build.clusters.map((c) => c.id)).toEqual(["c01", "c02", "c03"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      purpose: "manifest",
      batch: true,
      cacheKey: `manifest-${"c".repeat(40)}`,
      messages: [{ role: "user", content: "Group these clusters into the wiki's feature pages." }],
    });
    expect(requests[0]?.system).toContain(`# Repository sample at ${"c".repeat(40)}: 3 clusters`);
    expect(requests[0]?.system).toContain("## c03: 2 files, 2 symbols (tsx 1, typescript 1)");
    expect(requests[0]?.system).toContain(
      "symbols: web/src/api.ts#fetchJson, web/src/main.tsx#Main",
    );
  });

  it("can make the call without the Batches API", async () => {
    const { provider, requests } = scriptedProvider(GOOD);
    await buildManifest(sampleIndex(), { ...options(provider), batch: false });
    expect(requests[0]?.batch).toBe(false);
  });

  it("retries once with the reasons, keeping the cached prefix", async () => {
    const { provider, requests } = scriptedProvider(MISSING_C03, GOOD);
    const build = await buildManifest(sampleIndex(), options(provider));
    expect(build.rejected).toEqual(["cluster c03 is not assigned"]);
    expect(requests[1]?.system).toBe(requests[0]?.system);
    expect(requests[1]?.cacheKey).toBe(requests[0]?.cacheKey);
    expect(requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(requests[1]?.messages[2]?.content).toContain("- cluster c03 is not assigned");
  });

  it("retries an answer that failed the output schema, quoting the raw text", async () => {
    const bad = new LlmOutputError("model output is not JSON", "oops");
    const { provider, requests } = scriptedProvider(bad, GOOD);
    await buildManifest(sampleIndex(), options(provider));
    expect(requests[1]?.messages[1]).toEqual({ role: "assistant", content: "oops" });
  });

  it("gives up after a second rejection", async () => {
    const { provider } = scriptedProvider(MISSING_C03, MISSING_C03);
    await expect(buildManifest(sampleIndex(), options(provider))).rejects.toThrow(
      ManifestBuildError,
    );
  });

  it("does not retry provider failures; the SDK already retried them", async () => {
    const { provider, requests } = scriptedProvider(new LlmError("overloaded"), GOOD);
    await expect(buildManifest(sampleIndex(), options(provider))).rejects.toThrow("overloaded");
    expect(requests).toHaveLength(1);
  });

  it("shrinks the listings to fit the prompt budget, and refuses when nothing fits", async () => {
    const full = await buildManifest(sampleIndex(), options(scriptedProvider(GOOD).provider));
    const { provider, requests } = scriptedProvider(GOOD);
    await buildManifest(sampleIndex(), {
      ...options(provider),
      maxPromptTokens: full.promptTokens - 10,
    });
    expect(requests[0]?.system).not.toContain("web/src/main.tsx#Main");
    const tiny = { ...options(scriptedProvider(GOOD).provider), maxPromptTokens: 100 };
    await expect(buildManifest(sampleIndex(), tiny)).rejects.toThrow(/do not fit/);
  });

  it("refuses a commit with no files", async () => {
    const empty = { ...sampleIndex(), files: [], imports: [], unresolved: [] };
    await expect(buildManifest(empty, options(scriptedProvider(GOOD).provider))).rejects.toThrow(
      /no files/,
    );
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/manifest/build.test.ts`
Expected: FAIL, because `./build.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/manifest/build.ts`:
```ts
import type { Manifest } from "@repowiki/core";
import { type LlmMessage, LlmOutputError, type Provider } from "@repowiki/llm";
import {
  buildFileGraph,
  type Cluster,
  type ClusterOptions,
  type ClusterSummary,
  clusterFiles,
  DEFAULT_CLUSTER_OPTIONS,
  DEFAULT_GRAPH_WEIGHTS,
  DEFAULT_SUMMARY_LIMITS,
  type GraphWeights,
  summarizeClusters,
} from "../cluster/index.ts";
import type { RepoIndex } from "../index/index.ts";
import { estimateTokens, MANIFEST_REQUEST, manifestSystemPrompt, retryMessages } from "./prompt.ts";
import { ManifestProposal, proposalProblems } from "./proposal.ts";
import { proposalToManifest } from "./to-manifest.ts";

export interface ManifestBuildOptions {
  provider: Provider;
  repoName: string;
  /** Use the Message Batches API (half price). Default true: no one waits on a build. */
  batch?: boolean;
  /** Haiku 4.5 has a 200K context; the prompt must leave room for the answer. */
  maxPromptTokens?: number;
  graphWeights?: GraphWeights;
  clusterOptions?: ClusterOptions;
}

export interface ManifestBuild {
  manifest: Manifest;
  clusters: Cluster[];
  summaries: ClusterSummary[];
  /** Why the first answer was rejected, when it was; the second answer was then accepted. */
  rejected: string[];
  /** Estimated size of the cached prefix (instructions plus cluster digest). */
  promptTokens: number;
}

export class ManifestBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export const DEFAULT_MAX_PROMPT_TOKENS = 150_000;
const MAX_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 16_000;

/** index → clusters → one LLM call (plus at most one retry) → a validated new manifest. */
export async function buildManifest(
  index: RepoIndex,
  options: ManifestBuildOptions,
): Promise<ManifestBuild> {
  if (index.files.length === 0)
    throw new ManifestBuildError(`${index.sha} has no files to document`);
  const graph = buildFileGraph(index, options.graphWeights ?? DEFAULT_GRAPH_WEIGHTS);
  const clusters = clusterFiles(graph, options.clusterOptions ?? DEFAULT_CLUSTER_OPTIONS);
  const maxPromptTokens = options.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS;

  // Shrink the per-cluster listings until the prompt fits; the cluster count never changes.
  let limits = DEFAULT_SUMMARY_LIMITS;
  let summaries = summarizeClusters(index, graph, clusters, limits);
  let system = manifestSystemPrompt(options.repoName, index.sha, summaries);
  while (estimateTokens(system) > maxPromptTokens) {
    if (limits.files <= 1 && limits.symbols === 0) {
      throw new ManifestBuildError(
        `${clusters.length} clusters do not fit in ${maxPromptTokens} prompt tokens`,
      );
    }
    limits = {
      ...limits,
      files: Math.max(1, Math.floor(limits.files / 2)),
      symbols: Math.floor(limits.symbols / 2),
    };
    summaries = summarizeClusters(index, graph, clusters, limits);
    system = manifestSystemPrompt(options.repoName, index.sha, summaries);
  }

  let messages: LlmMessage[] = [{ role: "user", content: MANIFEST_REQUEST }];
  let rejected: string[] = [];
  for (let attempt = 1; ; attempt++) {
    let problems: string[];
    let answer: string;
    try {
      const { output } = await options.provider.generate({
        purpose: "manifest",
        system,
        messages,
        schema: ManifestProposal,
        maxTokens: MAX_OUTPUT_TOKENS,
        cacheKey: `manifest-${index.sha}`,
        batch: options.batch ?? true,
      });
      problems = proposalProblems(output, clusters);
      if (problems.length === 0) {
        const manifest = proposalToManifest(output, index, graph, clusters);
        return { manifest, clusters, summaries, rejected, promptTokens: estimateTokens(system) };
      }
      answer = JSON.stringify(output);
    } catch (error) {
      if (!(error instanceof LlmOutputError)) throw error;
      problems = [error.message];
      answer = error.text;
    }
    if (attempt === MAX_ATTEMPTS) {
      throw new ManifestBuildError(
        `the manifest answer was rejected twice: ${problems.join("; ")}`,
      );
    }
    rejected = problems;
    messages = [{ role: "user", content: MANIFEST_REQUEST }, ...retryMessages(answer, problems)];
  }
}
```

`packages/engine/src/manifest/index.ts`:
```ts
export {
  buildManifest,
  DEFAULT_MAX_PROMPT_TOKENS,
  type ManifestBuild,
  ManifestBuildError,
  type ManifestBuildOptions,
} from "./build.ts";
export { ManifestProposal } from "./proposal.ts";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (8 new tests). The boundary test passes: `build.ts` reaches other modules only through `../cluster/index.ts` and `../index/index.ts`.

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine pnpm-lock.yaml
git commit -m "feat(manifest): build a manifest from clusters with one LLM call"
```

Ship. PR title: `feat(manifest): buildManifest`.

---

### Task 18: Storing the manifest, the review summary, and a recorded run

**Ticket:** `[M3] manifest: store, summary, recorded run`

**Files:**
- Create: `packages/engine/src/manifest/ensure.ts`, `packages/engine/src/manifest/summary.ts`, and by recording `packages/engine/src/manifest/__cassettes__/sample-manifest.json`
- Modify: `packages/engine/src/manifest/index.ts`, `packages/engine/src/index.ts`
- Test: `packages/engine/src/manifest/ensure.test.ts`, `packages/engine/src/manifest/summary.test.ts`, `packages/engine/src/manifest/claude.test.ts`

**Interfaces:**
- Consumes: `buildManifest` (Task 17); `Store` with `getDriftBaseline` (Task 4); `LedgerTotals` (Task 5); `createClaudeProvider`, `cassetteFetch` (Tasks 6, 8).
- Produces (all exported from `@repowiki/engine`):
  ```ts
  ensureManifest(store: Store, index: RepoIndex, options: ManifestBuildOptions): Promise<{ manifest: Manifest; build: ManifestBuild | null }>
  renderManifestSummary(repoName: string, manifest: Manifest, totals: LedgerTotals | null): string   // Markdown
  ```
- `ensureManifest` has three cases:
  - **Same sha stored.** It returns the stored manifest with `build: null`, and no LLM call is made.
  - **Empty store.** It builds the manifest and stores it with `llmRevised: true`, which makes it the drift baseline.
  - **Another sha stored.** It throws `ManifestBuildError`: moving to a new sha is an update that revises the prior manifest (spec §4, §6.1, M6), never a rebuild.
- The summary has a table of features (file and symbol counts), then each feature's aliases and five heaviest files with their paths decoded from member ids, then the ledger's token and dollar totals.

- [ ] **Step 1: Branch**

```bash
git switch -c m3/manifest-ensure
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/manifest/ensure.test.ts`:
```ts
import { makeManifest } from "@repowiki/core/test-fixtures";
import type { Provider } from "@repowiki/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/index.ts";
import { ensureManifest } from "./ensure.ts";
import { sampleIndex } from "./test-index.ts";
import { SAMPLE_CLUSTER_OPTIONS, SAMPLE_PROPOSAL, scriptedProvider } from "./test-provider.ts";

const options = (provider: Provider) => ({
  provider,
  repoName: "sample",
  clusterOptions: SAMPLE_CLUSTER_OPTIONS,
});

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => store.close());

describe("ensureManifest", () => {
  it("builds and stores the first manifest as the drift baseline", async () => {
    const { provider } = scriptedProvider(SAMPLE_PROPOSAL);
    const { manifest, build } = await ensureManifest(store, sampleIndex(), options(provider));
    expect(build?.manifest).toEqual(manifest);
    expect(store.getLatestManifest()).toEqual(manifest);
    expect(store.getDriftBaseline()).toEqual(manifest);
  });

  it("returns the stored manifest for the same sha without calling the LLM", async () => {
    await ensureManifest(store, sampleIndex(), options(scriptedProvider(SAMPLE_PROPOSAL).provider));
    const { provider, requests } = scriptedProvider();
    const again = await ensureManifest(store, sampleIndex(), options(provider));
    expect(again.build).toBeNull();
    expect(again.manifest.sha).toBe("c".repeat(40));
    expect(requests).toHaveLength(0);
  });

  it("refuses to rebuild over a manifest for another sha", async () => {
    store.putManifest(makeManifest());
    const { provider, requests } = scriptedProvider(SAMPLE_PROPOSAL);
    await expect(ensureManifest(store, sampleIndex(), options(provider))).rejects.toThrow(
      /is an update, not a build/,
    );
    expect(requests).toHaveLength(0);
  });
});
```

`packages/engine/src/manifest/summary.test.ts`:
```ts
import { makeManifest } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { renderManifestSummary } from "./summary.ts";

const manifest = makeManifest({
  membership: {
    "src/signals/ingest.py": { featureId: "signals", weight: 0.9 },
    "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 },
    "src/signals/score.py": { featureId: "signals", weight: 0.4 },
    "docs/C%23.md": { featureId: "deliverables", weight: 0.5 },
  },
});

describe("renderManifestSummary", () => {
  const totals = {
    calls: 2,
    batchCalls: 2,
    tokens: { in: 1200, out: 3400, cacheRead: 15_000, cacheWrite: 15_000 },
    usd: 0.0187,
    unpricedCalls: 0,
  };
  const text = renderManifestSummary("demo", manifest, totals);

  it("lists every feature with its file and symbol counts", () => {
    expect(text).toContain("# Manifest: demo at aaaaaaa");
    expect(text).toContain("2 features, 3 files, 1 symbols.");
    expect(text).toContain("| `signals` | Signal ingestion | 2 | 1 |");
    expect(text).toContain("| `deliverables` | Deliverables | 1 | 0 |");
  });

  it("shows aliases and the heaviest files, decoding member ids", () => {
    expect(text).toContain("Aliases: signal pipeline");
    expect(text.indexOf("`src/signals/ingest.py` (0.9)")).toBeLessThan(
      text.indexOf("`src/signals/score.py` (0.4)"),
    );
    expect(text).toContain("`docs/C#.md` (0.5)");
  });

  it("ends with the token and dollar totals", () => {
    expect(text).toContain(
      "2 calls (2 batched): 1,200 input, 3,400 output, 15,000 cache-read, 15,000 cache-write tokens.",
    );
    expect(text).toContain("Cost: $0.0187.");
    expect(renderManifestSummary("demo", manifest, null)).not.toContain("LLM cost");
  });
});
```

This test runs the real provider end to end against the sample index, through a cassette. It uses `batch: false` so that recording takes seconds, not minutes; Task 9 already covers batching against the API.

`packages/engine/src/manifest/claude.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { Manifest } from "@repowiki/core";
import {
  cassetteFetch,
  cassetteMode,
  createClaudeProvider,
  createLedger,
  DEFAULT_MODELS,
} from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { buildManifest } from "./build.ts";
import { sampleIndex } from "./test-index.ts";

const mode = cassetteMode();
const CASSETTE = fileURLToPath(new URL("./__cassettes__/sample-manifest.json", import.meta.url));

describe("buildManifest with Claude (cassette)", () => {
  it("turns the sample index into a valid manifest in one or two calls", async () => {
    const ledger = createLedger();
    const provider = createClaudeProvider({
      models: DEFAULT_MODELS,
      ledger,
      runId: "test-run",
      apiKey: mode === "record" ? undefined : "cassette-replay",
      fetch: cassetteFetch(CASSETTE, mode),
      now: () => new Date("2026-10-01T12:00:00Z"),
    });
    const index = sampleIndex();
    const build = await buildManifest(index, {
      provider,
      repoName: "sample",
      batch: false,
      clusterOptions: { resolution: 1, minClusterSize: 1 },
    });
    expect(Manifest.parse(build.manifest)).toEqual(build.manifest);
    expect(Object.keys(build.manifest.membership)).toHaveLength(13);
    expect(build.manifest.features.length).toBeGreaterThanOrEqual(1);
    expect(ledger.entries().length).toBe(build.rejected.length === 0 ? 1 : 2);
    expect(ledger.entries().every((e) => e.purpose === "manifest" && !e.batch)).toBe(true);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/manifest/ensure.test.ts packages/engine/src/manifest/summary.test.ts packages/engine/src/manifest/claude.test.ts`
Expected: FAIL: `./ensure.ts` and `./summary.ts` do not exist, and `claude.test.ts` throws `CassetteMissError`.

- [ ] **Step 4: Implement**

`packages/engine/src/manifest/ensure.ts`:
```ts
import type { Manifest } from "@repowiki/core";
import type { RepoIndex } from "../index/index.ts";
import type { Store } from "../store/index.ts";
import {
  buildManifest,
  type ManifestBuild,
  ManifestBuildError,
  type ManifestBuildOptions,
} from "./build.ts";

/**
 * Returns the manifest for index.sha, building and storing it (as the drift baseline) when the
 * store has none. A store that already holds a manifest for another sha needs an update, which
 * revises the prior manifest instead of rebuilding it (spec §4, §6.1), so this refuses.
 */
export async function ensureManifest(
  store: Store,
  index: RepoIndex,
  options: ManifestBuildOptions,
): Promise<{ manifest: Manifest; build: ManifestBuild | null }> {
  const stored = store.getManifest(index.sha);
  if (stored !== null) return { manifest: stored, build: null };
  const latest = store.getLatestManifest();
  if (latest !== null) {
    throw new ManifestBuildError(
      `the store already has a manifest for ${latest.sha}; moving to ${index.sha} is an update, not a build`,
    );
  }
  const build = await buildManifest(index, options);
  store.putManifest(build.manifest, { llmRevised: true });
  return { manifest: build.manifest, build };
}
```

`packages/engine/src/manifest/summary.ts`:
```ts
import { type Manifest, parseMemberId } from "@repowiki/core";
import type { LedgerTotals } from "@repowiki/llm";

const TOP_FILES = 5;
const count = (n: number): string => n.toLocaleString("en-US");

/** The manifest as Markdown for the owner's review, with the LLM cost of producing it. */
export function renderManifestSummary(
  repoName: string,
  manifest: Manifest,
  totals: LedgerTotals | null,
): string {
  const files = new Map<string, { path: string; weight: number }[]>();
  const symbols = new Map<string, number>();
  for (const [id, { featureId, weight }] of Object.entries(manifest.membership)) {
    const parsed = parseMemberId(id);
    if (parsed === null) continue;
    if (parsed.symbol === null)
      files.set(featureId, [...(files.get(featureId) ?? []), { path: parsed.path, weight }]);
    else symbols.set(featureId, (symbols.get(featureId) ?? 0) + 1);
  }
  const fileTotal = [...files.values()].reduce((n, list) => n + list.length, 0);
  const symbolTotal = [...symbols.values()].reduce((n, k) => n + k, 0);

  const lines = [
    `# Manifest: ${repoName} at ${manifest.sha.slice(0, 7)}`,
    "",
    `${manifest.features.length} features, ${count(fileTotal)} files, ${count(symbolTotal)} symbols.`,
    "",
    "| Feature | Title | Files | Symbols |",
    "|---|---|---:|---:|",
    ...manifest.features.map(
      (f) =>
        `| \`${f.id}\` | ${f.title} | ${files.get(f.id)?.length ?? 0} | ${symbols.get(f.id) ?? 0} |`,
    ),
  ];
  for (const feature of manifest.features) {
    const top = [...(files.get(feature.id) ?? [])]
      .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : 1))
      .slice(0, TOP_FILES);
    lines.push(
      "",
      `## ${feature.title} (\`${feature.id}\`)`,
      "",
      `Aliases: ${feature.aliases.join(", ")}`,
      "",
      ...top.map((f) => `- \`${f.path}\` (${f.weight})`),
    );
  }
  if (totals !== null) {
    const t = totals.tokens;
    lines.push(
      "",
      "## LLM cost",
      "",
      `${totals.calls} calls (${totals.batchCalls} batched): ${count(t.in)} input, ${count(t.out)} output, ${count(t.cacheRead)} cache-read, ${count(t.cacheWrite)} cache-write tokens.`,
      "",
      `Cost: $${totals.usd.toFixed(4)}${totals.unpricedCalls > 0 ? ` (plus ${totals.unpricedCalls} calls to unpriced models)` : ""}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
```

Replace `packages/engine/src/manifest/index.ts` with:
```ts
export {
  buildManifest,
  DEFAULT_MAX_PROMPT_TOKENS,
  type ManifestBuild,
  ManifestBuildError,
  type ManifestBuildOptions,
} from "./build.ts";
export { ensureManifest } from "./ensure.ts";
export { ManifestProposal } from "./proposal.ts";
export { renderManifestSummary } from "./summary.ts";
```

In `packages/engine/src/index.ts`, add the manifest exports after the index export block. Replace:
```ts
} from "./index/index.ts";
```
with:
```ts
} from "./index/index.ts";
export {
  buildManifest,
  DEFAULT_MAX_PROMPT_TOKENS,
  ensureManifest,
  type ManifestBuild,
  ManifestBuildError,
  type ManifestBuildOptions,
  ManifestProposal,
  renderManifestSummary,
} from "./manifest/index.ts";
```

- [ ] **Step 5: Record the sample cassette live**

This is one synchronous Haiku call of about 1,300 input tokens, for under $0.01. The prompt is shorter than 4096 tokens, so it is not cached, as expected.

```bash
pnpm cassettes:record packages/engine/src/manifest/claude.test.ts
```

Expected: 1 test passes in record mode. The cassette holds one or two POSTs to `/v1/messages` (two only if the first answer was rejected and retried) and no key.

- [ ] **Step 6: Run the check (replay) to verify it passes**

Run: `pnpm check`
Expected: PASS (7 new tests).

- [ ] **Step 7: Commit and ship**

```bash
git add packages/engine/src
git commit -m "feat(manifest): store the manifest and summarize it for review"
```

Ship. PR title: `feat(manifest): store, summary, recorded run`.

---

### Task 19: Dev command and the next-chief-of-staff run

**Ticket:** `[M3] manifest: dev command and next-chief-of-staff run`

**Files:**
- Create: `scripts/out-dir.ts`, `scripts/manifest-build.ts`
- Modify: root `package.json` (the `@repowiki/llm` devDependency and the `manifest:build` script), `CLAUDE.md` (commands), `pnpm-lock.yaml`
- Test: `scripts/out-dir.test.ts`

**Interfaces:**
- Consumes: `indexRepo`, `openStore`, `ensureManifest`, `renderManifestSummary` from `@repowiki/engine`; `createClaudeProvider`, `createLedger`, `resolveModels` from `@repowiki/llm`.
- Produces: `resolveOutDir(repo: string, out: string): string | null` in `scripts/out-dir.ts`. It returns the canonical directory, or null when the directory is the repo, inside it (after resolving symlinks in the existing part of the path), under a file, or unresolvable. It is the directory counterpart of M2's `resolveOutPath`, which refuses directories by design.
- Produces: `pnpm manifest:build <repo> [rev] [--out dir] [--config file.json] [--no-batch]`. What it does:
  - It indexes the commit and opens `<out>/wiki.db`. The default `<out>` is `~/.repowiki/<repo-name>/`.
  - It persists every LLM call to the store's ledger as it happens, and runs `ensureManifest`.
  - It writes `<out>/manifest-<sha7>.json` and `<out>/manifest-<sha7>.md`. The `.md` file is the summary saved for the owner's review.
  - It prints the summary, with the ledger totals in dollars.
  - It refuses an `--out` inside the documented repo (exit 2).
  - `--config` takes an `LlmConfigFile` JSON file, e.g. `{"models":{"manifest":"claude-sonnet-5-5"}}`, so a role can be upgraded without code changes.

- [ ] **Step 1: Branch and wire the workspace dependency**

```bash
git switch -c m3/manifest-dev-command
pnpm add -D -w --save-exact "@repowiki/llm@workspace:*"
```

Add to the root `package.json` `scripts`: `"manifest:build": "node --env-file=.env scripts/manifest-build.ts"`.

In `CLAUDE.md`, add the command above the cassettes line:
```markdown
- `pnpm cassettes:record <test files>`
```
with:
```markdown
- `pnpm manifest:build <repo> [rev] [--out dir]` — index, cluster, and build the manifest live (Haiku 4.5 via the Batches API); writes only under `~/.repowiki/<repo>/` or `--out`
- `pnpm cassettes:record <test files>`
```

- [ ] **Step 2: Write the failing test for the output directory guard**

`scripts/out-dir.test.ts`:
```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOutDir } from "./out-dir.ts";

let root: string;
let repo: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "repowiki-outdir-")));
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveOutDir", () => {
  it("accepts a directory outside the repo, existing or not", () => {
    expect(resolveOutDir(repo, join(root, "wiki"))).toBe(join(root, "wiki"));
    expect(resolveOutDir(repo, join(root, "a", "b"))).toBe(join(root, "a", "b"));
  });

  it("accepts a sibling whose name starts with the repo's name", () => {
    expect(resolveOutDir(repo, join(root, "repo-wiki"))).toBe(join(root, "repo-wiki"));
  });

  it.each([
    ["the repo itself", () => repo],
    ["a directory inside it", () => join(repo, "src")],
    ["a new directory inside it", () => join(repo, "wiki", "data")],
    ["a path through ..", () => join(root, "x", "..", "repo", "wiki")],
  ])("refuses %s", (_name, out) => {
    expect(resolveOutDir(repo, out())).toBeNull();
  });

  it("refuses a symlink outside the repo that points into it", () => {
    symlinkSync(join(repo, "src"), join(root, "link"));
    expect(resolveOutDir(repo, join(root, "link", "wiki"))).toBeNull();
  });

  it("refuses a path under a file", () => {
    writeFileSync(join(root, "file.txt"), "x");
    expect(resolveOutDir(repo, join(root, "file.txt", "wiki"))).toBeNull();
  });
});
```

Run: `pnpm vitest run scripts/out-dir.test.ts`
Expected: FAIL, because `./out-dir.ts` does not exist.

- [ ] **Step 3: Implement the guard and the command**

`scripts/out-dir.ts`:
```ts
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Canonical directory to keep wiki data in, or null to refuse: inside the documented repo (after
 * resolving symlinks in the part that exists), the repo itself, under a file, or unresolvable.
 */
export function resolveOutDir(repo: string, out: string): string | null {
  try {
    let existing = resolve(out);
    const missing: string[] = [];
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) return null;
      missing.unshift(basename(existing));
      existing = parent;
    }
    if (!statSync(existing).isDirectory()) return null;
    const target = join(realpathSync.native(existing), ...missing);
    const rel = relative(realpathSync.native(repo), target);
    const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    return outside ? target : null;
  } catch {
    return null;
  }
}
```

`scripts/manifest-build.ts`:
```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureManifest, indexRepo, openStore, renderManifestSummary } from "@repowiki/engine";
import { createClaudeProvider, createLedger, resolveModels } from "@repowiki/llm";
import { resolveOutDir } from "./out-dir.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    config: { type: "string" },
    "no-batch": { type: "boolean", default: false },
  },
});
const [repoArg, rev = "HEAD"] = positionals;
if (repoArg === undefined) {
  console.error(
    "usage: pnpm manifest:build <repo-path> [rev] [--out dir] [--config file.json] [--no-batch]",
  );
  process.exit(2);
}
const repo = resolve(repoArg);
const repoName = basename(repo);
const out = resolveOutDir(repo, values.out ?? join(homedir(), ".repowiki", repoName));
if (out === null) {
  console.error(
    "refusing to write inside the documented repository; choose an --out path elsewhere",
  );
  process.exit(2);
}
const models = resolveModels(
  values.config === undefined ? {} : JSON.parse(readFileSync(values.config, "utf8")),
);

const index = await indexRepo(repo, rev);
mkdirSync(out, { recursive: true });
const store = openStore(join(out, "wiki.db"));
try {
  const runId = `manifest-build-${new Date().toISOString()}`;
  const ledger = createLedger((entry) => store.appendLedger(entry));
  const provider = createClaudeProvider({
    models,
    ledger,
    runId,
    onBatchProgress: (p) =>
      console.error(`batch ${p.id}: ${p.status} (${p.processing} processing, ${p.succeeded} done)`),
  });
  const { manifest, build } = await ensureManifest(store, index, {
    provider,
    repoName,
    batch: !values["no-batch"],
  });
  if (build === null) console.error(`reusing the stored manifest for ${index.sha}`);
  else {
    console.error(`${build.clusters.length} clusters, prompt about ${build.promptTokens} tokens`);
    if (build.rejected.length > 0) {
      console.error(`first answer rejected, retried once: ${build.rejected.join("; ")}`);
    }
  }
  const summary = renderManifestSummary(
    repoName,
    manifest,
    build === null ? null : ledger.totals(),
  );
  const stem = join(out, `manifest-${index.sha.slice(0, 7)}`);
  writeFileSync(`${stem}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(`${stem}.md`, summary);
  console.log(summary);
  console.log(`Wrote ${stem}.json and ${stem}.md for review; store: ${join(out, "wiki.db")}`);
} finally {
  store.close();
}
```

- [ ] **Step 4: Run the checks and the refusals**

Run: `pnpm check`
Expected: PASS (8 new tests).

```bash
node scripts/manifest-build.ts; echo "exit $?"
node scripts/manifest-build.ts ../next-chief-of-staff 7247d28 --out ../next-chief-of-staff/wiki; echo "exit $?"
```

Expected: the usage line and `exit 2`, then `refusing to write inside the documented repository; choose an --out path elsewhere` and `exit 2`. Neither run needs the key, and neither writes anything.

- [ ] **Step 5: Run the exit gate on next-chief-of-staff**

This needs `ANTHROPIC_API_KEY` in `.env`. It makes one batched Haiku 4.5 call (two if the first answer is rejected), for about $0.01–0.03, and waits for the batch. The prototype's batches took 4.5 and 9 minutes; the default poll is every 30 s, with progress on stderr.

```bash
touch /tmp/m3-gate-marker
pnpm manifest:build ../next-chief-of-staff 7247d28
find ../next-chief-of-staff -newer /tmp/m3-gate-marker -not -path '*/.git' -not -path '*/.git/*' | head   # expect nothing
```

Expected: the stderr shows `23 clusters, prompt about 14973 tokens` (an estimate), then `batch msgbatch_…: in_progress …` lines. The stdout is the summary, ending with the LLM cost and `Wrote ~/.repowiki/next-chief-of-staff/manifest-7247d28.json and …md for review`.

The prototype's run of exactly this code gave:
- **Index and clusters:** 429 files and 2,185 symbols, so 2,614 members, in 23 clusters.
- **Features:** 13 — infrastructure-deployment, llm-fixtures, api-testing, web-dashboard, data-persistence, signal-ingestion, enrichment-processing, agent-orchestration, backfill-scanning, statement-of-work, rest-api, portfolio-view, continuous-integration.
- **Cost:** 1 call, batched, accepted on the first answer. 16 input, 1,139 output and 13,867 cache-write tokens, so **$0.0115**: (16 × 1 + 1,139 × 5 + 13,867 × 1.25) / 1M × 0.5.
- **Store:** `wiki.db` holds that one ledger entry, and `getDriftBaseline()` returns the stored manifest.

Haiku's grouping varies from run to run: 13 to 20 features across seven live tries (an earlier run of the same prompt gave 17). So report differences rather than chase these numbers. The gate is a stored manifest that validates, plus a saved summary.

The `find` prints nothing, because the target repo is untouched. RepoWiki reads it only through git plumbing. The owner's pre-existing uncommitted edit in next-chief-of-staff is theirs: leave it alone.

```bash
pnpm manifest:build ../next-chief-of-staff 7247d28 2>&1 >/dev/null | head -1
```

Expected: `reusing the stored manifest for 7247d286…`. A second run reuses the stored manifest and makes no LLM call.

- [ ] **Step 6: Commit and ship**

```bash
git add scripts package.json CLAUDE.md pnpm-lock.yaml
git commit -m "feat(manifest): add the manifest:build dev command"
```

Ship. PR title: `feat(manifest): dev command and next-chief-of-staff run`. Paste the summary's feature table and LLM cost lines into the PR body, and note the path of the saved `.md` summary. The owner reviews it there later: M3's "reviewed manifest" is that saved summary, and execution does not wait for the review.
