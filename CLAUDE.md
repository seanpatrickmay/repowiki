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
- `packages/llm` — the `Provider` interface, the Claude implementation (structured output, prompt caching, Message Batches), the `TokenLedger`, and record/replay cassettes
- `site`, `cli`, `eval` — added in later milestones
- `scripts/tracker` — seeds GitHub labels and issues from `seed.json`
- `docs/decisions` — ADRs

## Workflow
1. Every change starts from a GitHub issue. Features are `[Fnn]` issues; work happens in `[Mn]` task sub-issues, each sized to one PR.
2. Branch from an up-to-date `main`: `mN/short-description`.
3. TDD: failing test → minimal code → green → commit. Commit at every green step.
4. Commits follow Conventional Commits with a scope, e.g. `feat(core): add Citation schema`. Every commit passes `pnpm check`. No `Co-Authored-By` or AI attribution. Never `--no-verify`.
5. One PR closes exactly one ticket (`Closes #n`) and stays under ~300 changed lines, not counting lockfiles, fixtures, and cassettes.
6. Merge with a merge commit (`gh pr merge --merge --delete-branch --author-email sean.may101@gmail.com`) once CI is green. Merge commits are what replay reads, so they must carry the project email. Never squash or rebase-merge (ADR-0002).
7. Reshaping, deferring, or rejecting a feature requires an ADR in `docs/decisions/`.

## Code rules
- ESM, strict TypeScript, relative imports with the `.ts` extension, no `enum`/`namespace`. Node runs the sources directly via type stripping; there is no build step.
- Validate data at boundaries with the `@repowiki/core` schemas. The store parses on write and on read.
- Tests are co-located `*.test.ts` files. Tests never call the network or an LLM; LLM calls go through record/replay cassettes.
- RepoWiki never writes inside a repo it documents. Wiki data lives in `~/.repowiki/<repo>/` or the `--out` directory.
- Dependency versions are pinned exactly. Review each new dependency (maintenance, downloads, license) before adding it.
- Any change to a @repowiki/core schema that rejects previously stored bodies must ship with a store migration (packages/engine/src/store/migrations.ts) that rewrites them. Never edit a shipped migration; append one.
