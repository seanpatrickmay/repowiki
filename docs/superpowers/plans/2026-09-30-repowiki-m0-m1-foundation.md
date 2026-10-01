# RepoWiki M0 + M1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the RepoWiki repository with its hygiene and tracking protocol (M0), then build the shared data model and the SQLite store with JSON export (M1).

**Architecture:** A pnpm workspace with no build step: Node 24 runs the TypeScript sources directly via type stripping, and each package exports `./src/index.ts`. `@repowiki/core` holds zod schemas that encode the spec's data-model rules. `@repowiki/engine` starts with its `store/` module: SQLite via better-sqlite3, parsing data on write and on read, with an indexed table of citation ranges for the freshness lookup.

**Tech Stack:** Node 24, pnpm 10.15.0, TypeScript 7.0.2 (strict), Biome 2.5.15, Vitest 5.0.3, zod 4.6.5, better-sqlite3 13.0.3, GitHub Actions, the `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-09-30-repowiki-v1-design.md`. Milestones M2–M7 get their own plans.

## Global Constraints

- Node `>=24` (`.nvmrc` = `24`). The package manager is pinned with `"packageManager": "pnpm@10.15.0"`.
- Dependency versions are pinned exactly: `typescript 7.0.2`, `vitest 5.0.3`, `@biomejs/biome 2.5.15`, `zod 4.6.5`, `better-sqlite3 13.0.3`, `@types/better-sqlite3 9.6.0`, `@types/node 24.19.0`.
- ESM only. Relative imports use the `.ts` extension. No `enum` or `namespace` (`erasableSyntaxOnly`). No build step.
- Tests are co-located as `*.test.ts`. Tests never touch the network or an LLM.
- Commits use Conventional Commits with a scope. Author: `seanpatrickmay <sean.may101@gmail.com>`. Never add `Co-Authored-By` or AI attribution. Never use `--no-verify`.
- `pnpm check` (typecheck + lint + test) passes before every commit.
- One task = one branch = one PR, under ~300 changed lines (not counting `pnpm-lock.yaml`, `seed.json`, and test fixtures). Branch names follow `mN/short-description`.
- PRs are merged with a **merge commit**: `gh pr merge --merge --delete-branch`. Never squash or rebase-merge, because replay reads first-parent `Merge pull request #N` commits (ADR-0002).
- Biome style: 2-space indent, double quotes, semicolons, line width 100. If `pnpm lint` fails only on formatting, run `pnpm format` and re-run `pnpm check`.

### Ship procedure (the last step of every task)

```bash
git push -u origin HEAD
gh pr create --title "<PR title given in the task>" --body "<Closes #N line if the task has a ticket>

<one-paragraph summary of the change>

- [x] pnpm check passes locally"
gh pr checks --watch --fail-fast   # skip only in Task 1, before CI exists
gh pr merge --merge --delete-branch
git switch main && git pull --ff-only
```

Ticket numbers (Tasks 5–12) are looked up by title:
`gh issue list --state all --search "in:title \"<ticket title>\"" --json number --jq '.[0].number'`

## Review Focus

1. **Out-of-order writes.** Two updates built from the same parent revision: the second must fail with `StaleParentError` and persist nothing. *Test: Task 10.*
2. **Citation paths that escape the repo or use Windows separators** (`../x.py`, `/etc/passwd`, `src\\a.py`): rejected by the schema, never stored. *Test: Task 5.*
3. **Diff hunks that touch only the first or last cited line**: these count as overlapping (inclusive bounds), so the claim is reported. *Test: Task 11.*
4. **Opening a store written by a newer RepoWiki**: refuse with `UnsupportedSchemaError`; never migrate down or overwrite. *Test: Task 9.*
5. **Exporting before any build** (empty store, or a manifest with no head): `EmptyStoreError` with an actionable message, not a crash or an empty file. *Test: Task 12.*

## Spec deltas made by this plan

These are recorded in the spec in the same commit as this plan:
- `SectionKey` drops `see-also` and `references`. Both are rendered: See also from the new `Revision.seeAlso: FeatureId[]`, and References from the claims' citations.
- `Revision` gains `diagram: string | null` (Mermaid source).
- The store has a `meta` table holding `head`, the last processed sha. The export reports `head`.

---

## File map

```
.gitignore  .nvmrc  package.json  pnpm-workspace.yaml  pnpm-lock.yaml
tsconfig.base.json  tsconfig.json  biome.json  vitest.config.ts  CLAUDE.md
.github/workflows/ci.yml
.github/pull_request_template.md
.github/ISSUE_TEMPLATE/{config,feature,task,bug,decision}.yml
docs/decisions/{0000-template,0001-analysis-first-pipeline,0002-merge-commits}.md
scripts/tracker/{plan.ts,plan.test.ts,run.ts,seed.json}
packages/core/package.json
packages/core/src/
  index.ts            public entry (re-exports everything below)
  version.ts          SCHEMA_VERSION
  primitives.ts       GitSha, Sha256Hex, IsoDateTime, RepoPath
  content-hash.ts     contentHash()
  citation.ts         CodeCitation, CommitCitation, Citation
  claim.ts            ClaimKind, Claim
  section.ts          SectionKey, Section, claimRuleViolations()
  feature.ts          FeatureId, FeatureStatus, LineageEvent, Feature
  manifest.ts         MemberId, Membership, Manifest
  revision.ts         RevisionReason, TokenUsage, Infobox, Revision
  export.ts           HistoryEntry, WikiExport
  test-fixtures.ts    builders shared by core and engine tests (subpath export)
packages/engine/package.json
packages/engine/src/
  index.ts
  store/errors.ts     StoreError and subclasses
  store/migrations.ts MIGRATIONS, migrate()
  store/store.ts      Store interface, openStore()
  store/export.ts     buildExport(), writeExport()
```

---

## M0 — Repository, hygiene, tracking

### Task 1: GitHub repo and workspace scaffold

**Files:**
- Create: `.gitignore`, `.nvmrc`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`
- Create: `packages/core/package.json`, `packages/core/src/version.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/index.test.ts`

**Interfaces:**
- Produces: `@repowiki/core` resolvable by name from any workspace file; `export const SCHEMA_VERSION = 1`; root scripts `typecheck`, `lint`, `format`, `test`, `check`.

- [ ] **Step 1: Create the GitHub repo and push the existing spec commits**

```bash
cd /Users/seanmay/Desktop/CurrentProjects/RepoWiki
gh repo create seanpatrickmay/repowiki --private --source . --remote origin --push
git switch -c m0/workspace-scaffold
```

Expected: `https://github.com/seanpatrickmay/repowiki` exists, and `main` holds the spec and plan commits.

- [ ] **Step 2: Write the root configuration**

`.gitignore`:
```
node_modules/
coverage/
dist/
*.db
*.db-journal
*.db-wal
*.db-shm
.repowiki/
.DS_Store
.claude/settings.local.json
.claude/.cc-writes/
```

`.nvmrc`:
```
24
```

`package.json`:
```json
{
  "name": "repowiki",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.15.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "lint": "biome check .",
    "format": "biome check --write .",
    "test": "vitest run",
    "check": "pnpm typecheck && pnpm lint && pnpm test"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.15",
    "@repowiki/core": "workspace:*",
    "@types/node": "24.19.0",
    "typescript": "7.0.2",
    "vitest": "5.0.3"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "noEmit": true,
    "skipLibCheck": true
  }
}
```

`tsconfig.json`:
```json
{
  "extends": "./tsconfig.base.json",
  "include": ["packages/*/src/**/*.ts", "scripts/**/*.ts", "vitest.config.ts"]
}
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } },
  "linter": { "enabled": true, "rules": { "recommended": true } }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Commit the scaffold**

```bash
git add .gitignore .nvmrc package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.json biome.json vitest.config.ts
git commit -m "chore(repo): scaffold pnpm workspace with strict TypeScript, Biome, Vitest"
```

- [ ] **Step 4: Write the failing test and the core package manifest**

`packages/core/package.json`:
```json
{
  "name": "@repowiki/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./test-fixtures": "./src/test-fixtures.ts"
  }
}
```

`packages/core/src/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import * as core from "@repowiki/core";

describe("@repowiki/core public entry", () => {
  it("resolves by package name and exposes the schema version", () => {
    expect(core.SCHEMA_VERSION).toBe(1);
  });
});
```

- [ ] **Step 5: Install and run the test to verify it fails**

Run: `pnpm install && pnpm test`
Expected: FAIL. Vitest cannot resolve `@repowiki/core`, because `packages/core/src/index.ts` doesn't exist yet.

- [ ] **Step 6: Implement**

`packages/core/src/version.ts`:
```ts
/** Version of the stored and exported wiki data format. Bump on any breaking schema change. */
export const SCHEMA_VERSION = 1;
```

`packages/core/src/index.ts`:
```ts
export { SCHEMA_VERSION } from "./version.ts";
```

- [ ] **Step 7: Run the full check to verify it passes**

Run: `pnpm check`
Expected: typecheck passes, Biome reports no errors, and Vitest reports 1 passed.

- [ ] **Step 8: Commit**

```bash
git add packages/core pnpm-lock.yaml package.json
git commit -m "feat(core): add core package exposing SCHEMA_VERSION"
```

- [ ] **Step 9: Ship.** PR title: `chore(repo): workspace scaffold`. No ticket yet (the tracker arrives in Task 4). Skip `gh pr checks`, since CI doesn't exist yet.

---

### Task 2: CI, PR and issue templates, branch ruleset

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/pull_request_template.md`
- Create: `.github/ISSUE_TEMPLATE/config.yml`, `feature.yml`, `task.yml`, `bug.yml`, `decision.yml`

**Interfaces:**
- Produces: a required status check named `check`, plus issue forms used by the tracker protocol.

- [ ] **Step 1: Branch**

```bash
git switch -c m0/ci-and-templates
```

- [ ] **Step 2: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

- [ ] **Step 3: Commit the workflow**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run typecheck, lint, and tests on every PR and on main"
```

- [ ] **Step 4: Write the PR template**

`.github/pull_request_template.md`:
```md
Closes #

## What

## Why

## How verified
- [ ] `pnpm check` passes locally
- [ ] New behavior has a test that failed before this change

## Size
Under ~300 changed lines, excluding lockfiles, fixtures, and cassettes. If over, say why.
```

- [ ] **Step 5: Write the issue forms**

`.github/ISSUE_TEMPLATE/config.yml`:
```yaml
blank_issues_enabled: false
```

`.github/ISSUE_TEMPLATE/feature.yml`:
```yaml
name: Feature
description: A feature in the register (Fnn). Implementation happens in task sub-issues.
title: "[Fnn] "
labels: ["type:feature"]
body:
  - type: input
    id: fid
    attributes:
      label: Feature ID
      description: Next free F-number.
    validations:
      required: true
  - type: textarea
    id: source
    attributes:
      label: Original point
      description: The idea as first written down.
    validations:
      required: true
  - type: textarea
    id: interpretation
    attributes:
      label: Interpretation
      description: What it concretely means for RepoWiki.
    validations:
      required: true
  - type: dropdown
    id: verdict
    attributes:
      label: Verdict
      options: [v1, v2, v3, rejected]
    validations:
      required: true
```

`.github/ISSUE_TEMPLATE/task.yml`:
```yaml
name: Task
description: One PR-sized piece of work under a feature or milestone.
title: "[Mn] "
labels: ["type:task"]
body:
  - type: input
    id: parent
    attributes:
      label: Parent feature
      description: "The [Fnn] issue this task advances, e.g. #3."
    validations:
      required: true
  - type: textarea
    id: deliverable
    attributes:
      label: Deliverable
    validations:
      required: true
  - type: textarea
    id: done
    attributes:
      label: Done when
      description: The observable check that closes this task.
    validations:
      required: true
```

`.github/ISSUE_TEMPLATE/bug.yml`:
```yaml
name: Bug
description: Something RepoWiki does wrong.
labels: ["type:bug"]
body:
  - type: textarea
    id: happened
    attributes:
      label: What happened
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: What should have happened
    validations:
      required: true
  - type: textarea
    id: repro
    attributes:
      label: Reproduction
      description: Repo, sha, and command.
    validations:
      required: true
```

`.github/ISSUE_TEMPLATE/decision.yml`:
```yaml
name: Decision
description: A choice that reshapes, defers, or rejects a feature. Lands as an ADR.
labels: ["type:decision"]
body:
  - type: textarea
    id: context
    attributes:
      label: Context
    validations:
      required: true
  - type: textarea
    id: options
    attributes:
      label: Options considered
    validations:
      required: true
  - type: textarea
    id: decision
    attributes:
      label: Proposed decision
    validations:
      required: true
```

- [ ] **Step 6: Run the check and commit**

Run: `pnpm check`. Expected: PASS.

```bash
git add .github
git commit -m "chore(repo): add PR template and issue forms"
```

- [ ] **Step 7: Ship.** PR title: `ci: add CI workflow and GitHub templates`. CI must be green before merging.

- [ ] **Step 8: Verify that CI catches a failure, using a throwaway branch (no PR)**

`workflow_dispatch` only works once the workflow is on `main`, which is why this runs after the merge:

```bash
git switch -c ci-canary
printf 'export const broken: number = "not a number";\n' > packages/core/src/canary.ts
git add packages/core/src/canary.ts && git commit -m "test: canary type error (throwaway)"
git push -u origin ci-canary
gh workflow run CI --ref ci-canary
sleep 5
gh run watch --exit-status "$(gh run list --branch ci-canary --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expected: the run FAILS at `pnpm typecheck` with `Type 'string' is not assignable to type 'number'`. Then delete the canary everywhere:

```bash
git switch main
git branch -D ci-canary && git push origin --delete ci-canary
```

- [ ] **Step 9: Protect `main` with a ruleset**

```bash
gh api -X POST repos/seanpatrickmay/repowiki/rulesets --input - <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ { "context": "check" } ] } }
  ]
}
JSON
```

Expected: JSON describing the new ruleset. **If the response is HTTP 403 saying rulesets need GitHub Pro or a public repo, stop and ask Sean** whether to make the repo public, upgrade, or rely on convention. Record the answer in Task 3's `CLAUDE.md`.

---

### Task 3: Repo `CLAUDE.md` and ADRs

**Files:**
- Create: `CLAUDE.md`, `docs/decisions/0000-template.md`, `docs/decisions/0001-analysis-first-pipeline.md`, `docs/decisions/0002-merge-commits.md`

**Interfaces:**
- Produces: the written working agreement that every later task follows.

- [ ] **Step 1: Branch**

```bash
git switch -c m0/working-agreement
```

- [ ] **Step 2: Write `CLAUDE.md`**

```md
# RepoWiki — working agreement

RepoWiki generates a feature-scoped, citation-backed wiki for a git repository.
Spec: `docs/superpowers/specs/2026-09-30-repowiki-v1-design.md`. Plans: `docs/superpowers/plans/`.
This repo is also RepoWiki's own test subject, so its history must read cleanly.

## Commands
- `pnpm install` — install dependencies (Node 24, pnpm 10)
- `pnpm check` — typecheck + lint + test; must pass before every commit
- `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm format`

## Layout
- `packages/core` — zod schemas and types shared by every package; no I/O besides hashing
- `packages/engine` — pipeline modules (`store/` first; later `index/`, `cluster/`, `manifest/`, `write/`, `verify/`, `link/`, `freshness/`). Modules import each other only through their own `index.ts`.
- `packages/llm`, `site`, `cli`, `eval` — added in later milestones
- `scripts/tracker` — seeds GitHub labels and issues from `seed.json`
- `docs/decisions` — ADRs

## Workflow
1. Every change starts from a GitHub issue. Features are `[Fnn]` issues; work happens in `[Mn]` task sub-issues, each sized to one PR.
2. Branch from an up-to-date `main`: `mN/short-description`.
3. TDD: failing test → minimal code → green → commit. Commit at every green step.
4. Commits follow Conventional Commits with a scope, e.g. `feat(core): add Citation schema`. Every commit passes `pnpm check`. No `Co-Authored-By` or AI attribution. Never `--no-verify`.
5. One PR closes exactly one ticket (`Closes #n`) and stays under ~300 changed lines, not counting lockfiles, fixtures, and cassettes.
6. Merge with a merge commit (`gh pr merge --merge --delete-branch`) once CI is green. Never squash or rebase-merge (ADR-0002).
7. Reshaping, deferring, or rejecting a feature requires an ADR in `docs/decisions/`.

## Code rules
- ESM, strict TypeScript, relative imports with the `.ts` extension, no `enum`/`namespace`. Node runs the sources directly via type stripping; there is no build step.
- Validate data at boundaries with the `@repowiki/core` schemas. The store parses on write and on read.
- Tests are co-located `*.test.ts` files. Tests never call the network or an LLM; LLM calls go through record/replay cassettes.
- RepoWiki never writes inside a repo it documents. Wiki data lives in `~/.repowiki/<repo>/` or the `--out` directory.
- Dependency versions are pinned exactly. Review each new dependency (maintenance, downloads, license) before adding it.
```

If Task 2 Step 9 fell back to convention, add this line under Workflow: `8. main is not server-protected (private repo on the free plan); never push to main directly.`

- [ ] **Step 3: Write the ADRs**

`docs/decisions/0000-template.md`:
```md
# NNNN. Title

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD
- Features: Fnn

## Context

## Decision

## Consequences
```

`docs/decisions/0001-analysis-first-pipeline.md`:
```md
# 0001. Analysis-first pipeline with an LLM-maintained manifest

- Status: accepted
- Date: 2026-09-30
- Features: F03, F04, F05, F26

## Context
Pages are scoped by feature, not folder (F04). Feature boundaries are a judgment call, and an LLM that
re-derives them on every run splits and merges differently each time, which breaks URLs, links, and
history. Freshness (F05) must be cheap enough to run on every merged PR.

## Decision
Deterministic analysis first: tree-sitter symbols, an import graph, and git co-change are combined into
one weighted graph and clustered. The LLM names, merges, and splits clusters into a manifest with permanent
feature IDs, and on later runs it updates that manifest with explicit operations instead of rebuilding it.
Articles are stored as claims whose code citations carry a content hash, so staleness is computed from
diffs, not judged by an LLM.

Rejected: a free-roaming agentic explorer (unstable page identity, expensive freshness, hard-to-verify
citations) and an LLM-only feature proposal from a repo map (loses the co-change signal).

## Consequences
More engineering up front (indexer, clustering, verifier). Most updates need no LLM call at all when
cited code is unchanged. Merges and splits become redirect and disambiguation pages, so no URL breaks.
```

`docs/decisions/0002-merge-commits.md`:
```md
# 0002. Merge PRs with merge commits, never squash

- Status: accepted
- Date: 2026-09-30
- Features: F05, F06, F19

## Context
`repowiki replay` walks first-parent merge commits on `main` and reads the PR number from
`Merge pull request #N`. RepoWiki is meant to document itself, and its frequent small commits are part of
the history it documents.

## Decision
Every PR merges with `gh pr merge --merge`. Squash and rebase merges are not used.

## Consequences
`main`'s first-parent history is exactly one commit per PR, which is the unit replay expects. Branch
commits stay visible, so every one of them must pass `pnpm check` and have a clean message.
```

- [ ] **Step 4: Run the check and commit**

Run: `pnpm check`. Expected: PASS.

```bash
git add CLAUDE.md docs/decisions
git commit -m "docs(repo): add working agreement and ADRs 0001-0002"
```

- [ ] **Step 5: Ship.** PR title: `docs(repo): working agreement and first ADRs`.

---

### Task 4: Tracker seed script, labels, feature register, tickets, board

**Files:**
- Create: `scripts/tracker/plan.ts`, `scripts/tracker/run.ts`, `scripts/tracker/seed.json`
- Modify: `package.json` (add the `zod` devDependency and the `tracker:seed` script)
- Test: `scripts/tracker/plan.test.ts`

**Interfaces:**
- Produces: `Seed` (zod schema), `planSeed(seed: Seed, existing: readonly ExistingIssue[]): Action[]`, and the `pnpm tracker:seed [--dry-run] [--project N]` command.

- [ ] **Step 1: Branch and add zod**

```bash
git switch -c m0/tracker-seed
pnpm add -D -w zod@4.6.5
```

Add to the root `package.json` `scripts`: `"tracker:seed": "node scripts/tracker/run.ts"`.

- [ ] **Step 2: Write the failing tests**

`scripts/tracker/plan.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Seed, Seed as SeedSchema, planSeed } from "./plan.ts";

const seed: Seed = {
  labels: [
    { name: "v1", color: "0e8a16", description: "Ships in v1" },
    { name: "type:feature", color: "a2eeef", description: "Feature register entry" },
    { name: "type:task", color: "ededed", description: "One PR-sized task" },
  ],
  issues: [
    { key: "F01", title: "[F01] Aliases", labels: ["v1", "type:feature"], body: "b" },
    { key: "M0-1", title: "[M0] Scaffold", labels: ["type:task"], body: "b", parent: "F01", closed: true },
    { key: "M1-1", title: "[M1] Schemas", labels: ["type:task"], body: "b", parent: "F01" },
  ],
};

describe("Seed schema", () => {
  it("rejects duplicate keys", () => {
    const issues = [...seed.issues, { ...seed.issues[0], title: "[F01] Other" }];
    expect(SeedSchema.safeParse({ ...seed, issues }).success).toBe(false);
  });

  it("rejects duplicate titles", () => {
    const issues = [...seed.issues, { key: "F02", title: "[F01] Aliases", labels: ["v1"], body: "b" }];
    expect(SeedSchema.safeParse({ ...seed, issues }).success).toBe(false);
  });

  it("rejects labels that are not defined", () => {
    const issues = [{ key: "F01", title: "[F01] Aliases", labels: ["v9"], body: "b" }];
    expect(SeedSchema.safeParse({ ...seed, issues }).success).toBe(false);
  });

  it("rejects unknown parents", () => {
    const issues = [{ key: "M1-1", title: "[M1] x", labels: ["type:task"], body: "b", parent: "F99" }];
    expect(SeedSchema.safeParse({ ...seed, issues }).success).toBe(false);
  });
});

describe("planSeed", () => {
  it("upserts labels, then creates, links, and closes only new issues, in that order", () => {
    expect(planSeed(seed, []).map((a) => a.kind)).toEqual([
      "upsert-label",
      "upsert-label",
      "upsert-label",
      "create-issue",
      "create-issue",
      "create-issue",
      "link-parent",
      "link-parent",
      "close-issue",
    ]);
  });

  it("skips issues whose title already exists, and never relinks or recloses them", () => {
    const actions = planSeed(seed, [
      { number: 1, title: "[F01] Aliases" },
      { number: 2, title: "[M0] Scaffold" },
    ]);
    expect(actions.filter((a) => a.kind === "create-issue")).toEqual([
      { kind: "create-issue", issue: seed.issues[2] },
    ]);
    expect(actions.filter((a) => a.kind === "link-parent")).toEqual([
      { kind: "link-parent", childKey: "M1-1", parentKey: "F01" },
    ]);
    expect(actions.some((a) => a.kind === "close-issue")).toBe(false);
  });
});

describe("seed.json", () => {
  const raw: unknown = JSON.parse(readFileSync(new URL("./seed.json", import.meta.url), "utf8"));

  it("is a valid seed", () => {
    expect(SeedSchema.safeParse(raw).success).toBe(true);
  });

  it("contains the full feature register F01-F26", () => {
    const keys = SeedSchema.parse(raw)
      .issues.map((i) => i.key)
      .filter((k) => k.startsWith("F"));
    expect(keys).toEqual(Array.from({ length: 26 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run scripts/tracker/plan.test.ts`
Expected: FAIL, because `./plan.ts` does not exist.

- [ ] **Step 4: Implement `plan.ts`**

`scripts/tracker/plan.ts`:
```ts
import { z } from "zod";

export const SeedLabel = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^[0-9a-f]{6}$/),
  description: z.string(),
});
export type SeedLabel = z.infer<typeof SeedLabel>;

export const SeedIssue = z.object({
  key: z.string().regex(/^(F\d{2}|M\d+-\d+)$/),
  title: z.string().min(1),
  labels: z.array(z.string().min(1)).min(1),
  body: z.string().min(1),
  parent: z.string().optional(),
  closed: z.boolean().optional(),
});
export type SeedIssue = z.infer<typeof SeedIssue>;

export const Seed = z
  .object({ labels: z.array(SeedLabel), issues: z.array(SeedIssue) })
  .superRefine((seed, ctx) => {
    const labelNames = new Set(seed.labels.map((label) => label.name));
    const keys = new Set<string>();
    const titles = new Set<string>();
    seed.issues.forEach((issue, index) => {
      if (keys.has(issue.key)) {
        ctx.addIssue({ code: "custom", message: `duplicate key ${issue.key}`, path: ["issues", index] });
      }
      if (titles.has(issue.title)) {
        ctx.addIssue({ code: "custom", message: `duplicate title ${issue.title}`, path: ["issues", index] });
      }
      keys.add(issue.key);
      titles.add(issue.title);
      for (const label of issue.labels) {
        if (!labelNames.has(label)) {
          ctx.addIssue({ code: "custom", message: `undefined label ${label}`, path: ["issues", index] });
        }
      }
    });
    seed.issues.forEach((issue, index) => {
      if (issue.parent !== undefined && !keys.has(issue.parent)) {
        ctx.addIssue({ code: "custom", message: `unknown parent ${issue.parent}`, path: ["issues", index] });
      }
    });
  });
export type Seed = z.infer<typeof Seed>;

export interface ExistingIssue {
  number: number;
  title: string;
}

export type Action =
  | { kind: "upsert-label"; label: SeedLabel }
  | { kind: "create-issue"; issue: SeedIssue }
  | { kind: "link-parent"; childKey: string; parentKey: string }
  | { kind: "close-issue"; key: string };

/** Plans an idempotent sync: labels are always upserted; issues are matched by exact title. */
export function planSeed(seed: Seed, existing: readonly ExistingIssue[]): Action[] {
  const existingTitles = new Set(existing.map((issue) => issue.title));
  const fresh = seed.issues.filter((issue) => !existingTitles.has(issue.title));
  return [
    ...seed.labels.map((label): Action => ({ kind: "upsert-label", label })),
    ...fresh.map((issue): Action => ({ kind: "create-issue", issue })),
    ...fresh.flatMap((issue): Action[] =>
      issue.parent === undefined
        ? []
        : [{ kind: "link-parent", childKey: issue.key, parentKey: issue.parent }],
    ),
    ...fresh.flatMap((issue): Action[] =>
      issue.closed === true ? [{ kind: "close-issue", key: issue.key }] : [],
    ),
  ];
}
```

- [ ] **Step 5: Write `seed.json`**

`scripts/tracker/seed.json`:
```json
{
  "labels": [
    { "name": "v1", "color": "0e8a16", "description": "Ships in v1" },
    { "name": "v2", "color": "fbca04", "description": "Planned for v2" },
    { "name": "v3", "color": "d93f0b", "description": "Planned for v3" },
    { "name": "area:engine", "color": "1d76db", "description": "Indexing, clustering, manifest, writing, verification, linking, store" },
    { "name": "area:site", "color": "5319e7", "description": "The Astro reader" },
    { "name": "area:freshness", "color": "0052cc", "description": "Incremental updates, replay, versioning" },
    { "name": "area:eval", "color": "c5def5", "description": "Q&A eval and token measurement" },
    { "name": "area:infra", "color": "bfdadc", "description": "Repo, CI, tooling, process" },
    { "name": "type:feature", "color": "a2eeef", "description": "Feature register entry (Fnn)" },
    { "name": "type:task", "color": "ededed", "description": "One PR-sized task" },
    { "name": "type:bug", "color": "d73a4a", "description": "Something RepoWiki does wrong" },
    { "name": "type:decision", "color": "f9d0c4", "description": "A decision that lands as an ADR" },
    { "name": "accuracy", "color": "b60205", "description": "A false or uncited claim in a generated page" }
  ],
  "issues": [
    { "key": "F01", "title": "[F01] Alternative names (aliases and redirects)", "labels": ["v1", "type:feature", "area:engine"], "body": "**Original point:** LLM to generate appropriate alternative names for an article that someone might look up a certain thing by description.\n\n**Interpretation:** Wikipedia-style redirects. The LLM proposes 3-8 aliases per page; code identifiers owned by the feature (HTTP routes, table names, env vars, CLI commands) are added deterministically. Aliases feed search and redirect URLs, and a rename appends the old title.\n\n**Verdict:** v1, sub-project #1 (core engine). Spec section 3 and 7.3." },
    { "key": "F02", "title": "[F02] Hyperlinks to related pages", "labels": ["v1", "type:feature", "area:engine"], "body": "**Original point:** Hyperlinks to related pages.\n\n**Interpretation:** Links in the body text on first mention, restricted to manifest IDs and aliases; unknown targets render as plain text. See also lists the top 5 graph neighbours.\n\n**Verdict:** v1, sub-project #1. Spec section 7.3." },
    { "key": "F03", "title": "[F03] Works cited with code lines", "labels": ["v1", "type:feature", "area:engine"], "body": "**Original point:** Works cited at bottom with codebase lines.\n\n**Interpretation:** Numbered References rendered from claim citations as path:Lstart-Lend@sha permalinks. Each code citation stores a contentHash of the cited lines, which makes citations the staleness detector.\n\n**Verdict:** v1, sub-project #1. Spec sections 5 and 6." },
    { "key": "F04", "title": "[F04] Pages by feature, not folder", "labels": ["v1", "type:feature", "area:engine"], "body": "**Original point:** LLM generated pages based by feature rather than folder in the codebase.\n\n**Interpretation:** Features come from clustering a weighted import + co-change graph; the LLM names, merges, and splits clusters into a manifest with permanent IDs.\n\n**Verdict:** v1, sub-project #1. ADR-0001." },
    { "key": "F05", "title": "[F05] Generated from each PR", "labels": ["v1", "type:feature", "area:freshness"], "body": "**Original point:** Autogenerated based on a PR.\n\n**Interpretation:** `repowiki update` processes new commits and rewrites only stale sections; `replay` walks first-parent merge commits. Local trigger in v1, a GitHub Action later.\n\n**Verdict:** v1, sub-project #2. Spec section 6." },
    { "key": "F06", "title": "[F06] Versioned, dated pages", "labels": ["v1", "type:feature", "area:freshness"], "body": "**Original point:** Pages versioned and dated.\n\n**Interpretation:** Every page revision stores its commit date, sha, and PR number; the reader shows View history with diffs.\n\n**Verdict:** v1, sub-project #2. Spec section 5." },
    { "key": "F07", "title": "[F07] Ways an LLM can use the site", "labels": ["v1", "type:feature", "area:engine"], "body": "**Original point:** List of ways that an LLM can use the site.\n\n**Interpretation:** v1 ships llms.txt and a JSON export, consumed by the eval agent. A full MCP server is sub-project #5.\n\n**Verdict:** v1 (partial); remainder in sub-project #5." },
    { "key": "F08", "title": "[F08] LLM reads past versions of the wiki", "labels": ["v2", "type:feature", "area:engine"], "body": "**Original point:** Looking at the dated past versions of the wiki to figure out past ideas and ways the codebase worked previously.\n\n**Interpretation:** History queries (how did X work on date D) over stored revisions, exposed to agents.\n\n**Verdict:** v2, sub-project #5. Enabled by the v1 revision store." },
    { "key": "F09", "title": "[F09] Ask-me-anything sidebar that links to pages", "labels": ["v2", "type:feature", "area:site"], "body": "**Original point:** A sidebar ask-me-anything LLM that already has the live context precomputed and can link the user to a page instead of answering everything in the chat box.\n\n**Interpretation:** Retrieval over precomputed pages; answers are a short reply plus links to the pages that hold the detail.\n\n**Verdict:** v2, sub-project #4." },
    { "key": "F10", "title": "[F10] Autogenerated diagrams", "labels": ["v1", "type:feature", "area:engine"], "body": "**Original point:** Autogenerated diagrams and pictures to aid the reader, think Wikipedia.\n\n**Interpretation:** Mermaid flowcharts built from real import and call edges (at most 12 nodes, every node verified and clickable), plus a feature map on the Main Page.\n\n**Verdict:** v1, sub-project #3. Spec section 7.3." },
    { "key": "F11", "title": "[F11] Pictures (UI screenshots)", "labels": ["v2", "type:feature", "area:site"], "body": "**Original point:** Autogenerated diagrams and pictures to aid the reader.\n\n**Interpretation:** Reshaped: screenshots of rendered UI for frontend features.\n\n**Verdict:** later, sub-project #3." },
    { "key": "F12", "title": "[F12] Addictive, Wikipedia-style browsing", "labels": ["v1", "type:feature", "area:site"], "body": "**Original point:** A mini Wikipedia for any codebase that is engaging and has the addiction aspect Wikipedia has.\n\n**Interpretation:** Hover previews, dense first-mention linking, Random article, Did you know (hook claims), a featured article, and recently updated pages. Judged by the rabbit-hole exit criterion.\n\n**Verdict:** v1 (partial), sub-project #3." },
    { "key": "F13", "title": "[F13] Links to real Wikipedia", "labels": ["v1", "type:feature", "area:engine"], "body": "**Original point:** Links to outside real Wikipedia pages to make browsing fun, for example explaining an algorithm or a codebase precedent.\n\n**Interpretation:** `[[wp:Title]]` links suggested by the LLM and verified against the Wikipedia REST API, whose summary doubles as the hover preview.\n\n**Verdict:** v1, sub-project #3. Spec section 7.3." },
    { "key": "F14", "title": "[F14] People pages", "labels": ["v2", "type:feature", "area:site"], "body": "**Original point:** People pages for contributors, each writing about when and where they contributed as if documenting a war, with hyperlinks to features and teammates.\n\n**Interpretation:** A dated narrative per contributor linking to the features they shaped. In a company setting this needs opt-out from day one.\n\n**Verdict:** v2, sub-project #6." },
    { "key": "F15", "title": "[F15] Contribution graphs over time", "labels": ["v2", "type:feature", "area:site"], "body": "**Original point:** Contribution graphs over time, for the whole repo and zoomable to one person.\n\n**Interpretation:** Activity over time for the whole repo and per person, with zoom.\n\n**Verdict:** v2, sub-project #6." },
    { "key": "F16", "title": "[F16] Contributor identity merge", "labels": ["v2", "type:feature", "area:engine"], "body": "**Original point:** (derived during design)\n\n**Interpretation:** Merge author identities (for example seanpatrickmay and Sean May) via a mailmap before attributing anything.\n\n**Verdict:** v2, sub-project #6." },
    { "key": "F17", "title": "[F17] Attribution: as-is vs full history", "labels": ["v1", "type:feature", "area:freshness"], "body": "**Original point:** Generate as-is (can miss refactors; copy-pasted files misattribute authorship) or with full history (requires regeneration at each timestep, expensive).\n\n**Interpretation:** Resolved by splitting the problem: line authorship uses git blame -C -C -M, which follows copies and moves; article history comes from replaying merges, so full history costs incremental-update tokens rather than one regeneration per point in time.\n\n**Verdict:** v1, sub-project #2." },
    { "key": "F18", "title": "[F18] Human edits to the wiki", "labels": ["v2", "type:feature", "area:engine"], "body": "**Original point:** Should users edit the wiki? Can edits be overwritten? Maybe the LLM figures out accuracy and corrects the generator.\n\n**Interpretation:** No edits in v1. Later, edits become generator guidance verified against the code instead of overwriting generated text. Open question.\n\n**Verdict:** v2, sub-project #7." },
    { "key": "F19", "title": "[F19] Hygiene good enough to run RepoWiki on itself", "labels": ["v1", "type:feature", "area:infra"], "body": "**Original point:** Follow extremely well-groomed hygiene programming protocols so the tool can be used on its own repository.\n\n**Interpretation:** Tiny PRs, a commit per green TDD step, merge commits, CI on every PR, and ADRs for decisions, so RepoWiki's own history is a realistic test subject.\n\n**Verdict:** adopted from M0. CLAUDE.md and ADR-0002." },
    { "key": "F20", "title": "[F20] Opinionated articles and an opinion setting", "labels": ["v1", "type:feature", "area:engine"], "body": "**Original point:** Can the articles be opinionated? Can there be a setting to change the opinion?\n\n**Interpretation:** Reshaped: NPOV voice; opinions appear only as evidence-backed Known limitations claims. The opinion setting is deferred to sub-project #7.\n\n**Verdict:** v1 (NPOV); setting in v2." },
    { "key": "F21", "title": "[F21] Voice learned from Wikipedia", "labels": ["v1", "type:feature", "area:engine"], "body": "**Original point:** How do we make the voice correct? Try to learn this from Wikipedia itself.\n\n**Interpretation:** A checked-in style guide distilled from Wikipedia's Manual of Style: a bold-subject first sentence, a standalone lead, NPOV, verifiability, no original research, and words to avoid.\n\n**Verdict:** v1, sub-project #1. Spec section 7.1." },
    { "key": "F22", "title": "[F22] Wikis for every repo in a company", "labels": ["v3", "type:feature", "area:infra"], "body": "**Original point:** A wiki for all codebases in the company, easily accessible, so you can work off another team's code.\n\n**Interpretation:** A multi-repo index with cross-repo links.\n\n**Verdict:** v3, sub-project #8." },
    { "key": "F23", "title": "[F23] Pages for future changes, issues, and PRs", "labels": ["v2", "type:feature", "area:engine"], "body": "**Original point:** Is there a way to have a page for future changes? Issues? PRs?\n\n**Interpretation:** In-progress pages built from open issues and PRs, linked to the features they touch. RepoWiki's own tracker is the first test data.\n\n**Verdict:** v2, sub-project #9." },
    { "key": "F24", "title": "[F24] Opinion and rebuttal loop with coding agents", "labels": ["v2", "type:feature", "area:engine"], "body": "**Original point:** The LLM takes an opinion when writing; the LLM changing that code can either act on it or write a rebuttal to the article creator. Limit how extreme opinions can be; report design choices factually.\n\n**Interpretation:** v1 caps extremity structurally: a limitation claim cannot exist without cited evidence. The rebuttal channel is sub-project #7.\n\n**Verdict:** v2, sub-project #7." },
    { "key": "F25", "title": "[F25] Token savings vs reading the codebase", "labels": ["v1", "type:feature", "area:eval"], "body": "**Original point:** (derived during design) It is precomputed once, so it saves token usage massively compared with every engineer's agent reading the whole codebase.\n\n**Interpretation:** Every LLM call is logged in a token ledger; the Q&A eval compares wiki-only and repo-only agents on accuracy and tokens and reports the break-even point.\n\n**Verdict:** v1, measured. Spec section 9." },
    { "key": "F26", "title": "[F26] Stable page identity", "labels": ["v1", "type:feature", "area:engine"], "body": "**Original point:** (derived during design)\n\n**Interpretation:** Feature IDs are permanent slugs; merges become redirects and splits become disambiguation pages, so URLs and history never break.\n\n**Verdict:** v1, sub-project #1. Spec section 5." },
    { "key": "M0-1", "title": "[M0] Workspace scaffold", "labels": ["v1", "type:task", "area:infra"], "parent": "F19", "closed": true, "body": "**Deliverable:** pnpm workspace, strict TypeScript, Biome, Vitest, @repowiki/core skeleton.\n\n**Done when:** `pnpm check` passes. Plan: docs/superpowers/plans/2026-09-30-repowiki-m0-m1-foundation.md Task 1." },
    { "key": "M0-2", "title": "[M0] CI workflow and GitHub templates", "labels": ["v1", "type:task", "area:infra"], "parent": "F19", "closed": true, "body": "**Deliverable:** CI running typecheck, lint, and tests; PR template; issue forms; main ruleset.\n\n**Done when:** CI is green on its own PR and red on a canary type error. Plan Task 2." },
    { "key": "M0-3", "title": "[M0] Working agreement and ADRs", "labels": ["v1", "type:task", "area:infra"], "parent": "F19", "closed": true, "body": "**Deliverable:** CLAUDE.md, ADR template, ADR-0001, ADR-0002.\n\n**Done when:** merged to main. Plan Task 3." },
    { "key": "M0-4", "title": "[M0] Tracker seed script and board", "labels": ["v1", "type:task", "area:infra"], "parent": "F19", "closed": true, "body": "**Deliverable:** idempotent seed script, labels, F01-F26 feature issues, M0/M1 tickets, project board.\n\n**Done when:** the board shows 26 features and 12 tickets. Plan Task 4." },
    { "key": "M1-1", "title": "[M1] core: Citation and Claim schemas", "labels": ["v1", "type:task", "area:engine"], "parent": "F03", "body": "**Deliverable:** GitSha, Sha256Hex, IsoDateTime, RepoPath primitives; contentHash(); Citation and Claim schemas.\n\n**Done when:** schema tests pass, including path-escape rejection. Plan Task 5." },
    { "key": "M1-2", "title": "[M1] core: Section schema with citation rules", "labels": ["v1", "type:task", "area:engine"], "parent": "F03", "body": "**Deliverable:** SectionKey, Section, and claimRuleViolations() enforcing spec section 5 rules 2-4.\n\n**Done when:** rule table tests pass. Plan Task 6." },
    { "key": "M1-3", "title": "[M1] core: Feature and Manifest schemas", "labels": ["v1", "type:task", "area:engine"], "parent": "F26", "body": "**Deliverable:** FeatureId, FeatureStatus, LineageEvent, Feature, and Manifest with referential checks.\n\n**Done when:** schema tests pass. Plan Task 7." },
    { "key": "M1-4", "title": "[M1] core: Revision and WikiExport schemas", "labels": ["v1", "type:task", "area:engine"], "parent": "F06", "body": "**Deliverable:** Revision (with Infobox, TokenUsage, diagram, seeAlso) and WikiExport schemas.\n\n**Done when:** schema tests pass. Plan Task 8." },
    { "key": "M1-5", "title": "[M1] store: open, migrations, manifests, head", "labels": ["v1", "type:task", "area:engine"], "parent": "F06", "body": "**Deliverable:** openStore() with versioned migrations, manifest storage, and the head sha.\n\n**Done when:** reopen and newer-schema tests pass. Plan Task 9." },
    { "key": "M1-6", "title": "[M1] store: revisions and history", "labels": ["v1", "type:task", "area:engine"], "parent": "F06", "body": "**Deliverable:** putRevision with the parent check, current pointers, and history.\n\n**Done when:** round-trip and StaleParentError tests pass. Plan Task 10." },
    { "key": "M1-7", "title": "[M1] store: citation range query", "labels": ["v1", "type:task", "area:engine"], "parent": "F05", "body": "**Deliverable:** findClaimsCitingRange over current revisions with inclusive overlap.\n\n**Done when:** boundary tests pass. Plan Task 11." },
    { "key": "M1-8", "title": "[M1] store: JSON export", "labels": ["v1", "type:task", "area:engine"], "parent": "F07", "body": "**Deliverable:** buildExport() and writeExport() producing a validated WikiExport.\n\n**Done when:** export tests pass, including the empty-store error. Plan Task 12." }
  ]
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run scripts/tracker/plan.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add scripts/tracker/plan.ts scripts/tracker/plan.test.ts scripts/tracker/seed.json package.json pnpm-lock.yaml
git commit -m "feat(tracker): plan idempotent label and issue seeding from seed.json"
```

- [ ] **Step 8: Implement the runner**

`scripts/tracker/run.ts`:
```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Action, type ExistingIssue, Seed, planSeed } from "./plan.ts";

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function describe(action: Action): string {
  switch (action.kind) {
    case "upsert-label":
      return `label   ${action.label.name}`;
    case "create-issue":
      return `create  ${action.issue.title}`;
    case "link-parent":
      return `link    ${action.childKey} -> ${action.parentKey}`;
    case "close-issue":
      return `close   ${action.key}`;
  }
}

function main(argv: readonly string[]): void {
  const dryRun = argv.includes("--dry-run");
  const projectFlag = argv.indexOf("--project");
  const project = projectFlag === -1 ? null : (argv[projectFlag + 1] ?? null);

  const seed = Seed.parse(JSON.parse(readFileSync(new URL("./seed.json", import.meta.url), "utf8")));
  const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const existing = JSON.parse(
    gh(["issue", "list", "--repo", repo, "--state", "all", "--limit", "1000", "--json", "number,title"]),
  ) as ExistingIssue[];
  const actions = planSeed(seed, existing);

  for (const action of actions) console.log(describe(action));
  if (dryRun) return;

  const numbers = new Map<string, number>();
  for (const issue of seed.issues) {
    const match = existing.find((e) => e.title === issue.title);
    if (match) numbers.set(issue.key, match.number);
  }
  const numberOf = (key: string): number => {
    const n = numbers.get(key);
    if (n === undefined) throw new Error(`no issue number known for ${key}`);
    return n;
  };

  for (const action of actions) {
    switch (action.kind) {
      case "upsert-label": {
        const { name, color, description } = action.label;
        gh(["label", "create", name, "--repo", repo, "--color", color, "--description", description, "--force"]);
        break;
      }
      case "create-issue": {
        const { key, title, body, labels } = action.issue;
        const url = gh(["issue", "create", "--repo", repo, "--title", title, "--body", body, "--label", labels.join(",")]);
        numbers.set(key, Number(url.split("/").pop()));
        break;
      }
      case "link-parent": {
        const childId = gh(["api", `repos/${repo}/issues/${numberOf(action.childKey)}`, "--jq", ".id"]);
        gh(["api", "-X", "POST", `repos/${repo}/issues/${numberOf(action.parentKey)}/sub_issues`, "-F", `sub_issue_id=${childId}`]);
        break;
      }
      case "close-issue":
        gh(["issue", "close", String(numberOf(action.key)), "--repo", repo, "--reason", "completed"]);
        break;
    }
  }

  if (project !== null) {
    const owner = repo.split("/")[0] ?? "";
    for (const n of numbers.values()) {
      gh(["project", "item-add", project, "--owner", owner, "--url", `https://github.com/${repo}/issues/${n}`]);
    }
  }
}

main(process.argv.slice(2));
```

- [ ] **Step 9: Verify the runner with a dry run (read-only)**

Run: `pnpm check && pnpm tracker:seed --dry-run`
Expected: `pnpm check` passes. The dry run prints 13 `label` lines, 38 `create` lines, 12 `link` lines (one per ticket), and 4 `close` lines (the M0 tickets). Nothing changes on GitHub.

- [ ] **Step 10: Commit and ship**

```bash
git add scripts/tracker/run.ts package.json
git commit -m "feat(tracker): add gh-backed runner with dry-run and project support"
```

Ship. PR title: `feat(tracker): seed labels, feature register, and tickets`.

- [ ] **Step 11: Create the project board (needs the `project` token scope)**

Ask Sean to run `! gh auth refresh -s project`, then:

```bash
N=$(gh project create --owner seanpatrickmay --title "RepoWiki" --format json --jq .number)
gh project link "$N" --owner seanpatrickmay --repo seanpatrickmay/repowiki
gh project field-create "$N" --owner seanpatrickmay --name "Stage" --data-type SINGLE_SELECT \
  --single-select-options "Backlog,Ready,In progress,In review,Done"
echo "$N"
```

Then ask Sean to set the board view's **Group by** to `Stage` in the web UI. This is a one-time click; the CLI can't change view grouping.

- [ ] **Step 12: Seed from `main` and verify**

```bash
git switch main && git pull --ff-only
pnpm tracker:seed --project "$N"
gh issue list --state all --limit 100 --json number --jq length          # expect 38
gh issue list --state all --label type:feature --json number --jq length # expect 26
gh issue list --state closed --label type:task --json number --jq length # expect 4
pnpm tracker:seed --dry-run | grep -c '^create'                           # expect 0 (idempotent)
```

---

## M1 — Data model and store

### Task 5: Primitives, content hash, Citation, Claim

**Ticket:** `[M1] core: Citation and Claim schemas`

**Files:**
- Modify: `packages/core/package.json` (add `"dependencies": { "zod": "4.6.5" }`), `packages/core/src/index.ts`
- Create: `packages/core/src/primitives.ts`, `content-hash.ts`, `citation.ts`, `claim.ts`, `test-fixtures.ts`
- Test: `packages/core/src/content-hash.test.ts`, `citation.test.ts`, `claim.test.ts`

**Interfaces:**
- Produces: `GitSha`, `Sha256Hex`, `IsoDateTime`, `RepoPath` (zod schemas); `contentHash(lines: string): string`; `CodeCitation`, `CommitCitation`, `Citation`; `ClaimKind`, `ClaimId`, `Claim` (each a zod schema plus a same-named type); fixtures `SHA_A`, `SHA_B`, `SHA_C`, `codeCitation()`, `commitCitation()`, `bodyClaim()` from `@repowiki/core/test-fixtures`.

- [ ] **Step 1: Branch and add zod to core**

```bash
git switch -c m1/citation-claim-schemas
pnpm --filter @repowiki/core add zod@4.6.5
```

- [ ] **Step 2: Write the failing tests**

`packages/core/src/content-hash.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { contentHash } from "./content-hash.ts";

describe("contentHash", () => {
  it("is the sha256 of the lines", () => {
    expect(contentHash("alpha\nbeta")).toBe(
      "bbfb79e82216bd2db1ad2c507d44ddf80aeb12f64f9562056afe93aad43154d9",
    );
  });

  it("ignores CRLF line endings and one trailing newline", () => {
    expect(contentHash("alpha\r\nbeta\r\n")).toBe(contentHash("alpha\nbeta"));
  });

  it("changes when content changes", () => {
    expect(contentHash("alpha\nbeta\ngamma")).toBe(
      "f3220283d05d1ff2ae350cfe9e0e367cb5aef46e10efb203c8a53c678e2218c8",
    );
  });
});
```

`packages/core/src/citation.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Citation } from "./citation.ts";
import { codeCitation, commitCitation } from "./test-fixtures.ts";

describe("Citation", () => {
  it("accepts code and commit citations", () => {
    expect(Citation.parse(codeCitation())).toEqual(codeCitation());
    expect(Citation.parse(commitCitation())).toEqual(commitCitation());
  });

  it("rejects an end line before the start line", () => {
    expect(Citation.safeParse(codeCitation({ startLine: 20, endLine: 10 })).success).toBe(false);
  });

  it("rejects line 0", () => {
    expect(Citation.safeParse(codeCitation({ startLine: 0 })).success).toBe(false);
  });

  it("rejects abbreviated shas", () => {
    expect(Citation.safeParse(codeCitation({ sha: "abc1234" })).success).toBe(false);
  });

  it.each(["/etc/passwd", "../outside.py", "src/../../x.py", "src\\win.py", "src//double.py", "./src/a.py"])(
    "rejects path %s that is not repo-relative POSIX",
    (path) => {
      expect(Citation.safeParse(codeCitation({ path })).success).toBe(false);
    },
  );

  it("rejects unknown citation kinds", () => {
    expect(Citation.safeParse({ ...commitCitation(), kind: "url" }).success).toBe(false);
  });
});
```

`packages/core/src/claim.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Claim } from "./claim.ts";
import { bodyClaim } from "./test-fixtures.ts";

describe("Claim", () => {
  it("accepts a cited fact", () => {
    expect(Claim.parse(bodyClaim())).toEqual(bodyClaim());
  });

  it("rejects empty text", () => {
    expect(Claim.safeParse(bodyClaim({ text: "" })).success).toBe(false);
  });

  it("rejects unknown kinds", () => {
    expect(Claim.safeParse({ ...bodyClaim(), kind: "opinion" }).success).toBe(false);
  });

  it("rejects a malformed staleSince sha", () => {
    expect(Claim.safeParse(bodyClaim({ staleSince: "HEAD" })).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core`
Expected: FAIL, because `./content-hash.ts`, `./citation.ts`, `./claim.ts`, and `./test-fixtures.ts` don't exist.

- [ ] **Step 4: Implement**

`packages/core/src/primitives.ts`:
```ts
import { z } from "zod";

/** A full 40-character lowercase git commit sha. */
export const GitSha = z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-character git sha");

/** A lowercase SHA-256 hex digest. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 hex digest");

/** An ISO-8601 timestamp with an explicit offset, as git reports commit dates. */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** A repo-relative POSIX path: no leading slash, no backslashes, no empty, "." or ".." segments. */
export const RepoPath = z
  .string()
  .min(1)
  .refine(isRepoRelativePath, "expected a repo-relative POSIX path");

function isRepoRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
```

`packages/core/src/content-hash.ts`:
```ts
import { createHash } from "node:crypto";

/**
 * SHA-256 of cited source lines. Line endings are normalized to "\n" and one trailing newline
 * is ignored, so CRLF and LF checkouts of the same code hash identically.
 */
export function contentHash(lines: string): string {
  const normalized = lines.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
```

`packages/core/src/citation.ts`:
```ts
import { z } from "zod";
import { GitSha, RepoPath, Sha256Hex } from "./primitives.ts";

export const CodeCitation = z
  .object({
    kind: z.literal("code"),
    path: RepoPath,
    startLine: z.int().positive(),
    endLine: z.int().positive(),
    sha: GitSha,
    symbol: z.string().min(1).nullable(),
    contentHash: Sha256Hex,
  })
  .refine((c) => c.endLine >= c.startLine, {
    message: "endLine must be >= startLine",
    path: ["endLine"],
  });
export type CodeCitation = z.infer<typeof CodeCitation>;

export const CommitCitation = z.object({
  kind: z.literal("commit"),
  sha: GitSha,
  subject: z.string().min(1),
  pr: z.int().positive().nullable(),
});
export type CommitCitation = z.infer<typeof CommitCitation>;

export const Citation = z.discriminatedUnion("kind", [CodeCitation, CommitCitation]);
export type Citation = z.infer<typeof Citation>;
```

`packages/core/src/claim.ts`:
```ts
import { z } from "zod";
import { Citation } from "./citation.ts";
import { GitSha } from "./primitives.ts";

export const ClaimKind = z.enum(["fact", "limitation", "history"]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const ClaimId = z.string().min(1);

export const Claim = z.object({
  id: ClaimId,
  /** Markdown with [[featureId]] / [[featureId|label]] / [[wp:Title]] link tokens. */
  text: z.string().min(1),
  kind: ClaimKind,
  citations: z.array(Citation),
  /** Lead claims only: ids of the body claims this sentence summarizes. */
  supports: z.array(ClaimId),
  /** Set when an update could not re-verify this claim; the reader shows an out-of-date banner. */
  staleSince: GitSha.nullable(),
  /** Candidate for the Main Page "Did you know…" list. */
  hook: z.boolean(),
});
export type Claim = z.infer<typeof Claim>;
```

`packages/core/src/test-fixtures.ts`:
```ts
import type { CodeCitation, CommitCitation } from "./citation.ts";
import type { Claim } from "./claim.ts";
import { contentHash } from "./content-hash.ts";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

export function codeCitation(overrides: Partial<CodeCitation> = {}): CodeCitation {
  return {
    kind: "code",
    path: "src/signals/ingest.py",
    startLine: 10,
    endLine: 24,
    sha: SHA_A,
    symbol: "ingest_chunk",
    contentHash: contentHash("def ingest_chunk(chunk):\n    ..."),
    ...overrides,
  };
}

export function commitCitation(overrides: Partial<CommitCitation> = {}): CommitCitation {
  return { kind: "commit", sha: SHA_A, subject: "feat: add signal ingestion", pr: 45, ...overrides };
}

export function bodyClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "c-1",
    text: "Signals are created from ingested chunks.",
    kind: "fact",
    citations: [codeCitation()],
    supports: [],
    staleSince: null,
    hook: false,
    ...overrides,
  };
}
```

`packages/core/src/index.ts`:
```ts
export { CodeCitation, CommitCitation, Citation } from "./citation.ts";
export { Claim, ClaimId, ClaimKind } from "./claim.ts";
export { contentHash } from "./content-hash.ts";
export { GitSha, IsoDateTime, RepoPath, Sha256Hex } from "./primitives.ts";
export { SCHEMA_VERSION } from "./version.ts";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (the new tests plus the Task 1 test).

- [ ] **Step 6: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): add primitives, contentHash, Citation and Claim schemas"
```

- [ ] **Step 7: Ship.** PR title: `feat(core): citation and claim schemas`, body `Closes #<M1-1 ticket>`.

---

### Task 6: Section schema with citation rules

**Ticket:** `[M1] core: Section schema with citation rules`

**Files:**
- Create: `packages/core/src/section.ts`
- Modify: `packages/core/src/test-fixtures.ts` (add `leadClaim`), `packages/core/src/index.ts`
- Test: `packages/core/src/section.test.ts`

**Interfaces:**
- Consumes: `Claim` and the fixtures from Task 5.
- Produces: `SectionKey` (`"lead" | "overview" | "how-it-works" | "data-flow" | "history" | "known-limitations"`), `Section`, `claimRuleViolations(key: SectionKey, claim: Claim): string[]`, fixture `leadClaim()`.

- [ ] **Step 1: Branch**

```bash
git switch -c m1/section-rules
```

- [ ] **Step 2: Add the `leadClaim` fixture.** Append to `packages/core/src/test-fixtures.ts`:

```ts
export function leadClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "lead-1",
    text: "**Signal ingestion** is the subsystem that turns ingested chunks into signals.",
    kind: "fact",
    citations: [],
    supports: ["c-1"],
    staleSince: null,
    hook: false,
    ...overrides,
  };
}
```

- [ ] **Step 3: Write the failing tests**

`packages/core/src/section.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Claim } from "./claim.ts";
import { Section, type SectionKey, claimRuleViolations } from "./section.ts";
import { bodyClaim, codeCitation, commitCitation, leadClaim } from "./test-fixtures.ts";

describe("claimRuleViolations", () => {
  const valid: Array<[SectionKey, Claim]> = [
    ["lead", leadClaim()],
    ["overview", bodyClaim()],
    ["how-it-works", bodyClaim({ citations: [codeCitation(), commitCitation()] })],
    ["history", bodyClaim({ kind: "history", citations: [commitCitation()] })],
    ["known-limitations", bodyClaim({ kind: "limitation" })],
  ];

  it.each(valid)("accepts a valid %s claim", (key, claim) => {
    expect(claimRuleViolations(key, claim)).toEqual([]);
  });

  const invalid: Array<[string, SectionKey, Claim, string]> = [
    ["lead with citations", "lead", leadClaim({ citations: [codeCitation()] }), "lead claims carry no citations"],
    ["lead supporting nothing", "lead", leadClaim({ supports: [] }), "lead claims must support"],
    ["uncited body claim", "overview", bodyClaim({ citations: [] }), "at least one citation"],
    ["body claim with supports", "overview", bodyClaim({ supports: ["c-2"] }), "only lead claims may support"],
    ["history without a commit", "history", bodyClaim({ kind: "history" }), "need a commit citation"],
    ["limitation outside its section", "overview", bodyClaim({ kind: "limitation" }), "overview claims must be fact"],
    ["fact in history", "history", bodyClaim({ citations: [commitCitation()] }), "history claims must be history"],
  ];

  it.each(invalid)("rejects %s", (_name, key, claim, fragment) => {
    expect(claimRuleViolations(key, claim).join("; ")).toContain(fragment);
  });
});

describe("Section", () => {
  it("reports violations at the offending claim's path", () => {
    const result = Section.safeParse({ key: "overview", claims: [bodyClaim({ citations: [] })] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["claims", 0]);
  });

  it("rejects empty sections", () => {
    expect(Section.safeParse({ key: "overview", claims: [] }).success).toBe(false);
  });

  it("rejects rendered-only keys", () => {
    expect(Section.safeParse({ key: "references", claims: [bodyClaim()] }).success).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/section.test.ts`
Expected: FAIL, because `./section.ts` does not exist.

- [ ] **Step 5: Implement**

`packages/core/src/section.ts`:
```ts
import { z } from "zod";
import { Claim, type ClaimKind } from "./claim.ts";

/** Stored sections. "See also" and "References" are rendered from Revision.seeAlso and citations. */
export const SectionKey = z.enum([
  "lead",
  "overview",
  "how-it-works",
  "data-flow",
  "history",
  "known-limitations",
]);
export type SectionKey = z.infer<typeof SectionKey>;

function expectedKind(key: SectionKey): ClaimKind {
  if (key === "history") return "history";
  if (key === "known-limitations") return "limitation";
  return "fact";
}

/** Every citation-rule violation for one claim in a section (spec §5, rules 2–4). */
export function claimRuleViolations(key: SectionKey, claim: Claim): string[] {
  const violations: string[] = [];
  const kind = expectedKind(key);
  if (claim.kind !== kind) violations.push(`${key} claims must be ${kind} claims`);

  if (key === "lead") {
    if (claim.citations.length > 0) {
      violations.push("lead claims carry no citations; cite the body claims they support");
    }
    if (claim.supports.length === 0) violations.push("lead claims must support at least one body claim");
    return violations;
  }

  if (claim.supports.length > 0) violations.push("only lead claims may support other claims");
  if (claim.citations.length === 0) violations.push("body claims need at least one citation");
  if (claim.kind === "history" && !claim.citations.some((c) => c.kind === "commit")) {
    violations.push("history claims need a commit citation");
  }
  return violations;
}

export const Section = z
  .object({ key: SectionKey, claims: z.array(Claim).min(1) })
  .superRefine((section, ctx) => {
    section.claims.forEach((claim, index) => {
      for (const message of claimRuleViolations(section.key, claim)) {
        ctx.addIssue({ code: "custom", message, path: ["claims", index] });
      }
    });
  });
export type Section = z.infer<typeof Section>;
```

Add to `packages/core/src/index.ts`:
```ts
export { Section, SectionKey, claimRuleViolations } from "./section.ts";
```

- [ ] **Step 6: Run the check to verify it passes**

Run: `pnpm check`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): add Section schema enforcing claim citation rules"
```

- [ ] **Step 8: Ship.** PR title: `feat(core): section schema with citation rules`, body `Closes #<M1-2 ticket>`.

---

### Task 7: Feature and Manifest schemas

**Ticket:** `[M1] core: Feature and Manifest schemas`

**Files:**
- Create: `packages/core/src/feature.ts`, `packages/core/src/manifest.ts`
- Modify: `packages/core/src/test-fixtures.ts` (add `makeFeature`, `makeManifest`), `packages/core/src/index.ts`
- Test: `packages/core/src/feature.test.ts`, `packages/core/src/manifest.test.ts`

**Interfaces:**
- Consumes: `GitSha` from Task 5.
- Produces: `FeatureId`, `FeatureStatus`, `LineageEvent`, `Feature`, `MemberId`, `Membership`, `Manifest`; fixtures `makeFeature()` (id `signals`) and `makeManifest()` (features `signals` and `deliverables`, at `SHA_A`).

- [ ] **Step 1: Branch**

```bash
git switch -c m1/feature-manifest-schemas
```

- [ ] **Step 2: Add fixtures.** Append to `packages/core/src/test-fixtures.ts`:

```ts
import type { Feature } from "./feature.ts";
import type { Manifest } from "./manifest.ts";

export function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "signals",
    title: "Signal ingestion",
    aliases: ["signal pipeline"],
    status: { kind: "active" },
    lineage: [{ kind: "create", sha: SHA_A }],
    ...overrides,
  };
}

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    sha: SHA_A,
    features: [makeFeature(), makeFeature({ id: "deliverables", title: "Deliverables", aliases: [] })],
    membership: {
      "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 },
      "src/deliverables/crud.py": { featureId: "deliverables", weight: 0.7 },
    },
    ...overrides,
  };
}
```

Move the two new `import type` lines up to join the existing imports at the top of the file, so Biome's import sorting passes.

- [ ] **Step 3: Write the failing tests**

`packages/core/src/feature.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Feature, FeatureId } from "./feature.ts";
import { SHA_A, SHA_B, makeFeature } from "./test-fixtures.ts";

describe("FeatureId", () => {
  it.each(["signals", "signal-ingestion", "sow-v2"])("accepts %s", (id) => {
    expect(FeatureId.safeParse(id).success).toBe(true);
  });

  it.each(["Signals", "signal_ingestion", "-signals", "signals-", "", "a--b"])("rejects %j", (id) => {
    expect(FeatureId.safeParse(id).success).toBe(false);
  });
});

describe("Feature", () => {
  it("accepts an active feature", () => {
    expect(Feature.parse(makeFeature())).toEqual(makeFeature());
  });

  it("requires lineage to start with create", () => {
    const lineage = [{ kind: "rename" as const, sha: SHA_A, fromTitle: "Signals" }];
    expect(Feature.safeParse(makeFeature({ lineage })).success).toBe(false);
  });

  it("rejects a redirect to itself", () => {
    expect(Feature.safeParse(makeFeature({ status: { kind: "redirect", to: "signals" } })).success).toBe(false);
  });

  it("requires a disambiguation to list at least two targets", () => {
    const status = { kind: "disambiguation" as const, to: ["signal-ingest"] };
    expect(Feature.safeParse(makeFeature({ status })).success).toBe(false);
  });

  it("accepts merge and split lineage events", () => {
    const lineage = [
      { kind: "create" as const, sha: SHA_A },
      { kind: "split" as const, sha: SHA_B, into: ["signal-ingest", "signal-scoring"] },
    ];
    const status = { kind: "disambiguation" as const, to: ["signal-ingest", "signal-scoring"] };
    expect(Feature.safeParse(makeFeature({ lineage, status })).success).toBe(true);
  });
});
```

`packages/core/src/manifest.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Manifest } from "./manifest.ts";
import { makeFeature, makeManifest } from "./test-fixtures.ts";

describe("Manifest", () => {
  it("accepts a consistent manifest", () => {
    expect(Manifest.parse(makeManifest())).toEqual(makeManifest());
  });

  it("rejects duplicate feature ids", () => {
    expect(Manifest.safeParse(makeManifest({ features: [makeFeature(), makeFeature()] })).success).toBe(false);
  });

  it("rejects membership pointing at an unknown feature", () => {
    const membership = { "src/x.py": { featureId: "ghost", weight: 0.5 } };
    expect(Manifest.safeParse(makeManifest({ membership })).success).toBe(false);
  });

  it("rejects membership pointing at a redirect", () => {
    const features = [
      makeFeature(),
      makeFeature({ id: "deliverables", title: "Deliverables", status: { kind: "redirect", to: "signals" } }),
    ];
    expect(Manifest.safeParse(makeManifest({ features })).success).toBe(false);
  });

  it("rejects redirect targets that do not exist", () => {
    const features = [makeFeature({ status: { kind: "redirect", to: "ghost" } })];
    expect(Manifest.safeParse(makeManifest({ features, membership: {} })).success).toBe(false);
  });

  it("rejects weights outside (0, 1]", () => {
    const membership = { "src/x.py": { featureId: "signals", weight: 1.5 } };
    expect(Manifest.safeParse(makeManifest({ membership })).success).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/feature.test.ts packages/core/src/manifest.test.ts`
Expected: FAIL, because `./feature.ts` and `./manifest.ts` do not exist.

- [ ] **Step 5: Implement**

`packages/core/src/feature.ts`:
```ts
import { z } from "zod";
import { GitSha } from "./primitives.ts";

/** Permanent lowercase kebab-case slug. Never reused or renamed once assigned. */
export const FeatureId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "feature ids are lowercase kebab-case slugs");
export type FeatureId = z.infer<typeof FeatureId>;

export const FeatureStatus = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("active") }),
  z.object({ kind: z.literal("redirect"), to: FeatureId }),
  z.object({ kind: z.literal("disambiguation"), to: z.array(FeatureId).min(2) }),
  z.object({ kind: z.literal("retired") }),
]);
export type FeatureStatus = z.infer<typeof FeatureStatus>;

export const LineageEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), sha: GitSha }),
  z.object({ kind: z.literal("rename"), sha: GitSha, fromTitle: z.string().min(1) }),
  z.object({ kind: z.literal("merge"), sha: GitSha, into: FeatureId }),
  z.object({ kind: z.literal("split"), sha: GitSha, into: z.array(FeatureId).min(2) }),
  z.object({ kind: z.literal("retire"), sha: GitSha }),
]);
export type LineageEvent = z.infer<typeof LineageEvent>;

export const Feature = z
  .object({
    id: FeatureId,
    title: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    status: FeatureStatus,
    lineage: z.array(LineageEvent).min(1),
  })
  .superRefine((feature, ctx) => {
    if (feature.lineage[0]?.kind !== "create") {
      ctx.addIssue({ code: "custom", message: "lineage must start with create", path: ["lineage", 0] });
    }
    if (feature.status.kind === "redirect" && feature.status.to === feature.id) {
      ctx.addIssue({ code: "custom", message: "a feature cannot redirect to itself", path: ["status"] });
    }
  });
export type Feature = z.infer<typeof Feature>;
```

`packages/core/src/manifest.ts`:
```ts
import { z } from "zod";
import { Feature, FeatureId } from "./feature.ts";
import { GitSha } from "./primitives.ts";

/** "path" for file-level members, "path#symbol" for symbol-level members. */
export const MemberId = z.string().min(1);

export const Membership = z.object({ featureId: FeatureId, weight: z.number().gt(0).lte(1) });
export type Membership = z.infer<typeof Membership>;

export const Manifest = z
  .object({
    sha: GitSha,
    features: z.array(Feature),
    membership: z.record(MemberId, Membership),
  })
  .superRefine((manifest, ctx) => {
    const byId = new Map<string, Feature>();
    manifest.features.forEach((feature, index) => {
      if (byId.has(feature.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate feature id ${feature.id}`, path: ["features", index] });
      }
      byId.set(feature.id, feature);
    });

    manifest.features.forEach((feature, index) => {
      const targets =
        feature.status.kind === "redirect"
          ? [feature.status.to]
          : feature.status.kind === "disambiguation"
            ? feature.status.to
            : [];
      for (const target of targets) {
        if (!byId.has(target)) {
          ctx.addIssue({ code: "custom", message: `unknown target ${target}`, path: ["features", index, "status"] });
        }
      }
    });

    for (const [member, { featureId }] of Object.entries(manifest.membership)) {
      if (byId.get(featureId)?.status.kind !== "active") {
        ctx.addIssue({
          code: "custom",
          message: `${member} belongs to ${featureId}, which is not an active feature`,
          path: ["membership", member],
        });
      }
    }
  });
export type Manifest = z.infer<typeof Manifest>;
```

Add to `packages/core/src/index.ts`:
```ts
export { Feature, FeatureId, FeatureStatus, LineageEvent } from "./feature.ts";
export { Manifest, MemberId, Membership } from "./manifest.ts";
```

- [ ] **Step 6: Run the check to verify it passes**

Run: `pnpm check`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): add Feature and Manifest schemas with referential checks"
```

- [ ] **Step 8: Ship.** PR title: `feat(core): feature and manifest schemas`, body `Closes #<M1-3 ticket>`.

---

### Task 8: Revision and WikiExport schemas

**Ticket:** `[M1] core: Revision and WikiExport schemas`

**Files:**
- Create: `packages/core/src/revision.ts`, `packages/core/src/export.ts`
- Modify: `packages/core/src/test-fixtures.ts` (add `makeRevision`), `packages/core/src/index.ts`
- Test: `packages/core/src/revision.test.ts`, `packages/core/src/export.test.ts`

**Interfaces:**
- Consumes: `Section`, `FeatureId`, `Manifest`, `GitSha`, `IsoDateTime`, `SCHEMA_VERSION`.
- Produces: `RevisionReason`, `TokenUsage`, `Infobox`, `Revision`, `HistoryEntry`, `WikiExport`; fixture `makeRevision()` (id `rev-1`, feature `signals`, reason `build`, lead claim `lead-1` supporting body claim `c-1`).

- [ ] **Step 1: Branch**

```bash
git switch -c m1/revision-export-schemas
```

- [ ] **Step 2: Add the fixture.** Append to `packages/core/src/test-fixtures.ts`, merging the import into the top-level imports:

```ts
import type { Revision } from "./revision.ts";

export function makeRevision(overrides: Partial<Revision> = {}): Revision {
  return {
    id: "rev-1",
    featureId: "signals",
    sha: SHA_A,
    commitDate: "2026-02-03T10:00:00-05:00",
    generatedAt: "2026-09-30T20:00:00Z",
    parentId: null,
    reason: "build",
    pr: null,
    model: "claude-haiku-4-5",
    tokens: { in: 1200, out: 300, cacheRead: 0, cacheWrite: 0 },
    infobox: {
      files: 3,
      loc: 240,
      languages: ["Python"],
      entryPoints: ["src/signals/ingest.py"],
      firstCommitDate: "2026-01-26T09:00:00-05:00",
      lastCommitDate: "2026-02-03T10:00:00-05:00",
    },
    diagram: null,
    seeAlso: ["deliverables"],
    sections: [
      { key: "lead", claims: [leadClaim()] },
      { key: "overview", claims: [bodyClaim()] },
    ],
    ...overrides,
  };
}
```

- [ ] **Step 3: Write the failing tests**

`packages/core/src/revision.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Revision } from "./revision.ts";
import { bodyClaim, leadClaim, makeRevision } from "./test-fixtures.ts";

const ok = (overrides: Parameters<typeof makeRevision>[0]) => Revision.safeParse(makeRevision(overrides)).success;

describe("Revision", () => {
  it("accepts a build revision", () => {
    expect(Revision.parse(makeRevision())).toEqual(makeRevision());
  });

  it("accepts commit dates with any offset", () => {
    expect(ok({ commitDate: "2026-02-03T17:00:00+02:00" })).toBe(true);
    expect(ok({ commitDate: "2026-02-03T15:00:00Z" })).toBe(true);
  });

  it("rejects date-only and offset-less timestamps", () => {
    expect(ok({ commitDate: "2026-02-03" })).toBe(false);
    expect(ok({ commitDate: "2026-02-03T10:00:00" })).toBe(false);
  });

  it("requires the lead section first", () => {
    expect(ok({ sections: [{ key: "overview", claims: [bodyClaim()] }, { key: "lead", claims: [leadClaim()] }] })).toBe(false);
  });

  it("rejects duplicate section keys", () => {
    const overview = { key: "overview" as const, claims: [bodyClaim()] };
    expect(ok({ sections: [{ key: "lead", claims: [leadClaim()] }, overview, { ...overview, claims: [bodyClaim({ id: "c-2" })] }] })).toBe(false);
  });

  it("rejects duplicate claim ids across sections", () => {
    const sections = [
      { key: "lead" as const, claims: [leadClaim()] },
      { key: "overview" as const, claims: [bodyClaim()] },
      { key: "how-it-works" as const, claims: [bodyClaim()] },
    ];
    expect(ok({ sections })).toBe(false);
  });

  it("rejects lead claims that support unknown claims", () => {
    expect(ok({ sections: [{ key: "lead", claims: [leadClaim({ supports: ["ghost"] })] }, { key: "overview", claims: [bodyClaim()] }] })).toBe(false);
  });

  it("ties parentId to the reason", () => {
    expect(ok({ reason: "build", parentId: "rev-0" })).toBe(false);
    expect(ok({ reason: "update", parentId: null })).toBe(false);
    expect(ok({ reason: "update", parentId: "rev-0" })).toBe(true);
  });

  it("rejects seeAlso pointing at the page itself", () => {
    expect(ok({ seeAlso: ["signals"] })).toBe(false);
  });
});
```

`packages/core/src/export.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { WikiExport } from "./export.ts";
import { SHA_A, makeManifest, makeRevision } from "./test-fixtures.ts";

function makeExport(overrides: Partial<WikiExport> = {}): WikiExport {
  const page = makeRevision();
  return {
    schemaVersion: 1,
    repo: "next-chief-of-staff",
    head: SHA_A,
    exportedAt: "2026-09-30T21:00:00Z",
    manifest: makeManifest(),
    pages: [page],
    history: {
      signals: [{ id: page.id, sha: page.sha, commitDate: page.commitDate, reason: page.reason, pr: page.pr }],
    },
    ...overrides,
  };
}

describe("WikiExport", () => {
  it("accepts a consistent export", () => {
    expect(WikiExport.parse(makeExport())).toEqual(makeExport());
  });

  it("rejects a different schema version", () => {
    expect(WikiExport.safeParse({ ...makeExport(), schemaVersion: 2 }).success).toBe(false);
  });

  it("rejects pages for features missing from the manifest", () => {
    const page = makeRevision({ featureId: "ghost" });
    const history = { ghost: [{ id: page.id, sha: page.sha, commitDate: page.commitDate, reason: page.reason, pr: null }] };
    expect(WikiExport.safeParse(makeExport({ pages: [page], history })).success).toBe(false);
  });

  it("requires each page to be the last entry of its history", () => {
    expect(WikiExport.safeParse(makeExport({ history: { signals: [] } })).success).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/revision.test.ts packages/core/src/export.test.ts`
Expected: FAIL, because `./revision.ts` and `./export.ts` do not exist.

- [ ] **Step 5: Implement**

`packages/core/src/revision.ts`:
```ts
import { z } from "zod";
import { FeatureId } from "./feature.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
import { Section } from "./section.ts";

export const RevisionReason = z.enum(["build", "update", "manifest-change"]);
export type RevisionReason = z.infer<typeof RevisionReason>;

const count = z.int().nonnegative();

export const TokenUsage = z.object({ in: count, out: count, cacheRead: count, cacheWrite: count });
export type TokenUsage = z.infer<typeof TokenUsage>;

export const Infobox = z.object({
  files: count,
  loc: count,
  languages: z.array(z.string().min(1)),
  entryPoints: z.array(z.string().min(1)),
  firstCommitDate: IsoDateTime,
  lastCommitDate: IsoDateTime,
});
export type Infobox = z.infer<typeof Infobox>;

export const Revision = z
  .object({
    id: z.string().min(1),
    featureId: FeatureId,
    sha: GitSha,
    /** Date shown to readers: the commit's date, not when RepoWiki generated the page. */
    commitDate: IsoDateTime,
    generatedAt: IsoDateTime,
    parentId: z.string().min(1).nullable(),
    reason: RevisionReason,
    pr: z.int().positive().nullable(),
    model: z.string().min(1),
    tokens: TokenUsage,
    infobox: Infobox,
    /** Mermaid source for the data-flow diagram, or null when the page has none. */
    diagram: z.string().min(1).nullable(),
    seeAlso: z.array(FeatureId),
    sections: z.array(Section).min(1),
  })
  .superRefine((revision, ctx) => {
    if (revision.sections[0]?.key !== "lead") {
      ctx.addIssue({ code: "custom", message: "the first section must be the lead", path: ["sections", 0] });
    }

    const keys = new Set<string>();
    const bodyClaimIds = new Set<string>();
    const allClaimIds = new Set<string>();
    revision.sections.forEach((section, s) => {
      if (keys.has(section.key)) {
        ctx.addIssue({ code: "custom", message: `duplicate section ${section.key}`, path: ["sections", s] });
      }
      keys.add(section.key);
      section.claims.forEach((claim, c) => {
        if (allClaimIds.has(claim.id)) {
          ctx.addIssue({ code: "custom", message: `duplicate claim id ${claim.id}`, path: ["sections", s, "claims", c] });
        }
        allClaimIds.add(claim.id);
        if (section.key !== "lead") bodyClaimIds.add(claim.id);
      });
    });

    revision.sections.forEach((section, s) => {
      if (section.key !== "lead") return;
      section.claims.forEach((claim, c) => {
        for (const supported of claim.supports) {
          if (!bodyClaimIds.has(supported)) {
            ctx.addIssue({
              code: "custom",
              message: `lead claim ${claim.id} supports unknown body claim ${supported}`,
              path: ["sections", s, "claims", c, "supports"],
            });
          }
        }
      });
    });

    if ((revision.reason === "build") !== (revision.parentId === null)) {
      ctx.addIssue({
        code: "custom",
        message: "build revisions have no parent; update and manifest-change revisions must have one",
        path: ["parentId"],
      });
    }
    if (revision.seeAlso.includes(revision.featureId)) {
      ctx.addIssue({ code: "custom", message: "seeAlso cannot include the page itself", path: ["seeAlso"] });
    }
  });
export type Revision = z.infer<typeof Revision>;
```

`packages/core/src/export.ts`:
```ts
import { z } from "zod";
import { FeatureId } from "./feature.ts";
import { Manifest } from "./manifest.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
import { Revision, RevisionReason } from "./revision.ts";
import { SCHEMA_VERSION } from "./version.ts";

export const HistoryEntry = z.object({
  id: z.string().min(1),
  sha: GitSha,
  commitDate: IsoDateTime,
  reason: RevisionReason,
  pr: z.int().positive().nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** Everything the reader site and agents consume. Pages are the current revision of each feature. */
export const WikiExport = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repo: z.string().min(1),
    head: GitSha,
    exportedAt: IsoDateTime,
    manifest: Manifest,
    pages: z.array(Revision),
    /** Oldest first, per feature. */
    history: z.record(FeatureId, z.array(HistoryEntry)),
  })
  .superRefine((wiki, ctx) => {
    const known = new Set(wiki.manifest.features.map((f) => f.id));
    const seen = new Set<string>();
    wiki.pages.forEach((page, index) => {
      if (seen.has(page.featureId)) {
        ctx.addIssue({ code: "custom", message: `two pages for ${page.featureId}`, path: ["pages", index] });
      }
      seen.add(page.featureId);
      if (!known.has(page.featureId)) {
        ctx.addIssue({ code: "custom", message: `${page.featureId} is not in the manifest`, path: ["pages", index] });
      }
      if (wiki.history[page.featureId]?.at(-1)?.id !== page.id) {
        ctx.addIssue({
          code: "custom",
          message: `history for ${page.featureId} must end with page ${page.id}`,
          path: ["history", page.featureId],
        });
      }
    });
  });
export type WikiExport = z.infer<typeof WikiExport>;
```

Add to `packages/core/src/index.ts`:
```ts
export { HistoryEntry, WikiExport } from "./export.ts";
export { Infobox, Revision, RevisionReason, TokenUsage } from "./revision.ts";
```

- [ ] **Step 6: Run the check to verify it passes**

Run: `pnpm check`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): add Revision and WikiExport schemas"
```

- [ ] **Step 8: Ship.** PR title: `feat(core): revision and export schemas`, body `Closes #<M1-4 ticket>`.

---

### Task 9: Store: open, migrations, manifests, head

**Ticket:** `[M1] store: open, migrations, manifests, head`

**Files:**
- Create: `packages/engine/package.json`, `packages/engine/src/index.ts`, `packages/engine/src/store/errors.ts`, `packages/engine/src/store/migrations.ts`, `packages/engine/src/store/store.ts`
- Modify: `pnpm-workspace.yaml` (allow the better-sqlite3 build script)
- Test: `packages/engine/src/store/migrations.test.ts`, `packages/engine/src/store/manifests.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `GitSha` from `@repowiki/core`; fixtures `makeManifest`, `SHA_A`, `SHA_B`.
- Produces:
  ```ts
  interface Store {
    close(): void;
    transaction<T>(fn: () => T): T;
    putManifest(manifest: Manifest): void;          // throws DuplicateManifestError
    getManifest(sha: string): Manifest | null;
    getLatestManifest(): Manifest | null;
    setHead(sha: string): void;
    getHead(): string | null;
  }
  function openStore(path: string): Store;          // ":memory:" allowed
  class StoreError, UnsupportedSchemaError, DuplicateManifestError, StaleParentError, EmptyStoreError
  const MIGRATIONS: readonly string[]
  ```

- [ ] **Step 1: Branch and create the engine package**

```bash
git switch -c m1/store-foundation
```

`packages/engine/package.json`:
```json
{
  "name": "@repowiki/engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@repowiki/core": "workspace:*",
    "better-sqlite3": "13.0.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "9.6.0"
  }
}
```

Replace `pnpm-workspace.yaml` with:
```yaml
packages:
  - "packages/*"
onlyBuiltDependencies:
  - better-sqlite3
```

Run: `pnpm install`
Expected: better-sqlite3's native build is downloaded or compiled without the "Ignored build scripts" warning.

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/store/migrations.test.ts`:
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeManifest } from "@repowiki/core/test-fixtures";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { UnsupportedSchemaError } from "./errors.ts";
import { MIGRATIONS } from "./migrations.ts";
import { openStore } from "./store.ts";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-store-"));
  dirs.push(dir);
  return join(dir, "wiki.db");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("brings a new database to the latest schema version", () => {
    const path = tempDbPath();
    openStore(path).close();
    const db = new Database(path);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });

  it("keeps data across reopen without re-running migrations", () => {
    const path = tempDbPath();
    const first = openStore(path);
    first.putManifest(makeManifest());
    first.close();
    const second = openStore(path);
    expect(second.getManifest(makeManifest().sha)).toEqual(makeManifest());
    second.close();
  });

  it("refuses a database written by a newer RepoWiki and leaves it untouched", () => {
    const path = tempDbPath();
    const db = new Database(path);
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    expect(() => openStore(path)).toThrow(UnsupportedSchemaError);
    const after = new Database(path);
    expect(after.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length + 1);
    after.close();
  });
});
```

`packages/engine/src/store/manifests.test.ts`:
```ts
import { SHA_A, SHA_B, makeManifest } from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuplicateManifestError } from "./errors.ts";
import { type Store, openStore } from "./store.ts";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => store.close());

describe("manifests", () => {
  it("round-trips a manifest by sha", () => {
    store.putManifest(makeManifest());
    expect(store.getManifest(SHA_A)).toEqual(makeManifest());
    expect(store.getManifest(SHA_B)).toBeNull();
  });

  it("returns the most recently stored manifest as latest", () => {
    expect(store.getLatestManifest()).toBeNull();
    store.putManifest(makeManifest());
    store.putManifest(makeManifest({ sha: SHA_B }));
    expect(store.getLatestManifest()?.sha).toBe(SHA_B);
  });

  it("refuses a second manifest for the same sha", () => {
    store.putManifest(makeManifest());
    expect(() => store.putManifest(makeManifest())).toThrow(DuplicateManifestError);
  });

  it("validates before storing", () => {
    const invalid = makeManifest({ membership: { "src/x.py": { featureId: "ghost", weight: 0.5 } } });
    expect(() => store.putManifest(invalid)).toThrow();
    expect(store.getLatestManifest()).toBeNull();
  });

  it("rolls back everything written inside a failed transaction", () => {
    expect(() =>
      store.transaction(() => {
        store.putManifest(makeManifest());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getLatestManifest()).toBeNull();
  });
});

describe("head", () => {
  it("is null until set, then returns the last value", () => {
    expect(store.getHead()).toBeNull();
    store.setHead(SHA_A);
    store.setHead(SHA_B);
    expect(store.getHead()).toBe(SHA_B);
  });

  it("rejects abbreviated shas", () => {
    expect(() => store.setHead("abc123")).toThrow();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/engine`
Expected: FAIL, because `./errors.ts`, `./migrations.ts`, and `./store.ts` do not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/store/errors.ts`:
```ts
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnsupportedSchemaError extends StoreError {
  constructor(found: number, supported: number) {
    super(
      `store schema version ${found} is newer than this RepoWiki supports (${supported}); upgrade RepoWiki`,
    );
  }
}

export class DuplicateManifestError extends StoreError {
  constructor(sha: string) {
    super(`a manifest for ${sha} is already stored`);
  }
}

export class StaleParentError extends StoreError {
  constructor(featureId: string, current: string | null, parent: string | null) {
    super(
      `revision for ${featureId} names parent ${parent ?? "none"}, but the current revision is ${current ?? "none"}`,
    );
  }
}

export class EmptyStoreError extends StoreError {
  constructor() {
    super("nothing to export: the store has no head sha or manifest yet; run `repowiki build` first");
  }
}
```

`packages/engine/src/store/migrations.ts`:
```ts
import type Database from "better-sqlite3";
import { UnsupportedSchemaError } from "./errors.ts";

/**
 * Ordered schema migrations. Entry i upgrades a database from user_version i to i + 1.
 * Never edit a shipped entry; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE manifests (
    sha TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    body TEXT NOT NULL
  );
  CREATE TABLE revisions (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    parent_id TEXT REFERENCES revisions(id),
    body TEXT NOT NULL
  );
  CREATE INDEX revisions_feature ON revisions(feature_id);
  CREATE TABLE current_revisions (
    feature_id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES revisions(id)
  );
  CREATE TABLE citation_ranges (
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    claim_id TEXT NOT NULL,
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL
  );
  CREATE INDEX citation_ranges_lookup ON citation_ranges(path, start_line, end_line);
  `,
];

export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.length) throw new UnsupportedSchemaError(current, MIGRATIONS.length);
  db.transaction(() => {
    for (const [index, sql] of MIGRATIONS.entries()) {
      if (index < current) continue;
      db.exec(sql);
      db.pragma(`user_version = ${index + 1}`);
    }
  })();
}
```

`packages/engine/src/store/store.ts`:
```ts
import { GitSha, Manifest } from "@repowiki/core";
import Database from "better-sqlite3";
import { DuplicateManifestError } from "./errors.ts";
import { migrate } from "./migrations.ts";

export interface Store {
  close(): void;
  /** Runs fn atomically; nested calls become savepoints. */
  transaction<T>(fn: () => T): T;
  putManifest(manifest: Manifest): void;
  getManifest(sha: string): Manifest | null;
  getLatestManifest(): Manifest | null;
  /** The last sha the wiki was built or updated to. */
  setHead(sha: string): void;
  getHead(): string | null;
}

interface BodyRow {
  body: string;
}

export function openStore(path: string): Store {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);

  const readManifest = (row: BodyRow | undefined): Manifest | null =>
    row === undefined ? null : Manifest.parse(JSON.parse(row.body));

  return {
    close: () => db.close(),
    transaction: (fn) => db.transaction(fn)(),

    putManifest(manifest) {
      const parsed = Manifest.parse(manifest);
      if (db.prepare("SELECT 1 FROM manifests WHERE sha = ?").get(parsed.sha) !== undefined) {
        throw new DuplicateManifestError(parsed.sha);
      }
      db.prepare(
        "INSERT INTO manifests (sha, seq, body) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM manifests), ?)",
      ).run(parsed.sha, JSON.stringify(parsed));
    },

    getManifest: (sha) =>
      readManifest(db.prepare("SELECT body FROM manifests WHERE sha = ?").get(sha) as BodyRow | undefined),

    getLatestManifest: () =>
      readManifest(
        db.prepare("SELECT body FROM manifests ORDER BY seq DESC LIMIT 1").get() as BodyRow | undefined,
      ),

    setHead(sha) {
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('head', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(GitSha.parse(sha));
    },

    getHead() {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'head'").get() as { value: string } | undefined;
      return row?.value ?? null;
    },
  };
}
```

`packages/engine/src/index.ts`:
```ts
export {
  DuplicateManifestError,
  EmptyStoreError,
  StaleParentError,
  StoreError,
  UnsupportedSchemaError,
} from "./store/errors.ts";
export { type Store, openStore } from "./store/store.ts";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(engine): add SQLite store with migrations, manifests, and head"
```

- [ ] **Step 7: Ship.** PR title: `feat(engine): store foundation`, body `Closes #<M1-5 ticket>`.

---

### Task 10: Store: revisions, current pointers, history

**Ticket:** `[M1] store: revisions and history`

**Files:**
- Modify: `packages/engine/src/store/store.ts`
- Test: `packages/engine/src/store/revisions.test.ts`

**Interfaces:**
- Consumes: `Revision` from core; `StaleParentError`; fixtures `makeRevision`, `bodyClaim`, `leadClaim`, `SHA_B`.
- Produces, added to `Store`:
  ```ts
  putRevision(revision: Revision): void;        // throws StaleParentError; atomic
  getRevision(id: string): Revision | null;
  getCurrentRevision(featureId: string): Revision | null;
  listCurrentRevisions(): Revision[];           // sorted by featureId
  listHistory(featureId: string): Revision[];   // oldest first
  ```

- [ ] **Step 1: Branch**

```bash
git switch -c m1/store-revisions
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/store/revisions.test.ts`:
```ts
import { SHA_B, bodyClaim, leadClaim, makeRevision } from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StaleParentError } from "./errors.ts";
import { type Store, openStore } from "./store.ts";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => store.close());

const rev1 = makeRevision();
const rev2 = makeRevision({ id: "rev-2", parentId: "rev-1", reason: "update", sha: SHA_B, pr: 88 });

describe("revisions", () => {
  it("round-trips a revision, including non-ASCII text", () => {
    const unicode = makeRevision({
      sections: [
        { key: "lead", claims: [leadClaim({ text: "**信号** ingestion — ✓ émoji 🚀" })] },
        { key: "overview", claims: [bodyClaim()] },
      ],
    });
    store.putRevision(unicode);
    expect(store.getRevision("rev-1")).toEqual(unicode);
    expect(store.getRevision("missing")).toBeNull();
  });

  it("advances the current revision along the parent chain", () => {
    store.putRevision(rev1);
    store.putRevision(rev2);
    expect(store.getCurrentRevision("signals")).toEqual(rev2);
    expect(store.getCurrentRevision("deliverables")).toBeNull();
  });

  it("lists history oldest first", () => {
    store.putRevision(rev1);
    store.putRevision(rev2);
    expect(store.listHistory("signals").map((r) => r.id)).toEqual(["rev-1", "rev-2"]);
  });

  it("lists one current revision per feature, sorted by feature id", () => {
    store.putRevision(rev1);
    store.putRevision(rev2);
    store.putRevision(makeRevision({ id: "rev-d", featureId: "deliverables", seeAlso: [] }));
    expect(store.listCurrentRevisions().map((r) => r.id)).toEqual(["rev-d", "rev-2"]);
  });

  it("rejects a second build for a feature that already has a page", () => {
    store.putRevision(rev1);
    expect(() => store.putRevision(makeRevision({ id: "rev-1b" }))).toThrow(StaleParentError);
  });

  it("rejects an update built from a parent that is no longer current, and stores nothing", () => {
    store.putRevision(rev1);
    store.putRevision(rev2);
    const sibling = makeRevision({ id: "rev-2b", parentId: "rev-1", reason: "update", sha: SHA_B });
    expect(() => store.putRevision(sibling)).toThrow(StaleParentError);
    expect(store.getRevision("rev-2b")).toBeNull();
    expect(store.getCurrentRevision("signals")?.id).toBe("rev-2");
  });

  it("validates before storing", () => {
    expect(() => store.putRevision(makeRevision({ seeAlso: ["signals"] }))).toThrow();
    expect(store.getRevision("rev-1")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/engine/src/store/revisions.test.ts`
Expected: FAIL with `store.putRevision is not a function` (and a matching typecheck error).

- [ ] **Step 4: Implement.** In `packages/engine/src/store/store.ts`:

Change the core import to `import { GitSha, Manifest, Revision } from "@repowiki/core";` and the errors import to `import { DuplicateManifestError, StaleParentError } from "./errors.ts";`.

Add to the `Store` interface:
```ts
  /** Stores a revision and makes it current. parentId must equal the feature's current revision id. */
  putRevision(revision: Revision): void;
  getRevision(id: string): Revision | null;
  getCurrentRevision(featureId: string): Revision | null;
  /** Current revision of every feature, sorted by feature id. */
  listCurrentRevisions(): Revision[];
  /** Every revision of a feature, oldest first. */
  listHistory(featureId: string): Revision[];
```

Inside `openStore`, after `readManifest`, add:
```ts
  const readRevision = (row: BodyRow | undefined): Revision | null =>
    row === undefined ? null : Revision.parse(JSON.parse(row.body));

  const currentRevisionId = (featureId: string): string | null => {
    const row = db
      .prepare("SELECT revision_id FROM current_revisions WHERE feature_id = ?")
      .get(featureId) as { revision_id: string } | undefined;
    return row?.revision_id ?? null;
  };
```

Add to the returned object:
```ts
    putRevision(revision) {
      const parsed = Revision.parse(revision);
      db.transaction(() => {
        const current = currentRevisionId(parsed.featureId);
        if (current !== parsed.parentId) {
          throw new StaleParentError(parsed.featureId, current, parsed.parentId);
        }
        db.prepare("INSERT INTO revisions (id, feature_id, parent_id, body) VALUES (?, ?, ?, ?)").run(
          parsed.id,
          parsed.featureId,
          parsed.parentId,
          JSON.stringify(parsed),
        );
        const insertRange = db.prepare(
          "INSERT INTO citation_ranges (revision_id, claim_id, path, start_line, end_line) VALUES (?, ?, ?, ?, ?)",
        );
        for (const section of parsed.sections) {
          for (const claim of section.claims) {
            for (const citation of claim.citations) {
              if (citation.kind !== "code") continue;
              insertRange.run(parsed.id, claim.id, citation.path, citation.startLine, citation.endLine);
            }
          }
        }
        db.prepare(
          "INSERT INTO current_revisions (feature_id, revision_id) VALUES (?, ?) ON CONFLICT(feature_id) DO UPDATE SET revision_id = excluded.revision_id",
        ).run(parsed.featureId, parsed.id);
      })();
    },

    getRevision: (id) =>
      readRevision(db.prepare("SELECT body FROM revisions WHERE id = ?").get(id) as BodyRow | undefined),

    getCurrentRevision: (featureId) =>
      readRevision(
        db
          .prepare(
            "SELECT r.body FROM current_revisions c JOIN revisions r ON r.id = c.revision_id WHERE c.feature_id = ?",
          )
          .get(featureId) as BodyRow | undefined,
      ),

    listCurrentRevisions: () =>
      (
        db
          .prepare(
            "SELECT r.body FROM current_revisions c JOIN revisions r ON r.id = c.revision_id ORDER BY c.feature_id",
          )
          .all() as BodyRow[]
      ).map((row) => Revision.parse(JSON.parse(row.body))),

    listHistory: (featureId) =>
      (
        db.prepare("SELECT body FROM revisions WHERE feature_id = ? ORDER BY rowid").all(featureId) as BodyRow[]
      ).map((row) => Revision.parse(JSON.parse(row.body))),
```

`ORDER BY rowid` is the true history order: the parent check means revisions for a feature are inserted strictly in sequence. Commit dates carry mixed offsets and don't sort correctly as strings.

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): store revisions with parent check, current pointers, and history"
```

- [ ] **Step 7: Ship.** PR title: `feat(engine): store revisions and history`, body `Closes #<M1-6 ticket>`.

---

### Task 11: Store: citation range query

**Ticket:** `[M1] store: citation range query`

**Files:**
- Modify: `packages/engine/src/store/store.ts`, `packages/engine/src/index.ts`
- Test: `packages/engine/src/store/citations.test.ts`

**Interfaces:**
- Consumes: `putRevision` from Task 10.
- Produces, added to `Store`:
  ```ts
  interface CitingClaim { featureId: string; revisionId: string; claimId: string; startLine: number; endLine: number }
  findClaimsCitingRange(path: string, startLine: number, endLine: number): CitingClaim[];
  // inclusive overlap, current revisions only, code citations only; RangeError if startLine > endLine
  ```

- [ ] **Step 1: Branch**

```bash
git switch -c m1/store-citation-query
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/store/citations.test.ts`:
```ts
import {
  SHA_B,
  bodyClaim,
  codeCitation,
  commitCitation,
  leadClaim,
  makeRevision,
} from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Store, openStore } from "./store.ts";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
  store.putRevision(makeRevision()); // c-1 cites src/signals/ingest.py L10-24
});
afterEach(() => store.close());

const PATH = "src/signals/ingest.py";
const hits = (start: number, end: number, path = PATH) =>
  store.findClaimsCitingRange(path, start, end).map((c) => c.claimId);

describe("findClaimsCitingRange", () => {
  it("returns the citing claim with its location", () => {
    expect(store.findClaimsCitingRange(PATH, 12, 13)).toEqual([
      { featureId: "signals", revisionId: "rev-1", claimId: "c-1", startLine: 10, endLine: 24 },
    ]);
  });

  it.each([
    [24, 30, "touching the last cited line"],
    [1, 10, "touching the first cited line"],
    [1, 100, "covering the whole range"],
    [10, 10, "a single boundary line"],
  ])("matches %i-%i (%s)", (start, end) => {
    expect(hits(start, end)).toEqual(["c-1"]);
  });

  it.each([
    [25, 30],
    [1, 9],
  ])("does not match the disjoint range %i-%i", (start, end) => {
    expect(hits(start, end)).toEqual([]);
  });

  it("does not match other paths", () => {
    expect(hits(10, 24, "src/signals/ingest_test.py")).toEqual([]);
  });

  it("only considers current revisions", () => {
    const moved = makeRevision({
      id: "rev-2",
      parentId: "rev-1",
      reason: "update",
      sha: SHA_B,
      sections: [
        { key: "lead", claims: [leadClaim()] },
        { key: "overview", claims: [bodyClaim({ citations: [codeCitation({ startLine: 40, endLine: 50 })] })] },
      ],
    });
    store.putRevision(moved);
    expect(hits(10, 24)).toEqual([]);
    expect(hits(45, 45)).toEqual(["c-1"]);
  });

  it("ignores commit citations", () => {
    const history = makeRevision({
      id: "rev-h",
      featureId: "deliverables",
      seeAlso: [],
      sections: [
        { key: "lead", claims: [leadClaim({ supports: ["h-1"] })] },
        { key: "history", claims: [bodyClaim({ id: "h-1", kind: "history", citations: [commitCitation()] })] },
      ],
    });
    store.putRevision(history);
    expect(hits(1, 1000)).toEqual(["c-1"]);
  });

  it("rejects an inverted range", () => {
    expect(() => store.findClaimsCitingRange(PATH, 30, 10)).toThrow(RangeError);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/engine/src/store/citations.test.ts`
Expected: FAIL with `store.findClaimsCitingRange is not a function`.

- [ ] **Step 4: Implement.** In `packages/engine/src/store/store.ts`, add above `Store`:

```ts
/** A current claim whose code citation overlaps a queried line range. */
export interface CitingClaim {
  featureId: string;
  revisionId: string;
  claimId: string;
  startLine: number;
  endLine: number;
}
```

Add to the `Store` interface:
```ts
  /** Current claims with a code citation in path overlapping [startLine, endLine], bounds inclusive. */
  findClaimsCitingRange(path: string, startLine: number, endLine: number): CitingClaim[];
```

Add to the returned object:
```ts
    findClaimsCitingRange(path, startLine, endLine) {
      if (startLine > endLine) throw new RangeError(`startLine ${startLine} > endLine ${endLine}`);
      return db
        .prepare(
          `SELECT r.feature_id AS featureId, c.revision_id AS revisionId, c.claim_id AS claimId,
                  c.start_line AS startLine, c.end_line AS endLine
           FROM citation_ranges c
           JOIN current_revisions cur ON cur.revision_id = c.revision_id
           JOIN revisions r ON r.id = c.revision_id
           WHERE c.path = ? AND c.start_line <= ? AND c.end_line >= ?
           ORDER BY r.feature_id, c.claim_id, c.start_line`,
        )
        .all(path, endLine, startLine) as CitingClaim[];
    },
```

In `packages/engine/src/index.ts`, change the store export line to:
```ts
export { type CitingClaim, type Store, openStore } from "./store/store.ts";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): query current claims citing a line range"
```

- [ ] **Step 7: Ship.** PR title: `feat(engine): citation range query`, body `Closes #<M1-7 ticket>`.

---

### Task 12: Store: JSON export

**Ticket:** `[M1] store: JSON export`

**Files:**
- Create: `packages/engine/src/store/export.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/store/export.test.ts`

**Interfaces:**
- Consumes: `Store` (Tasks 9–11), `WikiExport`, `HistoryEntry`, `SCHEMA_VERSION`, `EmptyStoreError`.
- Produces:
  ```ts
  interface ExportOptions { repo: string; exportedAt: string }
  function buildExport(store: Store, options: ExportOptions): WikiExport;   // throws EmptyStoreError
  function writeExport(store: Store, outPath: string, options: ExportOptions): void;
  ```

- [ ] **Step 1: Branch**

```bash
git switch -c m1/store-export
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/store/export.test.ts`:
```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiExport } from "@repowiki/core";
import { SHA_A, SHA_B, makeManifest, makeRevision } from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmptyStoreError } from "./errors.ts";
import { buildExport, writeExport } from "./export.ts";
import { type Store, openStore } from "./store.ts";

const options = { repo: "next-chief-of-staff", exportedAt: "2026-09-30T21:00:00Z" };
let store: Store;
let dir: string;
beforeEach(() => {
  store = openStore(":memory:");
  dir = mkdtempSync(join(tmpdir(), "repowiki-export-"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  store.putManifest(makeManifest());
  store.putRevision(makeRevision());
  store.putRevision(makeRevision({ id: "rev-2", parentId: "rev-1", reason: "update", sha: SHA_B, pr: 88 }));
  store.setHead(SHA_B);
}

describe("buildExport", () => {
  it("refuses to export an empty store", () => {
    expect(() => buildExport(store, options)).toThrow(EmptyStoreError);
  });

  it("refuses to export a manifest with no head", () => {
    store.putManifest(makeManifest());
    expect(() => buildExport(store, options)).toThrow(EmptyStoreError);
  });

  it("exports current pages with oldest-first history", () => {
    seed();
    const wiki = buildExport(store, options);
    expect(wiki.head).toBe(SHA_B);
    expect(wiki.manifest.sha).toBe(SHA_A);
    expect(wiki.pages.map((p) => p.id)).toEqual(["rev-2"]);
    expect(wiki.history.signals).toEqual([
      { id: "rev-1", sha: SHA_A, commitDate: "2026-02-03T10:00:00-05:00", reason: "build", pr: null },
      { id: "rev-2", sha: SHA_B, commitDate: "2026-02-03T10:00:00-05:00", reason: "update", pr: 88 },
    ]);
  });
});

describe("writeExport", () => {
  it("writes valid, newline-terminated JSON, creating parent directories", () => {
    seed();
    const out = join(dir, "nested", "export.json");
    writeExport(store, out, options);
    const text = readFileSync(out, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(WikiExport.parse(JSON.parse(text))).toEqual(buildExport(store, options));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/engine/src/store/export.test.ts`
Expected: FAIL, because `./export.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/store/export.ts`:
```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type HistoryEntry, type Revision, SCHEMA_VERSION, WikiExport } from "@repowiki/core";
import { EmptyStoreError } from "./errors.ts";
import type { Store } from "./store.ts";

export interface ExportOptions {
  repo: string;
  exportedAt: string;
}

function toHistoryEntry(revision: Revision): HistoryEntry {
  const { id, sha, commitDate, reason, pr } = revision;
  return { id, sha, commitDate, reason, pr };
}

/** Assembles and validates the export consumed by the reader site and by agents. */
export function buildExport(store: Store, options: ExportOptions): WikiExport {
  const head = store.getHead();
  const manifest = store.getLatestManifest();
  if (head === null || manifest === null) throw new EmptyStoreError();

  const pages = store.listCurrentRevisions();
  const history = Object.fromEntries(
    pages.map((page) => [page.featureId, store.listHistory(page.featureId).map(toHistoryEntry)]),
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

Add to `packages/engine/src/index.ts`:
```ts
export { type ExportOptions, buildExport, writeExport } from "./store/export.ts";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): export store contents as validated WikiExport JSON"
```

- [ ] **Step 7: Ship.** PR title: `feat(engine): JSON export`, body `Closes #<M1-8 ticket>`.

- [ ] **Step 8: Close out M1.** Confirm on `main`: `pnpm check` passes, and `gh issue list --state open --search "in:title [M1]"` returns nothing.
