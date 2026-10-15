# RepoWiki hosted — Vertical slice (spec 2 of 4) design spec

- **Date:** 2026-10-14
- **Status:** Accepted on the owner's standing instruction to build as much as possible without stopping for questions ("Do everything… Develop as much as you can"). §16 lists the calls he is most likely to revisit; the hosting and provider choices come from the Contract spec's D5.
- **Author:** Sean May
- **Features:** F26 hosted project pages. ADR-0011 records the stack choices below.
- **Builds on:** the Contract spec `2026-10-14-repowiki-hosted-contract-design.md` (cited as "Contract §n"), its `packages/hosted` library, and `main` after M13.

## 1. Brief and goals

Spec 1 fixed the rules. This spec makes one real path work end to end: a developer signs in with GitHub, picks an eligible public repository, a sandboxed job runs the existing engine on it, the developer edits the portfolio layer, reviews, previews and publishes, and a signed-out reader opens the project page and the profile.

Goals, in priority order:

1. **The rules are the Contract's.** Every decision the server makes about who may do what, when a job may run and what may be published is a call into `@repowiki/hosted`, inside one database transaction. The server adds I/O, never policy.
2. **Untrusted repositories stay contained.** Repository content is only processed by a worker that holds no secret, after its network is locked to the LLM proxy. Nothing runs repository code.
3. **Runs without the owner's accounts.** Every external service sits behind a seam with a local implementation, so `pnpm hosted:demo` runs the whole journey on one machine with no account, key or network, and the test suite covers it the same way.
4. **Deployable when the accounts exist.** The production implementations (GitHub OAuth, Neon, R2, Fly Machines, Anthropic) are written and unit-tested against recorded request shapes; the owner's runbook turns them on.

## 2. What the owner gets

- `packages/server`: the hosted web app, the worker's internal API and the LLM proxy, in one Node process (S1).
- `packages/worker`: the program a job Machine runs (S9).
- `pnpm hosted:serve` (production entry, configured by environment), `pnpm hosted:dev` (local Postgres-in-process, local files, local worker child processes, real GitHub OAuth when configured), and `pnpm hosted:demo` (everything faked, including GitHub and the model, on `127.0.0.1`).
- `deploy/`: Dockerfiles for the server and the worker, the worker's entrypoint with its firewall, and `fly.toml` files. Nothing is deployed by this spec.
- `docs/hosted-runbook.md` is not in the repo (CLAUDE.md: no docs unless asked); the owner's manual steps are published to him separately.

## 3. Decisions

Every ruling has the form "Ruling: X — why — cost if wrong".

| # | Topic | Ruling |
|---|---|---|
| S1 | Processes | Ruling: one server process serves the web app, the worker's internal API (`/internal/*`) and the LLM proxy (`/llm/*`); the worker is a separate program on a throwaway Machine. — The trust boundary that matters is sandbox versus everything else; the server already holds the database, encryption key and GitHub tokens, so holding the Anthropic key adds no new class of secret, and one process means one deploy. — Cost if wrong: splitting the proxy out later is a route group moved to its own entry point. |
| S2 | HTTP | Ruling: `node:http` with a small hand-written router; no framework. JSON bodies need `application/json` and are capped at 64 KiB (counted while streaming, from the archived prototype); forms are `application/x-www-form-urlencoded`, capped likewise; unknown fields are refused by the Contract schemas; unexpected errors answer a generic 500. Every response carries `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`. — The repo hand-rolls its MCP server (ADR-0004) for the same reason: a few routes do not justify a dependency. — Cost if wrong: a router swap. |
| S3 | Database | Ruling: Postgres through a two-method `Db` seam (`query`, `transaction`). Production uses `pg` (8.23.1, MIT, ~65M weekly downloads); tests, `hosted:dev` and `hosted:demo` use PGlite (`@electric-sql/pglite` 0.5.8, Apache-2.0, ~24M weekly), real Postgres compiled to WASM, in process. The same SQL runs in both. — Tests cannot use the network; PGlite gives real Postgres semantics (row locks, partial unique indexes, `jsonb`) with no server. — Cost if wrong: a PGlite/Postgres difference a test misses; CI could add a real Postgres service later. |
| S4 | Schema | Ruling: one table per Contract entity, each holding its key columns plus the full entity as `body jsonb`, parsed with the Contract schema on every read and write, as the engine's store does. Uniqueness lives in the database: handles, `(account_id, github_repo_id)`, `(account_id, slug)`, one non-terminal job per project (a partial unique index), one review per revision. Migrations are numbered SQL files applied in order under an advisory lock at start-up; a shipped migration is never edited. — The Contract is the schema; columns exist only for keys and lookups. — Cost if wrong: a column added by a migration. |
| S5 | Transactions | Ruling: every mutating request is one transaction: lock the rows it reads (`SELECT … FOR UPDATE`), call the Contract's `authorize` and transition, write the results, append an `AuditEvent`. A refusal rolls back and is audited in its own short transaction. — Contract §6.4 requires the publish checks "in one transaction"; doing it everywhere removes the question. |
| S6 | Sessions and CSRF | Ruling: a 32-byte random session id in a `__Host-session` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`), stored only as its SHA-256; 30-day sliding expiry; sign-out deletes the row. Every state-changing request needs a same-origin `Origin` header and the session's CSRF token in a form field or `x-csrf-token` header. Local development on `http://127.0.0.1` drops the `__Host-` prefix and `Secure`, and only then. — Standard, and nothing to configure. |
| S7 | GitHub sign-in | Ruling: a GitHub **OAuth app** with no scopes (public data only, Contract §4 D1's "minimum permissions"). The `state` parameter is a random value in a 10-minute signed cookie. The access token is stored encrypted with AES-256-GCM under `TOKEN_KEY` (32 bytes from the environment), with the account id as associated data. Sign-up is open only to logins on `SIGNUP_ALLOWLIST` until specs 3 and 4 land (Contract §1). — An OAuth app with no scope cannot write anything or read anything private; the allowlist keeps the first users known while billing and abuse controls are missing. — Cost if wrong: switching to a GitHub App is a new sign-in route; the rest is unchanged. |
| S8 | Eligibility facts | Ruling: the server builds `EligibilityFacts` from three calls as the user: `GET /repositories/{id}` (visibility, fork, `permissions`, size), and `GET /repos/{owner}/{repo}/commits?author={login}&per_page=1` (the `Link` header's last page is the count, capped at 1,000). A 401 from GitHub is `tokenValid: false`. `permissions` missing is `none`. `indexedFiles` comes from the worker (Contract §7.2). — Three cheap calls; the commit count needs only "at least one". — Cost if wrong: the runbook's first step checks that a no-scope token gets `permissions` on a public repository; if not, the fallback is owner-equals-user only. |
| S9 | Worker | Ruling: one Machine per job attempt, two phases. **Phase 1 (root):** fetch the job spec from the internal API, `git clone --bare --no-tags` the public HTTPS URL under a 5-minute timeout, refusing when GitHub's reported size exceeds 512 MB or the clone does. **Then** install nftables rules that allow only the server's private address, and drop to an unprivileged user. **Phase 2:** run the existing CLIs (`manifest-build.ts`, `wiki-build.ts`, `wiki-people.ts --no-narrative`) against the bare clone with `ANTHROPIC_BASE_URL` set to the proxy and `ANTHROPIC_API_KEY` set to the job token, compute facts (§8), make one suggestions call (§8), and upload the export and generation metadata through the internal API. — This keeps D5's rule (untrusted content is processed only with the network locked) on one Machine instead of two plus a bundle hand-off; the engine already works on bare clones and runs only read-only git (`index/git-options.test.ts`). Reusing the CLIs keeps the hosted layer thin. — Cost if wrong: `git clone` itself parses untrusted pack data while the network is open; a separate fetcher Machine is the fix if that risk is judged too high. |
| S10 | Wikipedia | Ruling: the sandbox cannot reach Wikipedia, so hosted wikis have no Wikipedia links in this release; the engine already degrades a failed lookup to plain text. — Opening the firewall to a public site for a nicety is the wrong trade. — Cost if wrong: a `/wikipedia` passthrough on the proxy later. |
| S11 | LLM proxy | Ruling: `/llm/v1/messages` and the Message Batches routes (`/llm/v1/messages/batches`, `…/{id}`, `…/{id}/cancel`, `…/{id}/results`) pass through to Anthropic. The caller's `x-api-key` is the job token, checked before any body is read; the proxy swaps in the real key, accepts only the request shape the engine sends (text content, structured output, a 5-minute cache breakpoint; no stream, tools, images, 1-hour cache or unlisted beta), refuses any model not in `MODEL_PRICES`, and enforces the job's cap: before forwarding, it **reserves** the request's input counted exactly by Anthropic's free `count_tokens` (the UTF-8 byte count, a true upper bound, if counting fails) at the model's cache-write rate, plus `OUTPUT_RESERVE_SHARE` (0.25) of `max_tokens` at the output rate, halved for batches, and refuses with HTTP 429 and refusal `job-cost-cap` when spent plus open reservations plus this one would pass the cap. When usage arrives (the message response, or a batch's results, read once) it charges the **actual** cost through `recordSpend`, never less; a 2xx reply whose usage cannot be read is charged its reservation; a charge that reaches the cap fails the job with `job-cost-cap` in the same transaction. — Reserving every byte as a token and every `max_tokens` put any real batch past a Free job's $1 cap (the owner's measured builds cost $0.08–0.70; a 70-page batch would reserve over $6), so the input is counted, not bounded. A job's real spend can pass its cap by the unreserved output of its in-flight requests; budgets (month, platform day) always count real spend. The overshoot is bounded: `max_tokens` is at most 16,000 (the engine's largest call), a job has at most 2 batch creates in flight, a batch carries at most 1,000 requests, and token counting runs at most 4 calls at once across all jobs. Each reservation records its uncapped actual cost and when it settled; the job's `spentUsdMicros` stays capped, as the Contract requires. — Cost if wrong: in-flight requests overshoot the cap by at most 75% of their `max_tokens` output; `OUTPUT_RESERVE_SHARE` is the knob (1.0 makes the cap strictly hard again, at the price of refusing batches that would fit), and `jobCapMultiplier` the other. |
| S12 | Object storage | Ruling: an `ObjectStore` seam (`put`, `get`, `head`, `list`, `delete`, `copyPrefix`) with a filesystem implementation (dev, demo, tests) and an S3 implementation signing requests with SigV4 by hand (R2 speaks the S3 API), pinned by AWS's published SigV4 example. — The AWS SDK is large; four signed verbs are about 150 lines. — Cost if wrong: swapping in the SDK behind the same seam. |
| S13 | Preview | Ruling: the server renders a preview for a revision on request: the generation's export with hidden features removed (from `pages`, `history`, and the About article's claims and edges, as the export schema requires), built by the site package's `buildSite` with base `/<handle>/<slug>/wiki/`, plus the portfolio page (§9) as the site's `/<handle>/<slug>/index.html`. The preview hash is SHA-256 over every file's path and SHA-256, sorted. Builds run one at a time in the server. — `buildSite` needs no network and runs no repository code; the export is RepoWiki's own validated data. — Cost if wrong: a large wiki takes tens of seconds and memory; moving renders onto the job runner is the fix. |
| S14 | Public serving | Ruling: the server serves `/<handle>/<slug>/…` and `/<handle>` by resolving the handle (Contract §9), checking `public.read`, and streaming the current version's files from object storage with `Cache-Control: public, max-age=60`; Cloudflare's CDN caches in front. A withdrawn page is a 410 from the next request on, and from caches within 60 seconds. — No purge API and no per-URL invalidation; 60 seconds is within "unpublish clears serving caches" for a resume link. — Cost if wrong: the server being down takes pages down after the CDN copy expires; serving straight from R2 through a Cloudflare Worker is spec 3's hardening. |
| S15 | Usage | Ruling: this spec computes the Contract's `Usage` from the `jobs` and `projects` tables (succeeded counts by UTC month, queued-or-running counts, reserved caps plus actual spend, the platform's day spend). Every account is on the Free plan. The append-only ledger is spec 3's. — The counters the policy needs already live in those tables. |
| S16 | Job runner | Ruling: a `JobRunner` seam (`start(jobId, attempt)`, `stop(jobId)`) with a local implementation that spawns the worker as a child process with a scrubbed environment (development and demo only: no firewall) and a Fly implementation that creates an auto-destroying Machine through the Machines API with the job id, attempt, single-use job token and internal API URL as its only environment. A server-side sweeper calls the Contract's `recoverJob` on expired leases every 30 seconds. — The Contract's `JobRunner` seam (D5). |
| S17 | Configuration | Ruling: every setting is an environment variable, parsed by one zod schema at start-up, and the server refuses to start in production with a missing one. Secrets are never logged; logs are one JSON line per request with method, route pattern, status and duration only. — One place to read what the deployment needs; the runbook lists it. |
| S18 | Demo mode | Ruling: `pnpm hosted:demo` starts the server on `127.0.0.1` with PGlite in memory, the filesystem store under a temporary directory, a built-in fake GitHub (OAuth and the three API calls, serving one fixture user and repository), the local runner, and a worker in fixture mode that skips the clone and the engine and uploads core's test export. — The owner can click through the whole journey before any account exists, and the end-to-end test drives the same mode. |

## 4. Architecture

```
browser ──HTTPS──▶ Cloudflare ──▶ server (Fly) ──▶ Neon Postgres
                                   │   │  └──────▶ R2 (exports, previews, sites)
                                   │   └─ /llm/* ─▶ api.anthropic.com
                                   └─ Machines API ─▶ worker Machine (per job attempt)
worker Machine: phase 1 git clone ◀── github.com ; nftables ; phase 2 engine ──▶ server /internal, /llm
```

`packages/server/src/`:

- `config.ts` — the environment schema (S17).
- `http/` — router, body parsing, security headers, cookies, CSRF, error mapping from `Refused` to `REFUSALS[code].status`.
- `db/` — `Db`, the `pg` and PGlite adapters, `migrations/NNNN-*.sql`, the migration runner.
- `store/` — one module per aggregate (`accounts.ts`, `projects.ts`, `jobs.ts`, `drafts.ts`, `publications.ts`), each exposing transaction functions that call `@repowiki/hosted`.
- `github/` — the OAuth flow, the API client (injected `fetch`), `facts.ts` (S8).
- `crypto.ts` — token encryption, session ids, job tokens.
- `objects/` — `ObjectStore`, `fs-store.ts`, `s3-store.ts` (S12).
- `runner/` — `JobRunner`, `local-runner.ts`, `fly-runner.ts`, `sweeper.ts` (S16).
- `internal/` — the worker API (§6).
- `proxy/` — the LLM proxy (S11).
- `render/` — export filtering, `buildSite` call, the portfolio page, tree hashing (S13).
- `pages/` — server-rendered HTML for every screen (§9), with one escaping helper.
- `fake-github.ts`, `demo.ts` — S18.
- `main.ts` — wiring.

`packages/worker/src/`: `main.ts` (phases), `clone.ts`, `engine.ts` (spawns the CLIs), `people-file.ts`, `facts.ts`, `suggestions.ts`, `api.ts` (internal API client), `fixture.ts` (demo mode). `deploy/worker/entrypoint.sh` installs the firewall between the phases.

## 5. Data model (Postgres)

Every table stores the entity's Contract schema in `body jsonb` beside these key columns:

| Table | Key columns | Constraints |
|---|---|---|
| `accounts` | `id uuid pk`, `github_user_id bigint unique` | |
| `handles` | `handle text pk`, `account_id uuid` | |
| `sessions` | `id_hash text pk`, `account_id uuid`, `csrf text`, `expires_at timestamptz` | |
| `github_tokens` | `account_id uuid pk`, `ciphertext bytea`, `nonce bytea` | |
| `repositories` | `github_repo_id bigint pk` | |
| `projects` | `id uuid pk`, `account_id`, `github_repo_id`, `slug` | unique `(account_id, github_repo_id)`, unique `(account_id, slug)` |
| `jobs` | `id uuid pk`, `project_id`, `status`, `lease_expires_at` | unique `project_id` where status in (`queued`,`running`) |
| `job_tokens` | `token_hash text pk`, `job_id`, `attempt` | |
| `generations` | `id uuid pk`, `project_id` | |
| `revisions` | `(project_id, number) pk` | |
| `reviews` | `(project_id, revision) pk` | |
| `previews` | `(project_id, revision) pk` | |
| `published_versions` | `(project_id, version) pk` | |
| `reservations` | `id uuid pk`, `job_id`, `usd_micros`, `settled boolean` | |
| `audit_events` | `id uuid pk`, `created_at` | append-only |
| `schema_migrations` | `version int pk` | |

## 6. The worker's internal API

All under `/internal/`, authenticated by `Authorization: Bearer <job token>`; a token is valid only for its job and attempt while the job is queued or running, and every token of a job is revoked when it ends or its attempt is recovered. When a job ends, any reservation still open in the proxy is charged as spend in full (S11).

| Route | Purpose |
|---|---|
| `POST /internal/job/lease` | Leases the job (`leaseJob`, idempotent for the same attempt) and returns its spec: clone URL, commit sha, the author's GitHub login and up to 100 of their commit shas (for the people file), plan limits, proxy URL. A POST because it changes the job. |
| `POST /internal/job/heartbeat` | `{ step }`: `heartbeatJob` with the token's attempt. |
| `POST /internal/job/indexed` | `{ indexedFiles }`: refused with `repo-too-large` past the plan's limit, which fails the job before any model call. |
| `PUT /internal/job/export` | The `export.json` bytes (≤ 32 MiB), validated with core's `WikiExport`, stored at `exports/<jobId>-<attempt>.json` (the generation does not exist until success). |
| `POST /internal/job/succeed` | `{ suggestions, facts, engineVersion, models }`: in one transaction, `succeedJob`, the `Generation`, then `firstRevision` or `refreshRevision`. |
| `POST /internal/job/fail` | `{ code }`: `failJob` with a Contract refusal code. |

## 7. Requests and screens

| Screen or route | Policy action | Notes |
|---|---|---|
| `GET /` | — | Landing page; sign-in button. |
| `GET /auth/github`, `GET /auth/github/callback`, `POST /auth/signout` | — | S6–S7. |
| `GET /dashboard` | `repos.list` | The account's eligible repositories (`GET /user/repos?type=all`, public only) and projects. |
| `POST /projects` | `job.create` | Creates the project and its first job; idempotent per Contract §18.4. |
| `GET /projects/:id` | `draft.read`, `job.read` | Job progress, editor, review, preview, publish. |
| `POST /projects/:id/jobs/:job/cancel`, `…/retry`, `POST /projects/:id/refresh` | `job.cancel`, `job.retry`, `job.refresh` | Refresh is refused on Free (Contract §10). |
| `POST /projects/:id/revisions` | `draft.save` | `baseRevision` and the overrides form. |
| `POST /projects/:id/review` | `draft.review` | The attestation checkbox. |
| `POST /projects/:id/preview`, `GET /preview/:id/:rev/…` | `preview.read` | Renders, then serves privately. |
| `POST /projects/:id/publish` | `project.publish` | `revision`, `expectedVersion`, `previewHash`; live facts (S8). |
| `POST /projects/:id/unpublish` | `project.unpublish` | |
| `GET /:handle`, `GET /:handle/:slug/…` | `public.read` | S14; 301 for a redirected handle; 410 when withdrawn. |

## 8. Generation content

- **Indexed files** come from the manifest build (the number of files the engine indexed), reported before any page is written.
- **Languages** are the indexed files' languages by line share, from the index.
- **Feature ids** are the manifest's.
- **Author facts:** the worker writes a people file whose one entry matches `login:<login>` plus `email:` keys for the author emails of the commit shas the job spec lists, so People groups the author's identities; the facts are that person's `commits`, `currentLines` and `features` against the snapshot's totals.
- **Suggestions:** one `generate` call (through the proxy, schema = the Contract's `Suggestions`) given the About article's lead, the feature titles and the author's per-feature counts, with the instruction to describe only what the author's own commits show. The contribution draft is a starting point the author must rewrite or approve (Contract §8).

## 9. The portfolio page

Server-rendered HTML in the site's style sheet, with the seven parts of Contract §8 in order, every author or generated string escaped, the git-history facts rendered from the generation and never from overrides, and section (7)'s wording verbatim.

## 10. Security

- **Untrusted content** (repository files, commit messages, generated text) only reaches HTML through the escaping helper or the site package, which already escapes; generated text is validated by the Contract's `plainText` (no markup).
- **Isolation:** each account's queries filter by the session's account in SQL and again through `authorize`; ids in URLs are never trusted alone (Contract C10).
- **Tokens:** session ids and job tokens are 32 random bytes, stored only as hashes; GitHub tokens are encrypted at rest; the Anthropic key exists only in the server's environment.
- **The worker** holds a single-use job token and nothing else; the proxy binds it to one job, one attempt and that job's cap.
- **Rate limits:** per session, 60 mutating requests a minute; per job token, 10 LLM requests a second. In-memory; spec 3 makes them durable.

## 11. Testing

- **Unit:** every module against fakes: the router and body limits, cookies and CSRF, token crypto, the SigV4 signer against AWS's example, the fake GitHub through the real client, facts from fixture responses, the proxy's reservation arithmetic against a fake Anthropic upstream, export filtering against the export schema, tree hashing.
- **Store:** every transaction against PGlite, including the uniqueness constraints and concurrent publishes.
- **Worker:** the people-file builder and facts on a fixture repository's People snapshot; the phase runner with fake CLIs; the entrypoint's firewall script text.
- **End to end:** `hosted:demo` driven over HTTP: sign in, create, run the fixture worker, save, review, preview, publish, read the public page and profile signed out, unpublish, and read 410.
- **Never** the network or a live model (CLAUDE.md).

## 12. Milestone breakdown (M14)

Each task one PR under ~300 changed lines where the code allows.

1. **M14.1** Spec and ADR-0011.
2. **M14.2** `packages/server` scaffold: config, router, body limits, security headers, error mapping.
3. **M14.3** `Db`, the PGlite and `pg` adapters, migrations and the schema.
4. **M14.4** Account, handle and session store; cookies; CSRF.
5. **M14.5** Token crypto; GitHub OAuth flow and the fake GitHub.
6. **M14.6** GitHub API client and eligibility facts.
7. **M14.7** Object stores (filesystem and S3 SigV4).
8. **M14.8** Project and job store, usage, `POST /projects`, the local runner and the sweeper.
9. **M14.9** The internal worker API and job tokens.
10. **M14.10** The LLM proxy.
11. **M14.11** `packages/worker`: phases, clone, engine CLIs, people file, facts, suggestions; fixture mode.
12. **M14.12** Draft store, editor, review.
13. **M14.13** Preview rendering.
14. **M14.14** Publish, unpublish, public serving and the profile.
15. **M14.15** The Fly runner, Dockerfiles, worker entrypoint and `fly.toml`.
16. **M14.16** `hosted:demo` and the end-to-end test.

## 13. Exit criteria

- `pnpm check` passes; no test touches the network or a live model.
- `pnpm hosted:demo` completes the journey in a browser, and the end-to-end test drives it.
- Every Contract action the server exposes goes through `authorize` inside a transaction.

## 14. Out of scope

Billing, the ledger, daily lifecycle checks, export and account deletion, backups, metrics and durable rate limits (specs 3 and 4); private repositories; Wikipedia links in hosted wikis; a GitHub App.

## 15. Dependencies added

`pg` 8.23.1 and `@types/pg` 8.23.1 (MIT), `@electric-sql/pglite` 0.5.8 (Apache-2.0). Each was reviewed: actively maintained (releases within the last two months), tens of millions of weekly downloads, permissive licences.

## 16. For the owner

1. **One process for the app, worker API and LLM proxy** (S1).
2. **Clone and analyze on one Machine with the firewall between** (S9), rather than a separate fetcher.
3. **No Wikipedia links in hosted wikis** (S10).
4. **Public pages served by the app behind a 60-second CDN cache** (S14), not straight from R2.
5. **Counted reservations in the proxy** (S11): input counted exactly, a quarter of `max_tokens` reserved; in-flight requests can pass the cap by their unreserved output. The knob is `OUTPUT_RESERVE_SHARE`.
6. **Sign-up allowlist** (S7) until billing and abuse controls exist.
