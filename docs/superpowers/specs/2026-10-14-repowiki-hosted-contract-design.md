# RepoWiki hosted — Contract (spec 1 of 4) design spec

- **Date:** 2026-10-14
- **Status:** Accepted. The five product decisions in §3 were made by the owner in conversation on 2026-10-14. Everything after them (§4 onward) was designed on his instruction to finish the work without further questions; §14 lists the calls he is most likely to revisit.
- **Author:** Sean May
- **Features:** F26 hosted project pages (new). ADR-0010 records the product reshape and supersedes ADR-0009's statement of the owner's goal.
- **Builds on:** `main` at b9c110b, the v1 spec `2026-09-30-repowiki-v1-design.md`, and the People spec `2026-10-04-repowiki-v2-people-design.md` (its blame-based facts feed §8's contribution stats). Inputs: the owner's handoff brief of 2026-10-14 and the unfinished prototypes archived on branch `archive/hosted-prototype-2026-10-14` (§12).

## 1. Brief and goals

RepoWiki so far builds a wiki for a repository its owner runs it on, served as static files. The hosted product lets any developer turn one of their public GitHub repositories into a project page they can put on a resume: a short recruiter summary, the author's reviewed contribution, and the full source-cited RepoWiki wiki underneath. A public profile collects an author's published projects.

The work is four specs, each with its own plan and PRs:

1. **Contract** (this spec): the entities, state transitions, authorization rules, URL rules, plan limits and refusal codes, as a pure `packages/hosted` library with no I/O.
2. **Vertical slice:** GitHub sign-in and eligibility, the fetcher and sandboxed analysis job behind `JobRunner`, the LLM proxy, draft editing, review, preview and publish, and public project and profile pages. Sign-up is allowlisted.
3. **Safe operation:** quotas and the cost ledger, the global spend cap, the account-age gate, daily lifecycle checks, export, account deletion, backups, redacted logs and metrics.
4. **Billing:** Stripe Checkout, the Customer Portal, webhooks, and the Pro plan going live. Public sign-up opens only after 3 and 4.

Goals, in priority order:

1. **Honest.** The page says what the project is, how it is built and what the author did, and nothing it cannot back up. Repository ownership is never presented as authorship, and no proficiency, seniority or skill score is inferred.
2. **Explicit.** Nothing becomes public except an exact, author-reviewed, previewed version, published by a deliberate action after a fresh authorization check.
3. **Stable.** A published URL never changes and is never reused by someone else.
4. **Bounded.** Every job has a cost cap and every account a plan limit, fixed before any money is spent.
5. **Testable.** The rules in this spec are pure functions over plain data, so specs 2–4 can enforce them without re-deriving them.

## 2. What the owner gets from this spec

- `packages/hosted`: zod schemas for every entity (§5), the transition functions (§6), the authorization policy (§7), URL and handle rules (§9), plan limits as data (§10), and refusal codes with user-facing messages (§11).
- ADR-0010 and the F26 issue text.
- No server, database, network call or UI. Those are spec 2's.

## 3. Product decisions (settled by the owner, 2026-10-14)

| # | Topic | Ruling |
|---|---|---|
| D1 | Eligibility | Ruling: a user may build a page for a repository that is **public, not a fork**, on which GitHub reports that user has **push access or above**, and which has **at least one commit attributed to their GitHub account**. All four are checked when a job is created and again at publish. Several co-authors may each publish their own page about the same repository. — Ownership and write access are not authorship; the commit requirement stops a team member with write access from claiming a repository they never worked on, and the fork rule stops a copy from passing as the original. — Cost if wrong: contributors without push access (merged PRs to someone else's open-source project) cannot use the product; widening to them later is an additive rule. |
| D2 | Contribution | Ruling: the page shows the author's own **contribution statement** (pre-drafted from their commits, edited and approved by them) **beside git-history facts the author cannot hide**: their current lines and share by blame, their commits and share, and the features they touched, labelled "from git history at `<sha>`". — A reader can check the claim against facts; facts are not a judgement of skill. — Cost if wrong: work that leaves no lines (design, review, pairing) looks small; the statement is where the author explains it. |
| D3 | Pricing and limits | Ruling: **Free**: 1 project, 1 generation per account (lifetime, so withdrawing and recreating a project gives no new one), no refreshes, repositories up to 1,000 indexed files. **Pro ($5/month)**: 10 projects, 10 generations and 30 refreshes a month, up to 3,000 files, and a hard $4.00 monthly model-cost ceiling. A **$25/day** platform-wide spend cap pauses new Free jobs; Free sign-up needs a GitHub account at least **30 days** old. Failed and interrupted jobs use no quota. — Measured full builds cost $0.08–$0.70 for 38–735 files and refreshes $0.05–$0.35 (owner's nine stored builds, Haiku 4.5 via Batches); Stripe takes about $0.45 of $5. — Cost if wrong: numbers are data in `limits.ts` (§10); changing them is a one-line change plus a pricing-page edit. |
| D4 | Lifecycle | Ruling: after a downgrade or cancellation, **published pages stay live and frozen** (no edits, refreshes or republishing; unpublish and export still work). Unpublish returns **410** at the same URL and keeps the slug for that author. A repository made private, deleted or turned into a fork is caught by a daily check and its pages become 410 stubs; the draft is kept **30 days** for a one-click restore, then everything derived from source is purged. Revoked push access blocks edit, refresh and republish but leaves the page live. Account deletion withdraws every page at once and deletes all data within 30 days, backups included. **Handles and slugs are never reassigned.** Export (`export.json` plus a static site zip) is always available. Source clones are deleted when their job ends. — Resume links are the product, so the rules keep links working and never let them be hijacked. — Cost if wrong: a grace period or retention window is a constant. |
| D5 | Hosting and generation | Ruling: **Fly.io** (app and one throwaway Machine per job), **Neon** Postgres, **Cloudflare R2** behind Cloudflare's CDN, all under RepoWiki's own domain. A fetcher makes a bare clone and a `git bundle`; the analysis Machine runs the engine with **no secrets**, behind an nftables firewall set before it drops root, reaching only the LLM proxy and the bundle. The **LLM proxy** holds the Anthropic key, filters secrets from prompts and enforces each job's cost cap. Generation keeps the engine's Haiku 4.5 + Message Batches setup. The code keeps four seams (plain Postgres, the S3 API, a `JobRunner` interface, own-domain URLs) so moving to AWS is a matter of days. — About $0–10/month fixed at launch; AWS with real network isolation was costed at $15–70/month depending on layout. — Cost if wrong: the move to AWS, which the seams keep small. |
| D6 | Content and updates | Ruling: the project page has seven parts (§8). Authors edit only the **portfolio layer** (tagline, summary, contribution statement, highlights, hidden pages), never wiki prose; author overrides survive a refresh, with a notice when the generated text under an override changed. Refresh is **manual only** (Pro). — Wiki claims stay citation-backed, and the hard merge problem of F18 stays deferred. — Cost if wrong: authors wanting to fix a wiki sentence must hide the page or wait for F18. |

## 4. Rulings for the contract

| # | Topic | Ruling |
|---|---|---|
| C1 | Package | Ruling: a new workspace package `packages/hosted` holds this spec's code. It depends on `@repowiki/core` (for `GitSha`, `IsoDateTime`, `contentHash`) and `zod` only: no engine, LLM, site, `node:` modules, clock or randomness. Callers pass `now` and new ids in. A boundary test enforces the imports, as `packages/query` does. — Specs 2–4 add a server, a worker and a proxy that all need the same rules; keeping them pure makes them exhaustively testable and keeps hosting concerns out of `core`, whose schemas are stored wiki bodies with migrations. — Cost if wrong: one package merge later. |
| C2 | Identity keys | Ruling: accounts are keyed by GitHub's numeric user id and repositories by GitHub's numeric repository id. Logins and `owner/name` are cached display values, refreshed on every check. — Both can be renamed or transferred; numeric ids cannot. — Cost if wrong: none known. |
| C3 | Internal ids | Ruling: every RepoWiki entity id is a caller-supplied UUIDv4 string. Authorization never relies on ids being unguessable. — Ids appear in author-only URLs; guessing one still meets the policy (§7). |
| C4 | Immutability | Ruling: `Generation`, `DraftRevision`, `Review` and `PublishedVersion` are immutable once created. Changes create new rows; a project points at its latest revision and its current published version. — Publish, preview and audit all refer to exact versions, so nothing they point to may change underneath them. — Cost if wrong: storage, which is small (§8 overrides are kilobytes; sites are object storage). |
| C5 | Optimistic concurrency | Ruling: every mutation of a draft names the revision number it was made against (`baseRevision`) and every publish names the published version the author saw (`expectedVersion`). A mismatch is refusal `stale-revision` or `stale-publication` (409). — Two tabs or a refresh landing mid-edit must never silently overwrite the author's work or publish something they did not see. |
| C6 | Preview is the publication | Ruling: publishing promotes the **exact rendered site** the author previewed: the publish request carries the preview's content hash, which must equal the stored render of that revision. — "Show the exact public version for review" is only true if the bytes are the same. — Cost if wrong: a render per preview, which is the static build the engine already does. |
| C7 | Live checks | Ruling: actions that spend money or make something public (create a job, refresh, publish, restore) need an eligibility check made **at that moment**. Actions that only change private state (save, review) accept a check at most **1 hour** old. Unpublish, export and account deletion need no check. — The brief requires rechecking authorization at publication; GitHub rate limits make a live call on every keystroke wasteful. — Cost if wrong: an author whose access was revoked can keep editing a private draft for up to an hour, but cannot publish it. |
| C8 | Quota is charged on success | Ruling: a job reserves its cost estimate against the account's monthly ceiling when created, records actual spend as it goes, and counts against the generation or refresh quota **only when it succeeds**. Retries of the same job share one cost cap and one quota charge. — "Failed and interrupted jobs use no quota" (D3) and "retries avoid duplicate charging" (brief). The platform, not the author, absorbs the cost of failures, bounded by the per-job cap. |
| C9 | Frozen | Ruling: a project is **frozen** when the account has more active projects (draft or published) than its plan allows (§10). A frozen project allows only unpublish and export; withdrawing projects until the count fits unfreezes the rest. — This turns D4's downgrade rule into one computed predicate instead of a state that has to be kept in sync. |
| C10 | Not found, not forbidden | Ruling: a request for another account's draft, job, preview or revision is refused as `not-found` (404), identical to a missing id. Public pages answer 410 when withdrawn and 404 when the slug never existed. — Probing must not reveal which private drafts exist. |

## 5. Entities

All timestamps are `IsoDateTime`; all money is integer **micro-dollars** (`usdMicros`) so sums are exact.

| Entity | Fields | Rules |
|---|---|---|
| `Account` | `id`, `githubUserId` (positive int), `login`, `displayName`, `githubCreatedAt`, `plan` (`free` \| `pro`), `status` (`active` \| `deleting`), `createdAt` | One per GitHub user. `deleting` refuses everything except reads of the deletion status. |
| `Handle` | `handle`, `accountId`, `state` (`active` \| `redirect` \| `tombstoned`), `redirectTo` (handle, only when `redirect`), `createdAt` | Exactly one `active` handle per active account. Never deleted (§9). |
| `Repository` | `githubRepoId` (positive int), `fullName`, `visibility` (`public` \| `private`), `isFork`, `defaultBranch`, `checkedAt` | Shared by every project on the same GitHub repository. |
| `Project` | `id`, `accountId`, `githubRepoId`, `slug`, `state` (§6.2), `withdrawReason` (`author` \| `repository` \| `operator` \| `account-deleted`, only when `withdrawn`), `withdrawnAt`, `latestRevision` (int ≥ 0), `currentVersion` (int ≥ 0), `createdAt` | Unique on (`accountId`, `githubRepoId`) and on (`accountId`, `slug`). |
| `Job` | `id`, `projectId`, `kind` (`generate` \| `refresh`), `commitSha` (pinned at creation), `status` (§6.1), `step` (§6.1), `attempt` (1–3), `leaseExpiresAt`, `estimateUsdMicros`, `capUsdMicros`, `spentUsdMicros`, `refusal` (code, §11, only when `failed`), `createdAt`, `startedAt`, `finishedAt` | At most one non-terminal job per project. |
| `Generation` | `id`, `jobId`, `projectId`, `commitSha`, `exportKey`, `exportHash`, `suggestions` (§8), `facts` (§8), `engineVersion`, `models` (ids), `spentUsdMicros`, `createdAt` | Produced only by a succeeded job. |
| `DraftRevision` | `projectId`, `number` (1, 2, …), `generationId`, `overrides` (§8), `flags` (§6.3), `source` (`generation` \| `author`), `createdAt` | `number` is dense and starts at 1. |
| `Review` | `projectId`, `revision`, `attestationVersion`, `createdAt` | At most one per revision. |
| `Preview` | `projectId`, `revision`, `siteKey`, `siteHash`, `createdAt` | The rendered static site for one revision; private. |
| `PublishedVersion` | `projectId`, `version` (1, 2, …), `revision`, `siteKey`, `siteHash`, `authorization` (the `EligibilityFacts` of the publish check, §7.2), `publishedAt` | Dense versions; a project's URL serves `currentVersion`. |
| `LedgerEntry` | `id`, `accountId`, `jobId`, `kind` (`reserve` \| `spend` \| `release` \| `quota`), `usdMicros`, `quota` (`generation` \| `refresh`, only for `quota`), `createdAt` | Append-only. Spec 3 writes it; its sums drive §10. |
| `AuditEvent` | `id`, `actor` (§7.1), `action` (§7.1), `target` (entity and id), `outcome` (`allowed` \| refusal code), `createdAt` | Append-only. Every policy decision on a mutating action is audited. |

## 6. State transitions

Each transition is a pure function `(state, event, context) → { next } | { refusal }`. Anything not listed is refused as `invalid-transition`.

### 6.1 Job

`status`: `queued` → `running` → `succeeded` | `failed` | `cancelled`.

| From | Event | To | Conditions |
|---|---|---|---|
| — | `create` | `queued`, attempt 1 | Policy allows `job.create` or `job.refresh` (§7); no other non-terminal job on the project (else `job-active`). A duplicate create for the same project, kind and commit returns the existing job (idempotent). |
| `queued` | `lease` (worker) | `running`, `leaseExpiresAt = now + lease` | — |
| `running` | `heartbeat` | `running`, lease extended, `step` advanced | `step` only moves forward. |
| `running` | `spend` | `running`, `spentUsdMicros` increased | Refused as `job-cost-cap` when spend would exceed `capUsdMicros`; the worker stops and the job fails with that code. |
| `running` | `succeed` | `succeeded` | A `Generation` is created in the same transaction, then a `DraftRevision` (§6.3), then the quota charge (C8). |
| `running` | `fail` | `failed` | Carries a refusal code (§11). |
| `running` | `lease-expired` (recovery) | `queued`, attempt + 1 | Only when attempt < 3; otherwise `failed` with `job-interrupted`. |
| `failed` | `retry` (author) | `queued`, attempt + 1 | Only if the failure code is retryable (§11) and attempt < 3; spent money stays counted against the same cap. |
| `queued` \| `running` | `cancel` (author) | `cancelled` | A running job's worker stops at its next heartbeat. |

`step` is one of `fetch`, `index`, `cluster`, `manifest`, `write`, `verify`, `people`, `facts`, `render`, in that order. It drives the progress display and nothing else.

### 6.2 Project

`state`: `draft` (never published), `published`, `withdrawn`, `purged`.

| From | Event | To | Conditions |
|---|---|---|---|
| — | `create` | `draft` | Created with its first job. |
| `draft` \| `published` | `publish` | `published`, `currentVersion + 1` | §6.4. |
| `published` | `unpublish` (author) | `withdrawn` (`author`) | Always allowed to the owner, including frozen and access-revoked projects. |
| `draft` \| `published` | `repository-unavailable` (daily check) | `withdrawn` (`repository`) | Repository private, deleted, or now a fork. |
| `draft` \| `published` | `takedown` (operator) | `withdrawn` (`operator`) | Audited with a reason. |
| any but `purged` | `account-deleted` | `withdrawn` (`account-deleted`) | Followed by purge within 30 days. |
| `withdrawn` (`author`) | `publish` | `published` | Same URL; §6.4 applies. |
| `withdrawn` (`repository`) | `restore` (author) | previous state | Within 30 days of `withdrawnAt` and after a live eligibility check; restores `published` only if it had a current version. |
| `withdrawn` (`repository` or `account-deleted`) | `purge` (system) | `purged` | 30 days after `withdrawnAt`. Generations, revisions, previews and sites are deleted; the project row and slug remain as a tombstone. |

Withdrawn by `operator` leaves only through an operator action (`reinstate`), which spec 3 defines.

### 6.3 Draft revisions

- A succeeded `generate` job creates revision 1 with empty overrides.
- A succeeded `refresh` job creates revision `latest + 1` with the new generation and the latest revision's overrides carried forward. It raises flags (below) by comparing the new generation with the generation of the revision it carries forward from.
- An author `save` with `baseRevision = latest` creates revision `latest + 1` with the same generation and the new overrides, and clears all flags; any other `baseRevision` is `stale-revision`.
- Flags: `suggestion-changed:<field>` when an overridden field's generated suggestion changed, `highlight-missing:<featureId>` when a highlighted feature no longer exists, and `hidden-missing:<featureId>` likewise. A revision with flags cannot be reviewed (`needs-review-flags`); the author resolves them by saving.
- A revision is publishable when it is the latest revision, has a review, has no flags, has a non-empty contribution statement, and has a preview.

### 6.4 Publish

`publish(revision, expectedVersion, previewHash)` succeeds only if, in one transaction:

1. policy allows `project.publish` with a live eligibility check (C7);
2. `revision` is publishable (§6.3);
3. `expectedVersion = currentVersion` (C5);
4. `previewHash` equals the stored preview's `siteHash` (C6).

It then creates `PublishedVersion currentVersion + 1` with the eligibility facts as its `authorization`, sets the project `published`, and records an audit event. Publishing the revision that is already current is a no-op returning the current version.

## 7. Authorization

### 7.1 Actors and actions

Actors: `anonymous`, `author` (a signed-in account acting on its own resources), `other` (a signed-in account acting on someone else's), `system` (worker, scheduler) and `operator` (the service owner).

| Action | anonymous | other | author | Extra conditions for the author |
|---|---|---|---|---|
| `public.read` (project page, profile) | yes | yes | yes | Project `published`, account `active`. |
| `repos.list` (eligible repositories) | — | — | yes | — |
| `job.create` (generate) | — | not-found | yes | Live eligibility (§7.2); plan has a project slot and a generation left (lifetime and monthly); size within plan; Free: account age, platform spend not paused. |
| `job.refresh` | — | not-found | yes | Live eligibility; plan allows refreshes and has one left; not frozen. |
| `job.read`, `job.cancel`, `job.retry` | — | not-found | yes | `job.retry`: retryable failure, attempt < 3. |
| `draft.read`, `preview.read` | — | not-found | yes | — |
| `draft.save`, `draft.review` | — | not-found | yes | Eligibility at most 1 hour old; not frozen. |
| `project.publish` | — | not-found | yes | Live eligibility; not frozen; §6.4. |
| `project.unpublish`, `project.export` | — | not-found | yes | None. |
| `project.restore` | — | not-found | yes | Live eligibility; within 30 days. |
| `account.delete` | — | — | yes | None. |
| `project.takedown`, `project.reinstate` | — | — | — | Operator only, audited. |

`system` may lease, heartbeat, spend, succeed, fail and recover jobs, mark repositories unavailable and purge; nothing else.

### 7.2 Eligibility facts

The server gathers these from GitHub as the signed-in user (spec 2 names the calls); the policy only reads them:

```ts
EligibilityFacts = {
  checkedAt, githubUserId, githubRepoId, fullName,
  visibility: "public" | "private", isFork: boolean,
  permission: "admin" | "maintain" | "push" | "triage" | "pull" | "none",
  authoredCommits: number,      // commits attributed to this GitHub account, capped at 1000
  indexedFiles: number | null,  // null until the fetcher has counted the pinned tree
  tokenValid: boolean,          // false when the user revoked the OAuth app
}
```

Eligible means `tokenValid`, `public`, not a fork, permission in {`admin`, `maintain`, `push`} and `authoredCommits ≥ 1`. The first failing condition gives the refusal code (§11), in that order. `indexedFiles` is checked against the plan once known; a job whose pinned tree is too large fails at `fetch` with `repo-too-large` before any model call.

## 8. Content model (the portfolio layer)

A `Generation` carries:

- `suggestions`: `tagline` (≤ 90 characters), `summary` (≤ 900 characters, about 120 words; what the project does, for whom, why it matters), `contributionDraft` (≤ 1,200 characters, written only from the author's own commits), `highlightCandidates` (up to 6 feature ids).
- `facts`: `languages` (name and share of indexed lines), `indexedFiles`, `featureCount`, and `author`: `{ commits, totalCommits, currentLines, totalLines, features: [{ featureId, commits, currentLines }] }` at `commitSha`, taken from the People snapshot for the person whose commits GitHub attributes to the account.

A `DraftRevision` carries `overrides`:

- `tagline?`, `summary?` (absent means "use the suggestion"), `contribution` (required to publish; starts empty, and the editor pre-fills it from `contributionDraft`), `highlights` (0–4 of `{ featureId, blurb ≤ 140 }`), `hiddenFeatureIds`.
- Text fields are plain text: no HTML, at most 3 blank-line-separated paragraphs, no control or invisible characters (the same cleaning as core's titles).

The published page renders, in order: (1) header with title, tagline, repository link pinned to `commitSha`, publish date and "author-reviewed"; (2) summary; (3) at a glance: languages, size and the engine's architecture diagram; (4) contribution statement beside the facts of D2; (5) highlights; (6) the full wiki minus hidden pages; (7) what is checked: "Citations resolve to commit `<sha>` with matching content hashes. Whether the cited code supports each claim is not verified automatically." The facts in (3) and (4) cannot be hidden. Hiding a page removes it from the wiki and its links but never from the facts.

The review attestation (`attestationVersion` 1) reads: "I reviewed this version. The contribution statement describes my own work accurately, and I checked the summary and highlights against the project." It is the author's declaration; the page never presents it as RepoWiki's verification.

## 9. URLs, handles and slugs

- Canonical project URL `https://<domain>/<handle>/<slug>`; profile `https://<domain>/<handle>`. Nothing published links to a provider hostname.
- A handle is the GitHub login lowercased at sign-up, matching `^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$` (GitHub's login rule). If it is taken or reserved, sign-up appends `-2`, `-3`, …, cutting the login so the result stays within 39 characters.
- Reserved handles, never assignable: `about`, `account`, `admin`, `api`, `app`, `assets`, `auth`, `billing`, `blog`, `dashboard`, `docs`, `help`, `login`, `logout`, `new`, `p`, `pricing`, `privacy`, `settings`, `signin`, `signup`, `static`, `status`, `support`, `terms`, `u`, `www`, plus anything starting `_` or `.`.
- When the author's GitHub login changes, they may claim the new login as their handle; the old handle becomes `redirect` and answers 301 forever. Account deletion turns every handle of the account into `tombstoned`, which answers 410 and is never reassigned.
- A slug is the repository name at project creation: lowercased, every run of characters outside `[a-z0-9]` replaced by `-`, trimmed of `-`, cut to 64 characters, `project` if empty, and `-2`, `-3`, … on collision within the handle. It never changes after creation, including on repository rename or transfer.
- A project's slug is reserved for its account for ever, including after unpublish and purge.
- Published sites live at `sites/<projectId>/v<version>/` and are never overwritten; the CDN maps the canonical URL to the current version. Version URLs are not public in this release.

## 10. Plan limits

```ts
PLANS = {
  free: { projects: 1, generationsLifetime: 1, generationsPerMonth: 1,
          refreshesPerMonth: 0, maxIndexedFiles: 1000, monthlyUsdMicros: 1_000_000 },
  pro:  { projects: 10, generationsLifetime: null, generationsPerMonth: 10,
          refreshesPerMonth: 30, maxIndexedFiles: 3000, monthlyUsdMicros: 4_000_000 },
}
PLATFORM = { dailyUsdMicros: 25_000_000, freeAccountMinAgeDays: 30, jobMaxAttempts: 3,
             jobCapMultiplier: 1.5, eligibilityMaxAgeMs: 3_600_000, repositoryGraceDays: 30 }
```

A job's cap is `min(estimate × jobCapMultiplier, monthly ceiling − month's reserved and spent)`; a job whose estimate exceeds the remaining ceiling is refused as `monthly-cost-ceiling` before it starts. Months are calendar months in UTC.

## 11. Refusals

Every refusal has a stable code, an HTTP status, whether a retry can help, and one plain sentence for the author. These are the complete set:

| Code | Status | Retryable | Message |
|---|---|---|---|
| `not-signed-in` | 401 | no | Sign in with GitHub to continue. |
| `not-found` | 404 | no | We couldn't find that. |
| `github-token-revoked` | 401 | no | GitHub access was revoked. Sign in again to continue. |
| `repo-private` | 403 | no | Only public repositories can have a project page. |
| `repo-fork` | 403 | no | Forks can't have a project page. Use the original repository. |
| `repo-no-push` | 403 | no | You need push access to this repository on GitHub. |
| `repo-no-commits` | 403 | no | GitHub shows no commits from your account in this repository. |
| `repo-too-large` | 422 | no | This repository has more files than your plan allows. |
| `plan-project-limit` | 402 | no | Your plan's project limit is reached. Withdraw a project or upgrade. |
| `plan-generation-limit` | 402 | no | You have used this month's generations. |
| `plan-refresh-limit` | 402 | no | You have used this month's refreshes, or your plan has none. |
| `monthly-cost-ceiling` | 402 | no | This job would go over your plan's monthly limit. |
| `account-too-new` | 403 | no | Free accounts need a GitHub account at least 30 days old. |
| `platform-paused` | 503 | yes | New free jobs are paused for today. Try again tomorrow. |
| `job-active` | 409 | no | A job is already running for this project. |
| `job-cost-cap` | 422 | no | This job reached its cost limit and stopped. Nothing was charged to your quota. |
| `job-interrupted` | 500 | no | This job was interrupted too many times. Start a new one. |
| `job-failed` | 500 | yes | Something went wrong while building your draft. Nothing was charged to your quota. |
| `stale-revision` | 409 | no | This draft changed in another tab or by a refresh. Reload to see it. |
| `stale-publication` | 409 | no | A newer version was published. Reload before publishing. |
| `preview-mismatch` | 409 | no | The preview is out of date. Preview again before publishing. |
| `not-reviewed` | 409 | no | Review this version before publishing. |
| `needs-review-flags` | 409 | no | Some generated text under your edits changed. Check the flagged fields and save. |
| `contribution-missing` | 422 | no | Write your contribution statement before review. |
| `frozen` | 402 | no | Your plan no longer covers this project. You can unpublish or export it. |
| `restore-expired` | 410 | no | This project can no longer be restored. |
| `invalid-input` | 400 | no | Some of what you sent isn't valid. (the field and rule follow) |
| `invalid-transition` | 409 | no | That isn't possible right now. Reload to see the current state. |
| `account-deleting` | 410 | no | This account is being deleted. |

## 12. The archived prototypes

The 2026-10-14 working tree held two unfinished prototypes (archived on `archive/hosted-prototype-2026-10-14`, commit `232dd01`). Neither merges. What carries forward:

- From `portfolio-store.ts`: revision numbers checked on every mutation, review bound to one exact revision, and "another draft was published" refusals. These become C5 and §6.3–6.4.
- From `hosted-local.ts`: publish tied to a draft hash. This becomes C6's preview hash.
- From `hosted-server.ts`: strict JSON request bodies (content type, a byte limit counted while streaming, unknown fields refused, generic 500s). Spec 2 adopts them for every endpoint.
- From `portfolio-ui.ts`: the honesty wording ("authorship is declared by the author, not inferred from repository ownership"), which §8's section (7) and attestation keep.

What does not: demo-header identity, JSON-file and local SQLite persistence, fixture generation, author-typed citations (citations come from the engine), and the `/hosted/` Astro pages (the wiki site package stays a static renderer; the hosted UI belongs to spec 2's server).

## 13. Testing

- **Schemas:** each entity accepts a valid example and refuses each rule's violation (`*.test.ts` beside each file).
- **Transitions:** a table-driven test per machine (§6.1–6.3) that runs every (state, event) pair and checks either the listed result or `invalid-transition`. Publish has one test per condition of §6.4, each failing alone.
- **Policy:** a matrix test over actor × action × facts: every row of §7.1, and each eligibility condition of §7.2 failing alone gives its code in the stated order.
- **URLs:** reserved handles, the login regex, slug derivation and collisions, redirect and tombstone behaviour, and that a slug is never derived twice for different projects.
- **Limits:** cap and ceiling arithmetic in micro-dollars, the frozen predicate (C9), month boundaries in UTC.
- **Refusals:** every code in §11 has a message and a status, and no other code exists.
- **Boundary:** `packages/hosted` imports only `@repowiki/core`, `zod` and its own files.

## 14. For the owner

The calls made without you that you are most likely to revisit:

1. **Free monthly ceiling of $1.00** (§10). It covers one generation of a 1,000-file repository with margin; Pro's $4.00 is yours (D3).
2. **Edits allowed on a 1-hour-old eligibility check** (C7). A shorter window means more GitHub calls; publish is always live.
3. **Platform absorbs the cost of failed jobs** (C8), bounded by each job's cap at 1.5× its estimate.
4. **Contribution statement required to publish** (§6.3). A page with only facts and no statement is not publishable.
5. **Version URLs are private** (§9). Public permalinks to old versions are an additive change.
6. **Handles collide with `-2`** (§9) rather than asking the user to choose one at sign-up.

## 15. Milestone breakdown (M13)

Each task is one PR under ~300 changed lines.

1. **M13.1** Spec and ADR-0010 (docs only).
2. **M13.2** `packages/hosted` scaffold with its `CLAUDE.md` layout entry, boundary test, primitives, plan limits (§10) and refusals (§11).
3. **M13.3** Entity schemas (§5) and content model (§8).
4. **M13.4** URL, handle and slug rules (§9).
5. **M13.5** Job transitions (§6.1).
6. **M13.6** Project and draft-revision transitions and publish (§6.2–6.4).
7. **M13.7** Authorization policy and eligibility (§7), with the frozen predicate (C9).

## 16. Exit criteria

- `pnpm check` passes with `packages/hosted` in the workspace.
- Every rule in §§4–11 has a test that fails if the rule is removed.
- `packages/hosted` has no I/O, clock or randomness (boundary test).
- Spec 2 can be written against this package's exports without adding a rule here.

## 17. Out of scope

Servers, storage, GitHub calls, the job runner, the proxy, UI, billing, private repositories, social features, rankings, and skill assessment. Wiki prose editing (F18) stays deferred.
