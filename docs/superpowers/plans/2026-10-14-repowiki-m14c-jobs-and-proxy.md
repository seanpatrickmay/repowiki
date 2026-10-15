# M14c Jobs, Runner, Worker API and LLM Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start a generation from the dashboard, run it on a `JobRunner`, let the worker talk to the server through job-token-authenticated internal routes, and pass its model calls through a proxy that enforces the job's hard cost cap.

**Architecture:** Store functions own transactions and call `@repowiki/hosted` for every decision (S5). Job tokens are single-use secrets bound to (job, attempt), stored hashed. The proxy reserves each request's worst case before forwarding and settles to the real cost from Anthropic's `usage` (S11), and rewrites batch `results_url`s so results come back through it.

**Tech Stack:** TypeScript, zod, `@repowiki/llm` pricing (`priceFor`, `callCostUsd`), `node:child_process` (local runner), vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-repowiki-hosted-slice-design.md` (S8, S11, S15, S16, §6, §7).

## Global Constraints

- `packages/server` gains the runtime dependency `@repowiki/llm` (workspace).
- Every job transition is a Contract call inside a transaction that locks the job row (`FOR UPDATE`).
- A job token authorises only its own job and attempt, only while the job is queued or running.
- Money is integer micro-dollars; the proxy never lets spent plus open reservations pass the job's cap.
- One branch per task, stacked on M14b: `m14/server-jobs`, `m14/server-runner`, `m14/server-internal`, `m14/server-proxy`.

## Review Focus

1. **A worker whose attempt was recovered keeps calling the proxy with its old token**: refused; it cannot spend against the new attempt. Pinned in Task 4.
2. **The same batch's results fetched twice**: spend is settled once. Pinned in Task 4.
3. **A job that ends with a batch still unsettled**: the open reservation is charged as spend, so the platform never under-counts. Pinned in Task 3.
4. **Two "Build" clicks for the same repository**: one project, one job (the second returns the first). Pinned in Task 1.
5. **A queued job whose worker never leased it** (the start failed, the server restarted): the sweeper restarts it, and gives up after three tries. Pinned in Task 2.

## Amendments from the plan review (binding: where they conflict with a task below, they win)

A fresh review of this plan found these defects. Each one needs a failing test first, in the task named.

- **A1 (Task 4, Critical): a strict request shape, so the cap cannot be bypassed.** Read `packages/llm/src/claude.ts` and `batcher.ts` to list exactly what the engine sends. Typically that is `model`, `max_tokens`, `system` (a string or text blocks), `messages` with text content blocks only, `output_config`, `temperature`, `metadata`, and `cache_control: { type: "ephemeral" }` with no `ttl`. Validate `/v1/messages` bodies and each batch request's `params` against a `z.strictObject` of exactly that.
  - Refuse with 400: `stream`, `tools`, `tool_choice`, `mcp_servers`, `container`, `service_tier`, image, document or any other non-text content block, and any `ttl`.
  - Pass `anthropic-beta` through only if every value is in an allowlist of betas the engine sets (an empty allowlist if it sets none).
  - Tests: one refusal each for stream, tools, an image block, a 1-hour TTL, an unknown beta.
- **A2 (Task 4, Critical): count the input exactly, reserve a share of the output, and never charge less than reality.** The plan's worst case (bytes as tokens plus every `max_tokens`) puts any real batch over a Free job's $1 cap. The owner's measured builds cost $0.08–0.70, while a 70-page batch would reserve more than $6.
  - **Input:** count it exactly with Anthropic's free `POST /v1/messages/count_tokens`, using the real key and the same body minus `max_tokens`. For a batch, count each request. If counting fails, fall back to the byte count, which is a true upper bound. Price input at the model's cache-write rate.
  - **Output:** reserve `max_tokens × OUTPUT_RESERVE_SHARE`, a constant set to `0.25` in `proxy/cost.ts`.
  - **Batch discount:** halve the reservation for batches.
  - **Settlement:** charge the actual cost through `recordSpend`, never `min(actual, reserved)`. A 2xx reply whose usage cannot be parsed is charged the reservation. When spend reaches the cap, the same transaction fails the job with `job-cost-cap` (`failJob`, `revokeTokens`).
  - **What the cap now means:** spend can pass it only by the unreserved output share of requests already in flight. Amend spec 2 S11's ruling to say exactly this, and that the share is the knob.
  - Tests:
    - `worstCaseMicros` becomes `reserveMicros(model, inputTokens, maxTokens, batch)`.
    - A fake upstream `count_tokens` is used and its count drives the reservation.
    - Usage above the reservation is charged in full and fails the job.
    - An unparseable 2xx is charged the reservation.
- **A3 (Task 4): a separate body limit for batches.** `/llm/v1/messages/batches` reads up to 64 MiB; `/v1/messages` keeps 8 MiB.
- **A4 (Tasks 3 and 4): authenticate before reading a body.** Resolve and check the job token first, then read the body, so an unauthenticated request never makes the server buffer or parse 32 MiB.
  - The per-token rate limiter keys only on valid tokens, and its map drops entries older than a second on every call.
- **A5 (Tasks 2 and 3, Important): one worker per attempt.**
  - When the sweeper restarts a queued job, `revokeTokens` runs before `issueToken`.
  - Add migration with the next free number (`packages/server/src/db/migrations/0003-job-leases.sql` if M14a's review fixes added 0002): `ALTER TABLE job_tokens ADD COLUMN leased boolean NOT NULL DEFAULT false;`.
  - The lease route marks the token that leases a queued job, and answers 409 to a lease, heartbeat or any other internal call from a different token while the job runs.
  - Tests: two tokens for one attempt, the second refused once the first has leased.
- **A6 (Task 1): GitHub errors on the head commit.** `headSha` returns null on GitHub's 409 (empty repository) and 422 (no such ref). The route answers `invalid-input` ("The repository has no commits on its default branch.") instead of a 500.
- **A7 (Task 3): the worker's spec carries the clone directory name.** `WorkerSpec.repo.name` is used by the worker as the bare clone's directory name, so the wiki is named after the repository and not `repo.git` (see M14d A2). Nothing changes here except a comment saying so.

---

### Task 1: Project and job store, usage, and starting a generation

**Files:**
- Create: `packages/server/src/store/projects.ts`, `packages/server/src/store/jobs.ts`, `packages/server/src/store/start.ts`
- Create: `packages/server/src/store/start.test.ts`
- Modify: `packages/server/src/github/api.ts` (add `headSha`), `packages/server/src/github/fake.ts` (serve it), `packages/server/src/github/api.test.ts`, `packages/server/src/index.ts`

**Interfaces:**
- Consumes: `Db`, `Queryable`, `parsedBody`, `asJson`, `appendAudit`, `GitHubRepo`; from hosted: `Account`, `Project`, `Repository`, `Job`, `Usage`, `EligibilityFacts`, `authorize`, `createJob`, `newProject`, `slugFor`, `jobCap`, `PLANS`, `monthOf`, `Result`, `refused`, `ok`.
- Produces: `projectById(q, id, forUpdate?)`, `projectFor(q, accountId, githubRepoId, forUpdate?)`, `projectsOf(q, accountId)`, `saveProject(q, project)`, `saveRepository(q, repo)`, `usageFor(q, accountId, now)`, `platformDayUsdMicros(q, now)`; `JobSpec` (schema/type), `jobById(q, id, forUpdate?)`, `activeJob(q, projectId, forUpdate?)`, `jobsOf(q, projectId)`, `saveJob(q, job)`, `saveJobSpec(q, jobId, spec)`, `jobSpec(q, jobId)`, `issueToken(q, jobId, attempt, now)`, `tokenJob(q, token)`, `tokensIssued(q, jobId, attempt)`, `revokeTokens(q, jobId)`, `openReservations(q, jobId)`, `settleOpen(q, job)` → job with open reservations charged; `estimateFor(plan)`, `StartInput`, `startGeneration(db, input)`, `startRefresh(db, input)`; `GitHubApi.headSha(token, fullName, branch)`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-jobs
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/server/src/github/api.test.ts`:

```ts
describe("headSha (spec 2 S8)", () => {
  it("reads the commit a branch points at", async () => {
    expect(await api.headSha(FAKE_TOKEN, FAKE_REPO.full_name, "main")).toMatch(/^[0-9a-f]{40}$/);
    expect(await api.headSha(FAKE_TOKEN, FAKE_REPO.full_name, "nope")).toBeNull();
  });
});
```

`packages/server/src/store/start.test.ts`:

```ts
import type { Account, EligibilityFacts } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import { FAKE_REPO, FAKE_USER } from "../github/fake.ts";
import type { GitHubRepo } from "../github/api.ts";
import { signIn } from "./accounts.ts";
import { activeJob, issueToken, jobSpec, revokeTokens, tokenJob, tokensIssued } from "./jobs.ts";
import { projectFor, usageFor } from "./projects.ts";
import { estimateFor, startGeneration, startRefresh, type StartInput } from "./start.ts";
import { freshDb } from "./test-db.ts";

const NOW = "2026-10-14T12:00:00.000Z";
const SHA = "c".repeat(40);
let db: Db;
let account: Account;
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const facts = (patch: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  checkedAt: NOW,
  githubUserId: FAKE_USER.id,
  githubRepoId: FAKE_REPO.id,
  fullName: FAKE_REPO.full_name,
  visibility: "public",
  isFork: false,
  permission: "admin",
  authoredCommits: 42,
  indexedFiles: null,
  tokenValid: true,
  ...patch,
});
const input = (patch: Partial<StartInput> = {}): StartInput => ({
  account,
  facts: facts(),
  repo: FAKE_REPO as GitHubRepo,
  commitSha: SHA,
  commitShas: ["1".repeat(40)],
  now: NOW,
  newId,
  ...patch,
});

beforeEach(async () => {
  db = await freshDb();
  const signed = await signIn(
    db,
    { githubUserId: FAKE_USER.id, login: FAKE_USER.login, displayName: "Demo", githubCreatedAt: "2019-01-01T00:00:00Z" },
    { newAccountId: newId(), allowNew: () => true, now: NOW },
  );
  account = signed?.account as Account;
});
afterEach(async () => db.close());

describe("startGeneration (spec 2 §7, Contract §6.1, §7.1)", () => {
  it("creates the project, its first job and the worker's spec", async () => {
    const started = await startGeneration(db, input());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.created).toBe(true);
    expect(started.value.project).toMatchObject({ slug: "demo-repo", state: "draft", githubRepoId: FAKE_REPO.id });
    expect(started.value.job).toMatchObject({
      kind: "generate",
      status: "queued",
      commitSha: SHA,
      estimateUsdMicros: estimateFor("free"),
      capUsdMicros: 1_000_000,
    });
    expect(await jobSpec(db, started.value.job.id)).toMatchObject({
      repo: { fullName: FAKE_REPO.full_name, cloneUrl: FAKE_REPO.clone_url },
      author: { login: FAKE_USER.login, commitShas: ["1".repeat(40)] },
      plan: "free",
      export: null,
    });
    const audit = await db.query<{ body: { action: string; outcome: string } }>("SELECT body FROM audit_events");
    expect(audit.map((a) => [a.body.action, a.body.outcome])).toEqual([["job.create", "allowed"]]);
  });

  it("returns the running job for a second click instead of a second project", async () => {
    const first = await startGeneration(db, input());
    const second = await startGeneration(db, input());
    expect(second).toMatchObject({ ok: true, value: { created: false } });
    if (first.ok && second.ok) expect(second.value.job.id).toBe(first.value.job.id);
    expect(await db.query("SELECT * FROM projects")).toHaveLength(1);
    expect(await db.query("SELECT * FROM jobs")).toHaveLength(1);
  });

  it("refuses an ineligible repository and audits the refusal", async () => {
    const refused = await startGeneration(db, input({ facts: facts({ isFork: true }) }));
    expect(refused).toEqual({ ok: false, code: "repo-fork" });
    expect(await db.query("SELECT * FROM projects")).toEqual([]);
    const audit = await db.query<{ body: { outcome: string } }>("SELECT body FROM audit_events");
    expect(audit.map((a) => a.body.outcome)).toEqual(["repo-fork"]);
  });

  it("refuses a second project on Free", async () => {
    await startGeneration(db, input());
    const other = { ...FAKE_REPO, id: 777, name: "other", full_name: "demo-dev/other" } as GitHubRepo;
    const refused = await startGeneration(db, input({ repo: other, facts: facts({ githubRepoId: 777 }) }));
    expect(refused).toMatchObject({ ok: false, code: "plan-project-limit" });
  });

  it("counts the reserved cap and the job in flight in usage", async () => {
    await startGeneration(db, input());
    expect(await usageFor(db, account.id, NOW)).toEqual({
      activeProjects: 1,
      generationsLifetime: 0,
      generationsThisMonth: 0,
      refreshesThisMonth: 0,
      inFlightGenerations: 1,
      inFlightRefreshes: 0,
      monthUsdMicros: 1_000_000,
      platformDayUsdMicros: 1_000_000,
    });
  });

  it("refuses a refresh on Free", async () => {
    await startGeneration(db, input());
    const project = await projectFor(db, account.id, FAKE_REPO.id);
    expect(await startRefresh(db, { ...input(), project: project as never })).toMatchObject({
      ok: false,
    });
  });
});

describe("job tokens (spec 2 §6)", () => {
  it("are stored hashed, bound to a job and attempt, and revocable", async () => {
    const started = await startGeneration(db, input());
    if (!started.ok) throw new Error("not started");
    const { job } = started.value;
    const token = await issueToken(db, job.id, job.attempt, NOW);
    expect(await tokenJob(db, token)).toEqual({ jobId: job.id, attempt: 1 });
    expect(await tokenJob(db, "forged")).toBeNull();
    expect(await tokensIssued(db, job.id, 1)).toMatchObject({ count: 1 });
    await revokeTokens(db, job.id);
    expect(await tokenJob(db, token)).toBeNull();
    expect((await activeJob(db, job.project_id ?? job.projectId))?.id).toBe(job.id);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server`
Expected: FAIL — `headSha` missing; cannot resolve `./start.ts`, `./jobs.ts`, `./projects.ts`.

- [ ] **Step 4: Write the implementation**

In `packages/server/src/github/api.ts`, add to `GitHubApi` and to the object `githubApi` returns:

```ts
  /** The commit `branch` points at, or null when the branch does not exist. */
  headSha(token: string, fullName: string, branch: string): Promise<string | null>;
```

```ts
    async headSha(token, fullName, branch) {
      const commit = await parse(
        await get(token, `/repos/${fullName}/commits/${encodeURIComponent(branch)}`),
        z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
        "commit",
      );
      return commit?.sha ?? null;
    },
```

In `packages/server/src/github/fake.ts`, before the final 404, add:

```ts
    if (path === `/repos/${FAKE_REPO.full_name}/commits/main`) return json({ sha: "d".repeat(40) });
```

`packages/server/src/store/projects.ts`:

```ts
import { monthOf, Project, Repository, type Usage } from "@repowiki/hosted";
import type { Queryable } from "../db/db.ts";
import { asJson, parsedBody } from "./rows.ts";

const lock = (forUpdate: boolean) => (forUpdate ? " FOR UPDATE" : "");

export async function projectById(q: Queryable, id: string, forUpdate = false): Promise<Project | null> {
  const rows = await q.query<{ body: unknown }>(`SELECT body FROM projects WHERE id = $1${lock(forUpdate)}`, [id]);
  return rows[0] === undefined ? null : parsedBody(Project, rows[0].body, "project");
}

export async function projectFor(
  q: Queryable,
  accountId: string,
  githubRepoId: number,
  forUpdate = false,
): Promise<Project | null> {
  const rows = await q.query<{ body: unknown }>(
    `SELECT body FROM projects WHERE account_id = $1 AND github_repo_id = $2${lock(forUpdate)}`,
    [accountId, githubRepoId],
  );
  return rows[0] === undefined ? null : parsedBody(Project, rows[0].body, "project");
}

export async function projectsOf(q: Queryable, accountId: string): Promise<Project[]> {
  const rows = await q.query<{ body: unknown }>(
    "SELECT body FROM projects WHERE account_id = $1 ORDER BY body->>'createdAt' DESC",
    [accountId],
  );
  return rows.map((r) => parsedBody(Project, r.body, "project"));
}

export async function saveProject(q: Queryable, project: Project): Promise<void> {
  const body = parsedBody(Project, project, "project");
  await q.query(
    `INSERT INTO projects (id, account_id, github_repo_id, slug, body) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET body = excluded.body`,
    [body.id, body.accountId, body.githubRepoId, body.slug, asJson(body)],
  );
}

export async function saveRepository(q: Queryable, repository: Repository): Promise<void> {
  const body = parsedBody(Repository, repository, "repository");
  await q.query(
    `INSERT INTO repositories (github_repo_id, body) VALUES ($1, $2::jsonb)
     ON CONFLICT (github_repo_id) DO UPDATE SET body = excluded.body`,
    [body.githubRepoId, asJson(body)],
  );
}

const monthStart = (now: string) => `${monthOf(now)}-01T00:00:00.000Z`;
const dayStart = (now: string) => `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;

/** Reserved caps of unfinished jobs plus actual spend of finished ones (Contract C8, §18.6). */
const COST = `CASE WHEN j.status IN ('queued', 'running') THEN (j.body->>'capUsdMicros')::float8
  ELSE (j.body->>'spentUsdMicros')::float8 END`;

/** The Contract's Usage for one account, from the jobs and projects tables (spec 2 S15). */
export async function usageFor(q: Queryable, accountId: string, now: string): Promise<Usage> {
  const rows = await q.query<Record<string, number>>(
    `SELECT
      (SELECT count(*) FROM projects WHERE account_id = $1 AND body->>'state' IN ('draft', 'published'))::int AS active,
      count(*) FILTER (WHERE j.status = 'succeeded' AND j.body->>'kind' = 'generate')::int AS gen_life,
      count(*) FILTER (WHERE j.status = 'succeeded' AND j.body->>'kind' = 'generate' AND (j.body->>'finishedAt')::timestamptz >= $2)::int AS gen_month,
      count(*) FILTER (WHERE j.status = 'succeeded' AND j.body->>'kind' = 'refresh' AND (j.body->>'finishedAt')::timestamptz >= $2)::int AS ref_month,
      count(*) FILTER (WHERE j.status IN ('queued', 'running') AND j.body->>'kind' = 'generate')::int AS gen_flight,
      count(*) FILTER (WHERE j.status IN ('queued', 'running') AND j.body->>'kind' = 'refresh')::int AS ref_flight,
      COALESCE(sum(${COST}) FILTER (WHERE (j.body->>'createdAt')::timestamptz >= $2), 0)::float8 AS month_usd
    FROM projects p LEFT JOIN jobs j ON j.project_id = p.id WHERE p.account_id = $1`,
    [accountId, monthStart(now)],
  );
  const r = rows[0] ?? {};
  return {
    activeProjects: Number(r.active ?? 0),
    generationsLifetime: Number(r.gen_life ?? 0),
    generationsThisMonth: Number(r.gen_month ?? 0),
    refreshesThisMonth: Number(r.ref_month ?? 0),
    inFlightGenerations: Number(r.gen_flight ?? 0),
    inFlightRefreshes: Number(r.ref_flight ?? 0),
    monthUsdMicros: Number(r.month_usd ?? 0),
    platformDayUsdMicros: await platformDayUsdMicros(q, now),
  };
}

export async function platformDayUsdMicros(q: Queryable, now: string): Promise<number> {
  const rows = await q.query<{ usd: number }>(
    `SELECT COALESCE(sum(${COST}), 0)::float8 AS usd FROM jobs j WHERE (j.body->>'createdAt')::timestamptz >= $1`,
    [dayStart(now)],
  );
  return Number(rows[0]?.usd ?? 0);
}
```

(`usageFor`'s `activeProjects` subquery counts projects even when the account has no job; the `LEFT JOIN` keeps a project with no job from dropping the row.)

`packages/server/src/store/jobs.ts`:

```ts
import { GitSha } from "@repowiki/core";
import { Job, Plan, recordSpend, Sha256Hex } from "@repowiki/hosted";
import { z } from "zod";
import { randomToken, sha256Hex } from "../crypto.ts";
import type { Queryable } from "../db/db.ts";
import { asJson, parsedBody } from "./rows.ts";

/** What a worker needs that the Contract's Job does not hold (spec 2 §6). */
export const JobSpec = z.strictObject({
  repo: z.strictObject({
    githubRepoId: z.int().positive(),
    fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    name: z.string().min(1),
    cloneUrl: z.string().regex(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\.git$/),
    sizeKb: z.number().nonnegative(),
  }),
  author: z.strictObject({
    login: z.string().min(1).max(39),
    githubUserId: z.int().positive(),
    commitShas: z.array(GitSha).max(100),
  }),
  plan: Plan,
  export: z.strictObject({ key: z.string().min(1), hash: Sha256Hex }).nullable(),
});
export type JobSpec = z.infer<typeof JobSpec>;

const lock = (forUpdate: boolean) => (forUpdate ? " FOR UPDATE" : "");

export async function jobById(q: Queryable, id: string, forUpdate = false): Promise<Job | null> {
  const rows = await q.query<{ body: unknown }>(`SELECT body FROM jobs WHERE id = $1${lock(forUpdate)}`, [id]);
  return rows[0] === undefined ? null : parsedBody(Job, rows[0].body, "job");
}

export async function activeJob(q: Queryable, projectId: string, forUpdate = false): Promise<Job | null> {
  const rows = await q.query<{ body: unknown }>(
    `SELECT body FROM jobs WHERE project_id = $1 AND status IN ('queued', 'running')${lock(forUpdate)}`,
    [projectId],
  );
  return rows[0] === undefined ? null : parsedBody(Job, rows[0].body, "job");
}

export async function jobsOf(q: Queryable, projectId: string): Promise<Job[]> {
  const rows = await q.query<{ body: unknown }>(
    "SELECT body FROM jobs WHERE project_id = $1 ORDER BY body->>'createdAt' DESC",
    [projectId],
  );
  return rows.map((r) => parsedBody(Job, r.body, "job"));
}

export async function saveJob(q: Queryable, job: Job): Promise<void> {
  const body = parsedBody(Job, job, "job");
  await q.query(
    `INSERT INTO jobs (id, project_id, status, lease_expires_at, body) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET status = excluded.status, lease_expires_at = excluded.lease_expires_at, body = excluded.body`,
    [body.id, body.projectId, body.status, body.leaseExpiresAt, asJson(body)],
  );
}

export async function saveJobSpec(q: Queryable, jobId: string, spec: JobSpec): Promise<void> {
  const body = parsedBody(JobSpec, spec, "job spec");
  await q.query(
    `INSERT INTO job_specs (job_id, body) VALUES ($1, $2::jsonb)
     ON CONFLICT (job_id) DO UPDATE SET body = excluded.body`,
    [jobId, asJson(body)],
  );
}

export async function jobSpec(q: Queryable, jobId: string): Promise<JobSpec | null> {
  const rows = await q.query<{ body: unknown }>("SELECT body FROM job_specs WHERE job_id = $1", [jobId]);
  return rows[0] === undefined ? null : parsedBody(JobSpec, rows[0].body, "job spec");
}

/** A fresh single-use secret for one attempt of one job; only its hash is kept. */
export async function issueToken(q: Queryable, jobId: string, attempt: number, now: string): Promise<string> {
  const token = randomToken();
  await q.query("INSERT INTO job_tokens (token_hash, job_id, attempt, issued_at) VALUES ($1, $2, $3, $4)", [
    sha256Hex(token),
    jobId,
    attempt,
    now,
  ]);
  return token;
}

export async function tokenJob(q: Queryable, token: string): Promise<{ jobId: string; attempt: number } | null> {
  const rows = await q.query<{ job_id: string; attempt: number }>(
    "SELECT job_id, attempt FROM job_tokens WHERE token_hash = $1",
    [sha256Hex(token)],
  );
  const row = rows[0];
  return row === undefined ? null : { jobId: row.job_id, attempt: row.attempt };
}

/** How many tokens an attempt has had and when the last was issued (the sweeper's restart bound). */
export async function tokensIssued(
  q: Queryable,
  jobId: string,
  attempt: number,
): Promise<{ count: number; last: Date | null }> {
  const rows = await q.query<{ count: number; last: Date | null }>(
    "SELECT count(*)::int AS count, max(issued_at) AS last FROM job_tokens WHERE job_id = $1 AND attempt = $2",
    [jobId, attempt],
  );
  return { count: Number(rows[0]?.count ?? 0), last: rows[0]?.last ?? null };
}

export async function revokeTokens(q: Queryable, jobId: string): Promise<void> {
  await q.query("DELETE FROM job_tokens WHERE job_id = $1", [jobId]);
}

export async function openReservations(q: Queryable, jobId: string): Promise<number> {
  const rows = await q.query<{ usd: number }>(
    "SELECT COALESCE(sum(usd_micros), 0)::float8 AS usd FROM reservations WHERE job_id = $1 AND NOT settled",
    [jobId],
  );
  return Number(rows[0]?.usd ?? 0);
}

/**
 * A job about to stop: every open reservation becomes spend at its worst case, because the real
 * cost of a batch whose results were never read is unknown (Contract C8; spec 2 S11).
 */
export async function settleOpen(q: Queryable, job: Job): Promise<Job> {
  const open = await openReservations(q, job.id);
  await q.query("UPDATE reservations SET settled = true WHERE job_id = $1 AND NOT settled", [job.id]);
  if (open === 0 || job.status !== "running") return job;
  const spend = Math.min(Math.ceil(open), job.capUsdMicros - job.spentUsdMicros);
  const spent = recordSpend(job, job.attempt, spend);
  return spent.ok ? spent.value : job;
}
```

`packages/server/src/store/start.ts`:

```ts
import {
  type Account,
  authorize,
  createJob,
  type EligibilityFacts,
  type Job,
  jobCap,
  newProject,
  ok,
  type Plan,
  PLANS,
  type Project,
  type Result,
  refused,
  slugFor,
} from "@repowiki/hosted";
import type { Db, Queryable } from "../db/db.ts";
import type { GitHubRepo } from "../github/api.ts";
import { appendAudit } from "./audit.ts";
import { activeJob, saveJob, saveJobSpec } from "./jobs.ts";
import { projectFor, saveProject, saveRepository, usageFor } from "./projects.ts";

/** Measured cost (owner's nine builds): about $0.09 per 100 indexed files, plus the About article. */
const PER_FILE_MICROS = 900;
const BASE_MICROS = 100_000;

/** A job's estimate before its files are counted: the plan's largest repository (spec 2 S15). */
export function estimateFor(plan: Plan): number {
  return BASE_MICROS + PER_FILE_MICROS * PLANS[plan].maxIndexedFiles;
}

export interface StartInput {
  account: Account;
  /** A live check, made just now (Contract C7). */
  facts: EligibilityFacts;
  repo: GitHubRepo;
  commitSha: string;
  /** Up to 100 of the author's commit shas, for the worker's people file (spec 2 §8). */
  commitShas: string[];
  now: string;
  newId: () => string;
}

type Started = Result<{ project: Project; job: Job; created: boolean }>;

async function audit(tx: Queryable, input: StartInput, action: string, target: string, outcome: string) {
  await appendAudit(tx, {
    id: input.newId(),
    actor: "author",
    action,
    target: { entity: "project", id: target },
    outcome: outcome as never,
    createdAt: input.now,
  });
}

/** A first generation for a repository (Contract §6.1, §7.1, §18.4), in one transaction. */
export async function startGeneration(db: Db, input: StartInput): Promise<Started> {
  return db.transaction(async (tx) => {
    const { account, repo, now } = input;
    await tx.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [account.id]);
    const existing = await projectFor(tx, account.id, repo.id, true);
    const active = existing === null ? null : await activeJob(tx, existing.id, true);
    if (existing && active && active.kind === "generate" && active.commitSha === input.commitSha) {
      return ok({ project: existing, job: active, created: false });
    }
    const usage = await usageFor(tx, account.id, now);
    const estimate = estimateFor(account.plan);
    const verdict = authorize("job.create", {
      now,
      caller: { kind: "account", account },
      ...(existing === null ? {} : { project: existing }),
      githubRepoId: repo.id,
      facts: input.facts,
      usage,
      estimateUsdMicros: estimate,
    });
    if (!verdict.ok) {
      await audit(tx, input, "job.create", existing?.id ?? `repo:${repo.id}`, verdict.code);
      return verdict;
    }
    const slugs = await tx.query<{ slug: string }>("SELECT slug FROM projects WHERE account_id = $1", [account.id]);
    const taken = new Set(slugs.map((s) => s.slug));
    const project =
      existing ??
      newProject({ id: input.newId(), accountId: account.id, githubRepoId: repo.id, slug: slugFor(repo.name, (s) => taken.has(s)), now });
    const cap = jobCap(estimate, PLANS[account.plan].monthlyUsdMicros - usage.monthUsdMicros);
    if (!cap.ok) return cap;
    const job = createJob(
      { id: input.newId(), projectId: project.id, kind: "generate", commitSha: input.commitSha, estimateUsdMicros: estimate, capUsdMicros: cap.value, now },
      active,
    );
    if (!job.ok) return job;
    await saveRepository(tx, {
      githubRepoId: repo.id,
      fullName: repo.full_name,
      visibility: repo.private ? "private" : "public",
      isFork: repo.fork,
      defaultBranch: repo.default_branch,
      checkedAt: now,
    });
    await saveProject(tx, project);
    await saveJob(tx, job.value.job);
    await saveJobSpec(tx, job.value.job.id, {
      repo: { githubRepoId: repo.id, fullName: repo.full_name, name: repo.name, cloneUrl: repo.clone_url, sizeKb: repo.size },
      author: { login: account.login, githubUserId: account.githubUserId, commitShas: input.commitShas },
      plan: account.plan,
      export: null,
    });
    await audit(tx, input, "job.create", project.id, "allowed");
    return ok({ project, job: job.value.job, created: true });
  });
}

/** A refresh of an existing project (Contract §6.1, §7.1); refused on Free. */
export async function startRefresh(db: Db, input: StartInput & { project: Project }): Promise<Started> {
  return db.transaction(async (tx) => {
    const { account, now } = input;
    await tx.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [account.id]);
    const project = (await projectFor(tx, account.id, input.project.githubRepoId, true)) ?? input.project;
    const active = await activeJob(tx, project.id, true);
    if (active && active.kind === "refresh" && active.commitSha === input.commitSha) {
      return ok({ project, job: active, created: false });
    }
    const usage = await usageFor(tx, account.id, now);
    const estimate = estimateFor(account.plan);
    const verdict = authorize("job.refresh", {
      now,
      caller: { kind: "account", account },
      project,
      facts: input.facts,
      usage,
      estimateUsdMicros: estimate,
    });
    if (!verdict.ok) {
      await audit(tx, input, "job.refresh", project.id, verdict.code);
      return verdict;
    }
    const cap = jobCap(estimate, PLANS[account.plan].monthlyUsdMicros - usage.monthUsdMicros);
    if (!cap.ok) return cap;
    const job = createJob(
      { id: input.newId(), projectId: project.id, kind: "refresh", commitSha: input.commitSha, estimateUsdMicros: estimate, capUsdMicros: cap.value, now },
      active,
    );
    if (!job.ok) return job;
    await saveJob(tx, job.value.job);
    const { repo } = input;
    await saveJobSpec(tx, job.value.job.id, {
      repo: { githubRepoId: repo.id, fullName: repo.full_name, name: repo.name, cloneUrl: repo.clone_url, sizeKb: repo.size },
      author: { login: account.login, githubUserId: account.githubUserId, commitShas: input.commitShas },
      plan: account.plan,
      export: null,
    });
    await audit(tx, input, "job.refresh", project.id, "allowed");
    return ok({ project, job: job.value.job, created: true });
  });
}

export { refused };
```

(Drop the trailing `export { refused }` if lint flags it as unused; it is there only so the import is used.)

In the test, replace `job.project_id ?? job.projectId` with `job.projectId`.

Add to `packages/server/src/index.ts`:

```ts
export {
  activeJob,
  issueToken,
  JobSpec,
  jobById,
  jobSpec,
  jobsOf,
  openReservations,
  revokeTokens,
  saveJob,
  saveJobSpec,
  settleOpen,
  tokenJob,
  tokensIssued,
} from "./store/jobs.ts";
export {
  platformDayUsdMicros,
  projectById,
  projectFor,
  projectsOf,
  saveProject,
  saveRepository,
  usageFor,
} from "./store/projects.ts";
export { estimateFor, type StartInput, startGeneration, startRefresh } from "./store/start.ts";
```

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server
pnpm check
git add packages/server
git -c user.email=sean.may101@gmail.com commit -m "feat(server): start generations under the Contract's policy, with usage from the job table"
```

---

### Task 2: The job runner, the sweeper, the dashboard and `POST /projects`

**Files:**
- Create: `packages/server/src/runner/runner.ts`, `packages/server/src/runner/local-runner.ts`, `packages/server/src/runner/sweeper.ts`, `packages/server/src/runner/sweeper.test.ts`
- Create: `packages/server/src/pages/refusal.ts`, `packages/server/src/routes/projects.ts`, `packages/server/src/routes/projects.test.ts`
- Modify: `packages/server/src/app.ts` (`Deps` gains `runner: JobRunner`), `packages/server/src/routes/test-app.ts` (a recording runner; a signed-in helper), `packages/server/src/index.ts`

**Interfaces:**
- Consumes: Task 1; M14b's `githubApi`, `eligibilityFacts`, `readGitHubToken`, `currentSession`, `checkMutation`, `page`, `escapeHtml`; hosted `leaseJob`, `failJob`, `recoverJob`, `REFUSALS`.
- Produces: `JobRunner` (`start({ jobId, attempt, token }): Promise<void>`), `recordingRunner()` (test-only, in `runner/runner.ts`: `{ runner, started }`), `localRunner({ workerEntry, internalUrl, mode, log })`, `sweep(deps)` → `{ recovered, restarted, abandoned }`, `startSweeper(deps, intervalMs)` → stop function; `refusalPage(code, session)`; `projectRoutes(deps)` (`GET /dashboard`, `POST /projects`); test helpers `signedInCookie(deps)` → `{ cookie, csrf, accountId }`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-runner
```

- [ ] **Step 2: Write the failing tests**

Extend `packages/server/src/routes/test-app.ts`:

```ts
import { recordingRunner } from "../runner/runner.ts";
import { signIn } from "../store/accounts.ts";
import { saveGitHubToken } from "../store/github-tokens.ts";
import { createSession } from "../store/sessions.ts";
import { FAKE_TOKEN, FAKE_USER } from "../github/fake.ts";
```

In `testDeps`, add `runner: recordingRunner().runner` to the defaults (tests that inspect starts pass their own), and add:

```ts
/** Test-only: the fake GitHub user signed in, with their token stored; a cookie and CSRF token. */
export async function signedInCookie(deps: Deps): Promise<{ cookie: string; csrf: string; accountId: string }> {
  const signed = await signIn(
    deps.db,
    { githubUserId: FAKE_USER.id, login: FAKE_USER.login, displayName: FAKE_USER.name, githubCreatedAt: FAKE_USER.created_at },
    { newAccountId: deps.newId(), allowNew: () => true, now: deps.now() },
  );
  if (signed === null) throw new Error("sign-in refused");
  await deps.db.transaction((tx) => saveGitHubToken(tx, deps.config.tokenKey, signed.account.id, FAKE_TOKEN));
  const session = await createSession(deps.db, signed.account.id, deps.now());
  return { cookie: `session=${session.token}`, csrf: session.csrf, accountId: signed.account.id };
}

export function form(cookie: string, origin: string): Record<string, string> {
  return { cookie, origin, "content-type": "application/x-www-form-urlencoded" };
}
```

`packages/server/src/routes/projects.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { FAKE_REPO } from "../github/fake.ts";
import type { App } from "../http/server.ts";
import { recordingRunner } from "../runner/runner.ts";
import { tokenJob } from "../store/jobs.ts";
import { projectRoutes } from "./projects.ts";
import { call, form, signedInCookie, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let started: { jobId: string; attempt: number; token: string }[];

beforeEach(async () => {
  const recording = recordingRunner();
  started = recording.started;
  deps = await testDeps({ runner: recording.runner });
  app = createApp(deps, projectRoutes(deps));
});
afterEach(async () => deps.db.close());

describe("the dashboard (spec 2 §7)", () => {
  it("sends a signed-out visitor to sign in", async () => {
    const reply = await call(app, { path: "/dashboard" });
    expect(reply.status).toBe(303);
    expect(reply.headers?.location).toBe("/auth/github");
  });

  it("lists the user's public repositories with a build button", async () => {
    const { cookie } = await signedInCookie(deps);
    const reply = await call(app, { path: "/dashboard", headers: { cookie } });
    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain(FAKE_REPO.full_name);
    expect(String(reply.body)).toContain(`name="githubRepoId" value="${FAKE_REPO.id}"`);
  });
});

describe("POST /projects (spec 2 §7)", () => {
  it("starts a generation, issues a job token and starts the runner", async () => {
    const { cookie, csrf } = await signedInCookie(deps);
    const reply = await call(app, {
      method: "POST",
      path: "/projects",
      headers: form(cookie, deps.config.origin),
      body: `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`,
    });
    expect(reply.status).toBe(303);
    expect(String(reply.headers?.location)).toMatch(/^\/projects\/[0-9a-f-]{36}$/);
    expect(started).toHaveLength(1);
    expect(await tokenJob(deps.db, started[0]?.token ?? "")).toMatchObject({ attempt: 1 });
  });

  it("does not start a second runner for a second click", async () => {
    const { cookie, csrf } = await signedInCookie(deps);
    const post = () =>
      call(app, {
        method: "POST",
        path: "/projects",
        headers: form(cookie, deps.config.origin),
        body: `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`,
      });
    const first = await post();
    const second = await post();
    expect(second.headers?.location).toBe(first.headers?.location);
    expect(started).toHaveLength(1);
  });

  it("shows the Contract's refusal for a repository GitHub does not show the user", async () => {
    const { cookie, csrf } = await signedInCookie(deps);
    const reply = await call(app, {
      method: "POST",
      path: "/projects",
      headers: form(cookie, deps.config.origin),
      body: `csrf=${csrf}&githubRepoId=1`,
    });
    expect(reply.status).toBe(403);
    expect(String(reply.body)).toContain("Only public repositories can have a project page.");
    expect(started).toEqual([]);
  });

  it("refuses a missing CSRF token", async () => {
    const { cookie } = await signedInCookie(deps);
    const reply = await call(app, {
      method: "POST",
      path: "/projects",
      headers: form(cookie, deps.config.origin),
      body: `githubRepoId=${FAKE_REPO.id}`,
    });
    expect(reply.status).toBe(403);
  });
});
```

`packages/server/src/runner/sweeper.test.ts`:

```ts
import { leaseJob } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../app.ts";
import { FAKE_REPO } from "../github/fake.ts";
import { call, form, signedInCookie, testDeps } from "../routes/test-app.ts";
import { createApp } from "../app.ts";
import { projectRoutes } from "../routes/projects.ts";
import { jobById, saveJob } from "../store/jobs.ts";
import { recordingRunner } from "./runner.ts";
import { sweep } from "./sweeper.ts";

let deps: Deps;
let started: { jobId: string; attempt: number; token: string }[];
let clock = "2026-10-14T12:00:00.000Z";

beforeEach(async () => {
  const recording = recordingRunner();
  started = recording.started;
  clock = "2026-10-14T12:00:00.000Z";
  deps = await testDeps({ runner: recording.runner, now: () => clock });
  const { cookie, csrf } = await signedInCookie(deps);
  await call(createApp(deps, projectRoutes(deps)), {
    method: "POST",
    path: "/projects",
    headers: form(cookie, deps.config.origin),
    body: `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`,
  });
});
afterEach(async () => deps.db.close());

const theJob = async () => jobById(deps.db, started[0]?.jobId ?? "");

describe("the sweeper (spec 2 S16)", () => {
  it("leaves a fresh queued job and a live lease alone", async () => {
    expect(await sweep(deps)).toEqual({ recovered: 0, restarted: 0, abandoned: 0 });
  });

  it("restarts a queued job nobody leased, then gives up after three tokens", async () => {
    clock = "2026-10-14T12:06:00.000Z";
    expect(await sweep(deps)).toMatchObject({ restarted: 1 });
    expect(started).toHaveLength(2);
    clock = "2026-10-14T12:12:00.000Z";
    await sweep(deps);
    clock = "2026-10-14T12:18:00.000Z";
    expect(await sweep(deps)).toMatchObject({ abandoned: 1 });
    expect(await theJob()).toMatchObject({ status: "failed", refusal: "job-interrupted" });
  });

  it("recovers an expired lease onto a new attempt with a new token", async () => {
    const job = await theJob();
    const leased = leaseJob(job as never, clock, 60_000);
    if (!leased.ok) throw new Error("lease");
    await saveJob(deps.db, leased.value);
    clock = "2026-10-14T12:05:00.000Z";
    expect(await sweep(deps)).toMatchObject({ recovered: 1 });
    expect(await theJob()).toMatchObject({ status: "queued", attempt: 2 });
    expect(started.at(-1)).toMatchObject({ attempt: 2 });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server`
Expected: FAIL — cannot resolve `../runner/runner.ts`, `./projects.ts`, `./sweeper.ts`.

- [ ] **Step 4: Write the implementation**

`packages/server/src/runner/runner.ts`:

```ts
/** Starts one attempt of a job somewhere isolated (spec 2 S16). */
export interface JobRunner {
  start(input: { jobId: string; attempt: number; token: string }): Promise<void>;
}

/** Test-only: a runner that records what it was asked to start. */
export function recordingRunner(): {
  runner: JobRunner;
  started: { jobId: string; attempt: number; token: string }[];
} {
  const started: { jobId: string; attempt: number; token: string }[] = [];
  return {
    runner: {
      start: async (input) => {
        started.push(input);
      },
    },
    started,
  };
}
```

`packages/server/src/runner/local-runner.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRunner } from "./runner.ts";

/**
 * The worker as a child process with a scrubbed environment: development and the demo only. It
 * has no firewall; production uses the Fly runner (spec 2 S16).
 */
export function localRunner(options: {
  workerEntry: string;
  internalUrl: string;
  mode: "fixture" | "engine";
  log: (line: object) => void;
}): JobRunner {
  return {
    async start({ jobId, attempt, token }) {
      const home = mkdtempSync(join(tmpdir(), "repowiki-worker-"));
      const child = spawn(process.execPath, [options.workerEntry], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          REPOWIKI_API_URL: options.internalUrl,
          REPOWIKI_JOB_TOKEN: token,
          REPOWIKI_WORKER_MODE: options.mode,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-2000);
      });
      child.on("exit", (code) => options.log({ worker: jobId, attempt, exit: code, ...(code === 0 ? {} : { stderr }) }));
    },
  };
}
```

`packages/server/src/runner/sweeper.ts`:

```ts
import { failJob, leaseJob, recoverJob } from "@repowiki/hosted";
import type { Db } from "../db/db.ts";
import { issueToken, jobById, revokeTokens, saveJob, settleOpen, tokensIssued } from "../store/jobs.ts";
import type { JobRunner } from "./runner.ts";

/** A queued job whose worker has not leased it this long after its token was issued is restarted. */
export const RESTART_AFTER_MS = 5 * 60_000;
export const MAX_STARTS_PER_ATTEMPT = 3;
const LEASE_MS = 120_000;

export interface SweepDeps {
  db: Db;
  runner: JobRunner;
  now: () => string;
}

/** One pass: recover expired leases, restart stuck queued jobs, abandon hopeless ones (S16). */
export async function sweep(deps: SweepDeps): Promise<{ recovered: number; restarted: number; abandoned: number }> {
  const now = deps.now();
  let recovered = 0;
  let restarted = 0;
  let abandoned = 0;
  const toStart: { jobId: string; attempt: number; token: string }[] = [];

  const expired = await deps.db.query<{ id: string }>(
    "SELECT id FROM jobs WHERE status = 'running' AND lease_expires_at < $1",
    [now],
  );
  for (const { id } of expired) {
    await deps.db.transaction(async (tx) => {
      const job = await jobById(tx, id, true);
      if (job === null || job.status !== "running") return;
      const settled = await settleOpen(tx, job);
      const next = recoverJob(settled, now);
      if (!next.ok) return;
      await saveJob(tx, next.value);
      await revokeTokens(tx, id);
      recovered++;
      if (next.value.status === "queued") {
        toStart.push({ jobId: id, attempt: next.value.attempt, token: await issueToken(tx, id, next.value.attempt, now) });
      }
    });
  }

  const queued = await deps.db.query<{ id: string }>("SELECT id FROM jobs WHERE status = 'queued'");
  for (const { id } of queued) {
    await deps.db.transaction(async (tx) => {
      const job = await jobById(tx, id, true);
      if (job === null || job.status !== "queued") return;
      const issued = await tokensIssued(tx, id, job.attempt);
      if (issued.last !== null && Date.parse(now) - issued.last.getTime() < RESTART_AFTER_MS) return;
      if (issued.count >= MAX_STARTS_PER_ATTEMPT) {
        const leased = leaseJob(job, now, LEASE_MS);
        const failed = leased.ok ? failJob(leased.value, job.attempt, "job-interrupted", now) : leased;
        if (failed.ok) {
          await saveJob(tx, failed.value);
          await revokeTokens(tx, id);
          abandoned++;
        }
        return;
      }
      toStart.push({ jobId: id, attempt: job.attempt, token: await issueToken(tx, id, job.attempt, now) });
      restarted++;
    });
  }

  for (const start of toStart) await deps.runner.start(start);
  return { recovered, restarted, abandoned };
}

/** Sweep every `intervalMs` until the returned function is called. */
export function startSweeper(deps: SweepDeps, intervalMs = 30_000, log: (line: object) => void = () => {}): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweep(deps)
      .then((result) => {
        if (result.recovered + result.restarted + result.abandoned > 0) log({ sweep: result });
      })
      .catch((error: unknown) => log({ sweep: "failed", error: error instanceof Error ? error.name : "unknown" }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
```

`packages/server/src/pages/refusal.ts`:

```ts
import { type RefusalCode, REFUSALS } from "@repowiki/hosted";
import { html } from "../http/server.ts";
import type { Reply } from "../http/router.ts";
import { escapeHtml, page, type PageSession } from "./layout.ts";

/** A Contract refusal as a page with its status and plain sentence (Contract §11). */
export function refusalPage(code: RefusalCode, session: PageSession | null, back = "/dashboard"): Reply {
  const info = REFUSALS[code];
  return html(
    info.status,
    page({
      title: "Not possible",
      body: `<h1>That didn't work</h1><p>${escapeHtml(info.message)}</p><p><a href="${escapeHtml(back)}">Back</a></p>`,
      session,
    }),
  );
}
```

`packages/server/src/routes/projects.ts`:

```ts
import type { Deps } from "../app.ts";
import { githubApi, TokenRevoked } from "../github/api.ts";
import { eligibilityFacts } from "../github/facts.ts";
import { readForm } from "../http/body.ts";
import type { Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { checkMutation, currentSession, type Session } from "../http/session.ts";
import { escapeHtml, page } from "../pages/layout.ts";
import { refusalPage } from "../pages/refusal.ts";
import { readGitHubToken } from "../store/github-tokens.ts";
import { issueToken } from "../store/jobs.ts";
import { projectsOf } from "../store/projects.ts";
import { startGeneration } from "../store/start.ts";

const pageSession = (s: Session) => ({ csrf: s.csrf, login: s.account.login });

/** The dashboard and starting a project (spec 2 §7). */
export function projectRoutes(deps: Deps): Route[] {
  const api = githubApi(deps.fetch, deps.github);

  return [
    {
      method: "GET",
      pattern: "/dashboard",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request.headers, deps.now());
        if (session === null) return redirect("/auth/github");
        const token = await readGitHubToken(deps.db, deps.config.tokenKey, session.account.id);
        if (token === null) return redirect("/auth/github");
        let repos: Awaited<ReturnType<typeof api.publicRepos>> = [];
        try {
          repos = (await api.publicRepos(token)).filter((r) => !r.fork);
        } catch (error) {
          if (error instanceof TokenRevoked) return redirect("/auth/github");
          throw error;
        }
        const projects = await projectsOf(deps.db, session.account.id);
        const mine = projects
          .map((p) => `<li><a href="/projects/${p.id}">${escapeHtml(p.slug)}</a> <span class="muted">${p.state}</span></li>`)
          .join("");
        const choices = repos
          .map(
            (r) => `<li class="card"><strong>${escapeHtml(r.full_name)}</strong><p class="muted">${escapeHtml(r.description ?? "")}</p>
<form method="post" action="/projects"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><input type="hidden" name="githubRepoId" value="${r.id}"><button>Build project page</button></form></li>`,
          )
          .join("");
        return html(
          200,
          page({
            title: "Dashboard",
            body: `<h1>Your projects</h1>${mine ? `<ul>${mine}</ul>` : `<p class="muted">No projects yet.</p>`}
<h2>Your public repositories</h2><p class="muted">RepoWiki builds a page for a public repository you can push to and have commits in.</p><ul style="list-style:none;padding:0">${choices || "<li>No public repositories found.</li>"}</ul>`,
            session: pageSession(session),
          }),
        );
      },
    },
    {
      method: "POST",
      pattern: "/projects",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request.headers, deps.now());
        const body = await readForm(request.raw);
        checkMutation(deps.config, request.headers, session, body.get("csrf"));
        const githubRepoId = Number(body.get("githubRepoId"));
        if (!Number.isInteger(githubRepoId) || githubRepoId < 1) return refusalPage("invalid-input", pageSession(session));
        const token = await readGitHubToken(deps.db, deps.config.tokenKey, session.account.id);
        if (token === null) return redirect("/auth/github");
        const now = deps.now();
        const { account } = session;
        const { facts, repo } = await eligibilityFacts(api, token, {
          githubUserId: account.githubUserId,
          login: account.login,
          githubRepoId,
          now,
          indexedFiles: null,
        });
        if (repo === null) {
          return refusalPage(facts.tokenValid ? "repo-private" : "github-token-revoked", pageSession(session));
        }
        const commitSha = await api.headSha(token, repo.full_name, repo.default_branch);
        if (commitSha === null) return refusalPage("invalid-input", pageSession(session));
        const commitShas = await api.commitShas(token, repo.full_name, account.login, 100);
        const started = await startGeneration(deps.db, { account, facts, repo, commitSha, commitShas, now, newId: deps.newId });
        if (!started.ok) return refusalPage(started.code, pageSession(session));
        const { project, job, created } = started.value;
        if (created) {
          const jobToken = await issueToken(deps.db, job.id, job.attempt, now);
          await deps.runner.start({ jobId: job.id, attempt: job.attempt, token: jobToken });
        }
        return redirect(`/projects/${project.id}`);
      },
    },
  ];
}
```

In `packages/server/src/app.ts`, add to `Deps`:

```ts
  runner: JobRunner;
```

(with `import type { JobRunner } from "./runner/runner.ts";`).

Add to `packages/server/src/index.ts`:

```ts
export { refusalPage } from "./pages/refusal.ts";
export { projectRoutes } from "./routes/projects.ts";
export { localRunner } from "./runner/local-runner.ts";
export { type JobRunner, recordingRunner } from "./runner/runner.ts";
export { MAX_STARTS_PER_ATTEMPT, RESTART_AFTER_MS, startSweeper, sweep, type SweepDeps } from "./runner/sweeper.ts";
```

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server
pnpm check
git add packages/server
git -c user.email=sean.may101@gmail.com commit -m "feat(server): start jobs on a runner, sweep stuck ones, and list repositories on the dashboard"
```

---

### Task 3: The worker's internal API

**Files:**
- Create: `packages/server/src/store/drafts.ts` (revision and generation rows), `packages/server/src/routes/internal.ts`, `packages/server/src/routes/internal.test.ts`
- Modify: `packages/site/package.json` (`exports`), `packages/server/package.json` (`@repowiki/site`), `packages/server/src/app.ts` (`Deps` gains `objects: ObjectStore`), `packages/server/src/routes/test-app.ts` (fs objects under a temp dir; `startedJob(deps)` helper), `packages/server/src/index.ts`

**Interfaces:**
- Consumes: Tasks 1–2; `ObjectStore` (M14b T4); core `WikiExport`; hosted `leaseJob`, `heartbeatJob`, `succeedJob`, `failJob`, `firstRevision`, `refreshRevision`, `Generation`, `DraftRevision`, `Suggestions`, `Facts`, `JobStep`, `PLANS`.
- Produces: `generationById(q, id)`, `saveGeneration(q, g)`, `latestRevision(q, projectId)`, `saveRevision(q, r)`; `WorkerSpec` (the lease reply), `internalRoutes(deps)`; `EXPORT_LIMIT` (32 MiB); test helper `startedJob(deps)` → `{ jobId, token, projectId }`.

Routes (all `Authorization: Bearer <job token>`; 401 otherwise):

| Route | Body | Reply |
|---|---|---|
| `POST /internal/job/lease` | — | 200 `WorkerSpec`; idempotent for the same attempt |
| `POST /internal/job/heartbeat` | `{ step }` | 204 |
| `POST /internal/job/indexed` | `{ indexedFiles }` | 204, or 422 `{ code: "repo-too-large" }` after failing the job |
| `PUT /internal/job/export` | `export.json` (≤ 32 MiB) | 204 |
| `POST /internal/job/succeed` | `{ suggestions, facts, engineVersion, models }` | 204 |
| `POST /internal/job/fail` | `{ code }` (`job-failed`, `job-cost-cap` or `repo-too-large`) | 204 |

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-internal
```

- [ ] **Step 2: Write the failing tests**

Add to `packages/server/src/routes/test-app.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsObjectStore } from "../objects/fs-store.ts";
import { projectRoutes } from "./projects.ts";
import { createApp } from "../app.ts";
import { FAKE_REPO } from "../github/fake.ts";
```

In `testDeps` defaults add `objects: fsObjectStore(mkdtempSync(join(tmpdir(), "objects-")))`, and:

```ts
/** Test-only: a signed-in user who started a generation; the job's first token. */
export async function startedJob(deps: Deps): Promise<{ jobId: string; token: string; projectId: string }> {
  const recording = recordingRunner();
  const local = { ...deps, runner: recording.runner };
  const { cookie, csrf } = await signedInCookie(local);
  const reply = await call(createApp(local, projectRoutes(local)), {
    method: "POST",
    path: "/projects",
    headers: form(cookie, deps.config.origin),
    body: `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`,
  });
  const projectId = String(reply.headers?.location).split("/").at(-1) ?? "";
  const start = recording.started[0];
  if (start === undefined) throw new Error("no job started");
  return { jobId: start.jobId, token: start.token, projectId };
}
```

`packages/server/src/routes/internal.test.ts`:

```ts
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { generationById, latestRevision } from "../store/drafts.ts";
import { jobById, jobSpec } from "../store/jobs.ts";
import { projectById } from "../store/projects.ts";
import { internalRoutes } from "./internal.ts";
import { call, startedJob, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let job: { jobId: string; token: string; projectId: string };
const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (path: string, token: string, body?: unknown) =>
  call(app, {
    method: "POST",
    path,
    headers: bearer(token, body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const suggestions = {
  tagline: "A tiny demo",
  summary: "It demonstrates RepoWiki.",
  contributionDraft: "I wrote it.",
  highlightCandidates: [],
};

beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, internalRoutes(deps));
  job = await startedJob(deps);
});
afterEach(async () => deps.db.close());

describe("the worker's internal API (spec 2 §6)", () => {
  it("refuses a missing or forged token", async () => {
    expect((await call(app, { method: "POST", path: "/internal/job/lease" })).status).toBe(401);
    expect((await post("/internal/job/lease", "forged")).status).toBe(401);
  });

  it("leases the job once and returns the worker's spec, idempotently", async () => {
    const first = await post("/internal/job/lease", job.token);
    expect(first.status).toBe(200);
    expect(JSON.parse(String(first.body))).toMatchObject({
      jobId: job.jobId,
      attempt: 1,
      kind: "generate",
      repo: { fullName: "demo-dev/demo-repo" },
      author: { login: "demo-dev" },
      limits: { maxIndexedFiles: 1000 },
      llmUrl: `${deps.config.runner.internalUrl}/llm`,
    });
    expect((await post("/internal/job/lease", job.token)).status).toBe(200);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ status: "running", step: "fetch" });
  });

  it("records heartbeats and fails a repository over the plan's file limit", async () => {
    await post("/internal/job/lease", job.token);
    expect((await post("/internal/job/heartbeat", job.token, { step: "index" })).status).toBe(204);
    expect((await post("/internal/job/indexed", job.token, { indexedFiles: 1000 })).status).toBe(204);
    const big = await post("/internal/job/indexed", job.token, { indexedFiles: 1001 });
    expect(big.status).toBe(422);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ status: "failed", refusal: "repo-too-large" });
    expect((await post("/internal/job/heartbeat", job.token, { step: "write" })).status).toBe(401);
  });

  it("stores the export, then creates the generation and revision 1 on success", async () => {
    await post("/internal/job/lease", job.token);
    const exportBody = JSON.stringify(fixtureExport());
    const put = await call(app, {
      method: "PUT",
      path: "/internal/job/export",
      headers: bearer(job.token, { "content-type": "application/json" }),
      body: exportBody,
    });
    expect(put.status).toBe(204);
    expect((await jobSpec(deps.db, job.jobId))?.export?.key).toBe(`exports/${job.jobId}-1.json`);
    const featureIds = fixtureExport().manifest.features.map((f) => f.id);
    const done = await post("/internal/job/succeed", job.token, {
      suggestions,
      facts: {
        languages: [{ name: "Python", share: 1 }],
        indexedFiles: 3,
        featureIds,
        author: { commits: 2, totalCommits: 2, currentLines: 10, totalLines: 10, features: [] },
      },
      engineVersion: "0.0.0",
      models: ["claude-haiku-4-5"],
    });
    expect(done.status).toBe(204);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ status: "succeeded" });
    const revision = await latestRevision(deps.db, job.projectId);
    expect(revision).toMatchObject({ number: 1, source: "generation" });
    expect(await generationById(deps.db, revision?.generationId ?? "")).toMatchObject({
      jobId: job.jobId,
      suggestions,
    });
    expect(await projectById(deps.db, job.projectId)).toMatchObject({ latestRevision: 1 });
    expect((await post("/internal/job/heartbeat", job.token, { step: "render" })).status).toBe(401);
  });

  it("refuses success before the export is stored, and an invalid export", async () => {
    await post("/internal/job/lease", job.token);
    expect((await post("/internal/job/succeed", job.token, { suggestions, facts: {}, engineVersion: "x", models: ["m"] })).status).toBe(400);
    const bad = await call(app, {
      method: "PUT",
      path: "/internal/job/export",
      headers: bearer(job.token, { "content-type": "application/json" }),
      body: '{"schemaVersion":1}',
    });
    expect(bad.status).toBe(400);
  });

  it("fails a job with a worker code and refuses any other code", async () => {
    await post("/internal/job/lease", job.token);
    expect((await post("/internal/job/fail", job.token, { code: "frozen" })).status).toBe(400);
    expect((await post("/internal/job/fail", job.token, { code: "job-failed" })).status).toBe(204);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ status: "failed", refusal: "job-failed" });
  });

  it("charges an open reservation as spend when the job ends", async () => {
    await post("/internal/job/lease", job.token);
    await deps.db.query("INSERT INTO reservations (id, job_id, attempt, usd_micros) VALUES ($1, $2, 1, 12345)", [
      deps.newId(),
      job.jobId,
    ]);
    await post("/internal/job/fail", job.token, { code: "job-failed" });
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ spentUsdMicros: 12345 });
  });
});
```

(`fixtureExport()` lives in `packages/site/src/test-fixtures.ts` and imports only `@repowiki/core`. Give the site package an `exports` field so other packages can import it by name, and add `"@repowiki/site": "workspace:*"` to `packages/server/package.json` (M14e needs `buildSite` from it anyway):

```json
  "exports": {
    ".": "./src/build.ts",
    "./test-fixtures": "./src/test-fixtures.ts"
  },
```

Run `pnpm install` after both edits.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server/src/routes/internal.test.ts`
Expected: FAIL — cannot resolve `./internal.ts`, `../store/drafts.ts`.

- [ ] **Step 4: Write the implementation**

`packages/server/src/store/drafts.ts`:

```ts
import { DraftRevision, Generation } from "@repowiki/hosted";
import type { Queryable } from "../db/db.ts";
import { asJson, parsedBody } from "./rows.ts";

export async function generationById(q: Queryable, id: string): Promise<Generation | null> {
  const rows = await q.query<{ body: unknown }>("SELECT body FROM generations WHERE id = $1", [id]);
  return rows[0] === undefined ? null : parsedBody(Generation, rows[0].body, "generation");
}

export async function saveGeneration(q: Queryable, generation: Generation): Promise<void> {
  const body = parsedBody(Generation, generation, "generation");
  await q.query("INSERT INTO generations (id, project_id, body) VALUES ($1, $2, $3::jsonb)", [
    body.id,
    body.projectId,
    asJson(body),
  ]);
}

export async function latestRevision(q: Queryable, projectId: string): Promise<DraftRevision | null> {
  const rows = await q.query<{ body: unknown }>(
    "SELECT body FROM revisions WHERE project_id = $1 ORDER BY number DESC LIMIT 1",
    [projectId],
  );
  return rows[0] === undefined ? null : parsedBody(DraftRevision, rows[0].body, "revision");
}

/** Revisions are immutable (Contract C4): inserting an existing number is an error. */
export async function saveRevision(q: Queryable, revision: DraftRevision): Promise<void> {
  const body = parsedBody(DraftRevision, revision, "revision");
  await q.query("INSERT INTO revisions (project_id, number, body) VALUES ($1, $2, $3::jsonb)", [
    body.projectId,
    body.number,
    asJson(body),
  ]);
}
```

`packages/server/src/routes/internal.ts`:

```ts
import { WikiExport } from "@repowiki/core";
import {
  Facts,
  failJob,
  firstRevision,
  type Generation,
  heartbeatJob,
  type Job,
  JobStep,
  leaseJob,
  PLANS,
  refreshRevision,
  succeedJob,
  Suggestions,
} from "@repowiki/hosted";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { HttpError, readBody, readJson } from "../http/body.ts";
import type { Route, RouteRequest } from "../http/router.ts";
import { json } from "../http/server.ts";
import { generationById, latestRevision, saveGeneration, saveRevision } from "../store/drafts.ts";
import { jobById, jobSpec, revokeTokens, saveJob, saveJobSpec, settleOpen, tokenJob } from "../store/jobs.ts";
import { projectById, saveProject } from "../store/projects.ts";

export const EXPORT_LIMIT = 32 * 1024 * 1024;
export const LEASE_MS = 120_000;
const noContent = { status: 204 };

/** The lease reply: everything a worker needs to run one attempt (spec 2 §6). */
export interface WorkerSpec {
  jobId: string;
  attempt: number;
  kind: Job["kind"];
  commitSha: string;
  repo: { fullName: string; name: string; cloneUrl: string; sizeKb: number };
  author: { login: string; githubUserId: number; commitShas: string[] };
  limits: { maxIndexedFiles: number };
  llmUrl: string;
}

function bearer(request: RouteRequest): string | null {
  const value = request.headers.authorization;
  const match = typeof value === "string" ? /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(value) : null;
  return match?.[1] ?? null;
}

/** The job this request's token names, locked, if the token is for its current live attempt. */
async function workerJob(deps: Deps, tx: Queryable, request: RouteRequest): Promise<Job> {
  const token = bearer(request);
  const held = token === null ? null : await tokenJob(tx, token);
  const job = held === null ? null : await jobById(tx, held.jobId, true);
  if (held === null || job === null || job.attempt !== held.attempt || (job.status !== "queued" && job.status !== "running")) {
    throw new HttpError(401, "This job token is not valid.");
  }
  return job;
}

const contract = <T>(result: { ok: true; value: T } | { ok: false; code: string; detail?: string }): T => {
  if (!result.ok) throw new HttpError(409, result.code);
  return result.value;
};

const Heartbeat = z.strictObject({ step: JobStep });
const Indexed = z.strictObject({ indexedFiles: z.int().nonnegative() });
const Succeed = z.strictObject({
  suggestions: Suggestions,
  facts: Facts,
  engineVersion: z.string().min(1).max(64),
  models: z.array(z.string().min(1).max(128)).min(1).max(8),
});
const Fail = z.strictObject({ code: z.enum(["job-failed", "job-cost-cap", "repo-too-large"]) });

/** The worker's routes, authenticated by its job token (spec 2 §6). */
export function internalRoutes(deps: Deps): Route[] {
  const end = async (tx: Queryable, job: Job, code: "job-failed" | "job-cost-cap" | "repo-too-large") => {
    const settled = await settleOpen(tx, job);
    await saveJob(tx, contract(failJob(settled, settled.attempt, code, deps.now())));
    await revokeTokens(tx, job.id);
  };

  return [
    {
      method: "POST",
      pattern: "/internal/job/lease",
      handler: async (request) =>
        deps.db.transaction(async (tx) => {
          let job = await workerJob(deps, tx, request);
          if (job.status === "queued") {
            job = contract(leaseJob(job, deps.now(), LEASE_MS));
            await saveJob(tx, job);
          }
          const spec = await jobSpec(tx, job.id);
          if (spec === null) throw new HttpError(500, "job has no spec");
          const reply: WorkerSpec = {
            jobId: job.id,
            attempt: job.attempt,
            kind: job.kind,
            commitSha: job.commitSha,
            repo: { fullName: spec.repo.fullName, name: spec.repo.name, cloneUrl: spec.repo.cloneUrl, sizeKb: spec.repo.sizeKb },
            author: spec.author,
            limits: { maxIndexedFiles: PLANS[spec.plan].maxIndexedFiles },
            llmUrl: `${deps.config.runner.internalUrl}/llm`,
          };
          return json(200, reply);
        }),
    },
    {
      method: "POST",
      pattern: "/internal/job/heartbeat",
      handler: async (request) => {
        const { step } = await readJson(request.raw, Heartbeat);
        return deps.db.transaction(async (tx) => {
          const job = await workerJob(deps, tx, request);
          await saveJob(tx, contract(heartbeatJob(job, job.attempt, step, deps.now(), LEASE_MS)));
          return noContent;
        });
      },
    },
    {
      method: "POST",
      pattern: "/internal/job/indexed",
      handler: async (request) => {
        const { indexedFiles } = await readJson(request.raw, Indexed);
        return deps.db.transaction(async (tx) => {
          const job = await workerJob(deps, tx, request);
          const spec = await jobSpec(tx, job.id);
          if (spec !== null && indexedFiles > PLANS[spec.plan].maxIndexedFiles) {
            await end(tx, job, "repo-too-large");
            return json(422, { code: "repo-too-large" });
          }
          return noContent;
        });
      },
    },
    {
      method: "PUT",
      pattern: "/internal/job/export",
      handler: async (request) => {
        if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
          throw new HttpError(415, "Expected application/json.");
        }
        const bytes = await readBody(request.raw, EXPORT_LIMIT);
        let parsed: unknown;
        try {
          parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
          throw new HttpError(400, "Malformed JSON.");
        }
        if (!WikiExport.safeParse(parsed).success) throw new HttpError(400, "The export is not a valid RepoWiki export.");
        return deps.db.transaction(async (tx) => {
          const job = await workerJob(deps, tx, request);
          const spec = await jobSpec(tx, job.id);
          if (spec === null) throw new HttpError(500, "job has no spec");
          const key = `exports/${job.id}-${job.attempt}.json`;
          await deps.objects.put(key, bytes, "application/json");
          const hash = createHash("sha256").update(bytes).digest("hex");
          await saveJobSpec(tx, job.id, { ...spec, export: { key, hash } });
          return noContent;
        });
      },
    },
    {
      method: "POST",
      pattern: "/internal/job/succeed",
      handler: async (request) => {
        const body = await readJson(request.raw, Succeed);
        return deps.db.transaction(async (tx) => {
          const job = await workerJob(deps, tx, request);
          const spec = await jobSpec(tx, job.id);
          if (spec?.export == null) throw new HttpError(409, "Upload the export before succeeding.");
          const project = await projectById(tx, job.projectId, true);
          if (project === null) throw new HttpError(500, "job has no project");
          const now = deps.now();
          const settled = await settleOpen(tx, job);
          const done = contract(succeedJob(settled, settled.attempt, now));
          const generation: Generation = {
            id: deps.newId(),
            jobId: job.id,
            projectId: project.id,
            commitSha: job.commitSha,
            exportKey: spec.export.key,
            exportHash: spec.export.hash,
            suggestions: body.suggestions,
            facts: body.facts,
            engineVersion: body.engineVersion,
            models: body.models,
            spentUsdMicros: done.spentUsdMicros,
            createdAt: now,
          };
          await saveGeneration(tx, generation);
          const latest = project.latestRevision === 0 ? null : await latestRevision(tx, project.id);
          const previous = latest === null ? null : await generationById(tx, latest.generationId);
          const revised =
            latest === null || previous === null
              ? contract(firstRevision(project, generation, now))
              : contract(refreshRevision(project, latest, previous, generation, now));
          await saveRevision(tx, revised.revision);
          await saveProject(tx, revised.project);
          await saveJob(tx, done);
          await revokeTokens(tx, job.id);
          return noContent;
        });
      },
    },
    {
      method: "POST",
      pattern: "/internal/job/fail",
      handler: async (request) => {
        const { code } = await readJson(request.raw, Fail);
        return deps.db.transaction(async (tx) => {
          const job = await workerJob(deps, tx, request);
          if (job.status !== "running") throw new HttpError(409, "The job is not running.");
          await end(tx, job, code);
          return noContent;
        });
      },
    },
  ];
}
```

(`readJson` refuses an unknown or invalid `facts`/`suggestions` with 400 before the transaction, so the "success before export" test sees 400 for its empty `facts`; a valid body without an export gets the 409.)

Add `objects: ObjectStore` to `Deps` in `app.ts` (`import type { ObjectStore } from "./objects/store.ts";`).

Add to `packages/server/src/index.ts`:

```ts
export { EXPORT_LIMIT, internalRoutes, LEASE_MS, type WorkerSpec } from "./routes/internal.ts";
export { generationById, latestRevision, saveGeneration, saveRevision } from "./store/drafts.ts";
```

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server
pnpm check
git add packages/server packages/site/package.json pnpm-lock.yaml
git -c user.email=sean.may101@gmail.com commit -m "feat(server): give the worker a job-token API from lease to success"
```

---

### Task 4: The LLM proxy

**Files:**
- Create: `packages/server/src/proxy/cost.ts`, `packages/server/src/proxy/cost.test.ts`
- Create: `packages/server/src/routes/llm.ts`, `packages/server/src/routes/llm.test.ts`, `packages/server/src/proxy/fake-anthropic.ts`
- Modify: `packages/server/package.json` (`"@repowiki/llm": "workspace:*"`), `packages/server/src/app.ts` (`Deps` gains `anthropic: { url: string; key: string | null; fetch: typeof fetch }`), `packages/server/src/routes/test-app.ts`, `packages/server/src/index.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `@repowiki/llm`'s `priceFor`, `callCostUsd`, `BATCH_PRICE_FACTOR`; hosted `recordSpend`.
- Produces: `worstCaseMicros(model, bytes, maxTokens, batch)` → `number | null`, `actualMicros(model, usage, batch)` → `number | null`, `AnthropicUsage` (schema), `llmRoutes(deps)`, `fakeAnthropicFetch()` (test and demo upstream: `/v1/messages`, batch create/retrieve/results).

Behaviour:

- `x-api-key` is the job token; the job must be running on that attempt (401 otherwise).
- Only models `priceFor` knows (400 otherwise); `max_tokens` an integer 1–64,000.
- **Reserve** in one transaction locking the job: worst case = UTF-8 bytes of the request JSON (as input tokens) plus `max_tokens` (as output) at the model's price, halved for a batch (summed over its requests). Refuse with **429** `{ type: "error", error: { type: "rate_limit_error", message: "job-cost-cap" } }` if `spent + open reservations + worst > cap`.
- **Forward** to `${anthropic.url}/v1/...` with the real key and `anthropic-version` / `anthropic-beta` passed through; nothing else from the worker.
- **Settle**: a message settles at once from its `usage` (0 on an upstream error); a batch's reservation records its batch id and settles once, when its results are read, summed over succeeded results at batch price. Settled spend is `min(actual, reserved)` through `recordSpend`.
- **Rewrite** `results_url` in batch create and retrieve replies to `${runner.internalUrl}/llm/v1/messages/batches/<id>/results` (the worker reaches the server only at its private address, and the SDK fetches `results_url` as given); refuse a batch id that is not this job's (404).
- 10 requests a second per job token, in memory (429 past it).

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-proxy
```

- [ ] **Step 2: Write the failing tests**

`packages/server/src/proxy/cost.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { actualMicros, worstCaseMicros } from "./cost.ts";

describe("proxy cost arithmetic (spec 2 S11)", () => {
  it("bounds a request by its bytes as input tokens and max_tokens as output", () => {
    // Haiku 4.5: $1 in, $5 out per million tokens = 1 and 5 micro-dollars per token.
    expect(worstCaseMicros("claude-haiku-4-5", 10_000, 8000, false)).toBe(10_000 + 40_000);
    expect(worstCaseMicros("claude-haiku-4-5", 10_000, 8000, true)).toBe(25_000);
    expect(worstCaseMicros("claude-haiku-4-5-20251001", 1, 1, false)).toBe(6);
    expect(worstCaseMicros("gpt-4", 1, 1, false)).toBeNull();
  });

  it("prices actual usage with cache tokens, rounding up", () => {
    const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 };
    expect(actualMicros("claude-haiku-4-5", usage, false)).toBe(1000 + 1000 + 10 + 50);
    expect(actualMicros("claude-haiku-4-5", usage, true)).toBe(1030);
    expect(actualMicros("claude-haiku-4-5", { input_tokens: 1, output_tokens: 0 }, true)).toBe(1);
  });
});
```

`packages/server/src/routes/llm.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { fakeAnthropicFetch } from "../proxy/fake-anthropic.ts";
import { jobById } from "../store/jobs.ts";
import { internalRoutes } from "./internal.ts";
import { llmRoutes } from "./llm.ts";
import { call, startedJob, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let job: { jobId: string; token: string; projectId: string };
let upstream: ReturnType<typeof fakeAnthropicFetch>;

const message = (maxTokens = 1000, model = "claude-haiku-4-5") => ({
  model,
  max_tokens: maxTokens,
  messages: [{ role: "user", content: "hello" }],
});
const send = (path: string, body: unknown, token = job.token, method = "POST") =>
  call(app, {
    method,
    path,
    headers: { "x-api-key": token, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(async () => {
  upstream = fakeAnthropicFetch();
  deps = await testDeps({ anthropic: { url: "https://api.anthropic.test", key: "sk-real", fetch: upstream.fetch } });
  app = createApp(deps, [...internalRoutes(deps), ...llmRoutes(deps)]);
  job = await startedJob(deps);
  await call(app, { method: "POST", path: "/internal/job/lease", headers: { authorization: `Bearer ${job.token}` } });
});
afterEach(async () => deps.db.close());

describe("the LLM proxy (spec 2 S11)", () => {
  it("forwards a message with the real key and charges its actual cost", async () => {
    const reply = await send("/llm/v1/messages", message());
    expect(reply.status).toBe(200);
    expect(upstream.calls[0]?.headers.get("x-api-key")).toBe("sk-real");
    expect(upstream.calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
    const spent = (await jobById(deps.db, job.jobId))?.spentUsdMicros;
    expect(spent).toBe(upstream.costOfMessage);
    expect(await deps.db.query("SELECT * FROM reservations WHERE NOT settled")).toEqual([]);
  });

  it("refuses a forged or old token, an unknown model and absurd max_tokens", async () => {
    expect((await send("/llm/v1/messages", message(), "forged")).status).toBe(401);
    expect((await send("/llm/v1/messages", message(1000, "gpt-4"))).status).toBe(400);
    expect((await send("/llm/v1/messages", message(1_000_000))).status).toBe(400);
    expect(upstream.calls).toEqual([]);
  });

  it("refuses a request whose worst case would pass the job's cap, before calling upstream", async () => {
    await deps.db.query(
      "UPDATE jobs SET body = jsonb_set(body, '{capUsdMicros}', to_jsonb(5000)) WHERE id = $1",
      [job.jobId],
    );
    await deps.db.query(
      "UPDATE jobs SET body = jsonb_set(body, '{estimateUsdMicros}', to_jsonb(5000)) WHERE id = $1",
      [job.jobId],
    );
    const reply = await send("/llm/v1/messages", message(8000));
    expect(reply.status).toBe(429);
    expect(String(reply.body)).toContain("job-cost-cap");
    expect(upstream.calls).toEqual([]);
  });

  it("reserves a batch, rewrites its results_url, and settles once from its results", async () => {
    const created = await send("/llm/v1/messages/batches", {
      requests: [
        { custom_id: "a", params: message(2000) },
        { custom_id: "b", params: message(2000) },
      ],
    });
    expect(created.status).toBe(200);
    const batch = JSON.parse(String(created.body));
    expect(batch.results_url).toBe(`${deps.config.runner.internalUrl}/llm/v1/messages/batches/${batch.id}/results`);
    const open = await deps.db.query<{ usd_micros: string }>("SELECT usd_micros FROM reservations WHERE NOT settled");
    expect(open).toHaveLength(1);
    const status = await send(`/llm/v1/messages/batches/${batch.id}`, undefined, job.token, "GET");
    expect(JSON.parse(String(status.body)).results_url).toBe(batch.results_url);
    const results = await send(`/llm/v1/messages/batches/${batch.id}/results`, undefined, job.token, "GET");
    expect(results.status).toBe(200);
    expect(String(results.body).trim().split("\n")).toHaveLength(2);
    const spent = (await jobById(deps.db, job.jobId))?.spentUsdMicros;
    expect(spent).toBe(upstream.costOfBatch);
    await send(`/llm/v1/messages/batches/${batch.id}/results`, undefined, job.token, "GET");
    expect((await jobById(deps.db, job.jobId))?.spentUsdMicros).toBe(spent);
  });

  it("refuses another job's batch id", async () => {
    expect((await send("/llm/v1/messages/batches/msgbatch_other", undefined, job.token, "GET")).status).toBe(404);
  });

  it("refuses the worker once its attempt has been recovered", async () => {
    await deps.db.query("UPDATE jobs SET body = jsonb_set(body, '{attempt}', to_jsonb(2)) WHERE id = $1", [job.jobId]);
    expect((await send("/llm/v1/messages", message())).status).toBe(401);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server/src/proxy packages/server/src/routes/llm.test.ts`
Expected: FAIL — cannot resolve `./cost.ts`, `./llm.ts`, `../proxy/fake-anthropic.ts`.

- [ ] **Step 4: Write the implementation**

Add `"@repowiki/llm": "workspace:*"` to `packages/server/package.json` dependencies; `pnpm install`.

`packages/server/src/proxy/cost.ts`:

```ts
import { BATCH_PRICE_FACTOR, callCostUsd, priceFor } from "@repowiki/llm";
import { z } from "zod";

/** Anthropic's `usage` block, as messages and batch results report it. */
export const AnthropicUsage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
});
export type AnthropicUsage = z.infer<typeof AnthropicUsage>;

/**
 * A request's worst case in micro-dollars: every UTF-8 byte as an input token (a token is at least
 * one byte) and `maxTokens` of output (spec 2 S11). Null for a model with no price.
 */
export function worstCaseMicros(model: string, bytes: number, maxTokens: number, batch: boolean): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  const micros = bytes * Math.max(price.input, price.cacheWrite) + maxTokens * price.output;
  return Math.ceil(micros * (batch ? BATCH_PRICE_FACTOR : 1));
}

/** What a call actually cost, in micro-dollars rounded up. */
export function actualMicros(model: string, usage: AnthropicUsage, batch: boolean): number | null {
  const usd = callCostUsd(
    model,
    {
      in: usage.input_tokens,
      out: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
    batch,
  );
  return usd === null ? null : Math.ceil(usd * 1_000_000 - 1e-9);
}
```

(The worst case prices bytes at the dearer of input and cache-write, because a request may write its prefix to the cache; for Haiku that is $1.25, so the first test's numbers become `12_500 + 40_000` and `26_250` — use those values in the test.)

`packages/server/src/proxy/fake-anthropic.ts`:

```ts
import { actualMicros } from "./cost.ts";

/** Test and demo upstream: messages and batches with fixed usage. */
export function fakeAnthropicFetch(): {
  fetch: typeof fetch;
  calls: { url: string; headers: Headers; body: string }[];
  costOfMessage: number;
  costOfBatch: number;
} {
  const usage = { input_tokens: 100, output_tokens: 50 };
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const batches = new Map<string, string[]>();
  let n = 0;
  const reply = (value: unknown) => Response.json(value);
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? "" : String(init.body);
    calls.push({ url: url.href, headers: new Headers(init?.headers), body });
    if (url.pathname === "/v1/messages") {
      return reply({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage });
    }
    if (url.pathname === "/v1/messages/batches" && init?.method === "POST") {
      const id = `msgbatch_${++n}`;
      const parsed = JSON.parse(body) as { requests: { custom_id: string }[] };
      batches.set(id, parsed.requests.map((r) => r.custom_id));
      return reply({ id, type: "message_batch", processing_status: "ended", results_url: `https://api.anthropic.test/v1/messages/batches/${id}/results` });
    }
    const match = /^\/v1\/messages\/batches\/([^/]+)(\/results)?$/.exec(url.pathname);
    const ids = match ? batches.get(match[1] ?? "") : undefined;
    if (match && ids) {
      if (!match[2]) return reply({ id: match[1], type: "message_batch", processing_status: "ended", results_url: `https://api.anthropic.test/v1/messages/batches/${match[1]}/results` });
      const lines = ids.map((custom_id) => JSON.stringify({ custom_id, result: { type: "succeeded", message: { model: "claude-haiku-4-5", usage, content: [] } } }));
      return new Response(`${lines.join("\n")}\n`, { headers: { "content-type": "application/x-jsonl" } });
    }
    return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no" } }), { status: 404 });
  };
  return {
    fetch: fetchFn,
    calls,
    costOfMessage: actualMicros("claude-haiku-4-5", usage, false) ?? 0,
    costOfBatch: 2 * (actualMicros("claude-haiku-4-5", usage, true) ?? 0),
  };
}
```

`packages/server/src/routes/llm.ts`:

```ts
import { type Job, recordSpend } from "@repowiki/hosted";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { HttpError, readBody } from "../http/body.ts";
import type { Route, RouteRequest } from "../http/router.ts";
import { json } from "../http/server.ts";
import { actualMicros, AnthropicUsage, worstCaseMicros } from "../proxy/cost.ts";
import { jobById, openReservations, saveJob, tokenJob } from "../store/jobs.ts";

const REQUEST_LIMIT = 8 * 1024 * 1024;
const MAX_OUTPUT = 64_000;
const PER_SECOND = 10;

const Params = z.looseObject({ model: z.string().min(1), max_tokens: z.int().min(1).max(MAX_OUTPUT) });
const BatchCreate = z.looseObject({
  requests: z.array(z.looseObject({ custom_id: z.string().min(1), params: Params })).min(1).max(1000),
});

const capError = () =>
  json(429, { type: "error", error: { type: "rate_limit_error", message: "job-cost-cap" } });

/** The worker's Anthropic endpoint: the job's cap made hard, the real key never in the sandbox (S11). */
export function llmRoutes(deps: Deps): Route[] {
  const seen = new Map<string, number[]>();
  const limited = (token: string) => {
    const now = Date.parse(deps.now());
    const recent = (seen.get(token) ?? []).filter((t) => now - t < 1000);
    recent.push(now);
    seen.set(token, recent);
    return recent.length > PER_SECOND;
  };

  async function heldJob(tx: Queryable, request: RouteRequest): Promise<Job> {
    const token = request.headers["x-api-key"];
    const held = typeof token === "string" ? await tokenJob(tx, token) : null;
    const job = held === null ? null : await jobById(tx, held.jobId, true);
    if (held === null || job === null || job.status !== "running" || job.attempt !== held.attempt) {
      throw new HttpError(401, "This job token is not valid.");
    }
    return job;
  }

  /** Reserve `worst` against the job, or null when it would pass the cap. */
  async function reserve(request: RouteRequest, worst: number): Promise<{ id: string; job: Job } | null> {
    return deps.db.transaction(async (tx) => {
      const job = await heldJob(tx, request);
      const open = await openReservations(tx, job.id);
      if (job.spentUsdMicros + open + worst > job.capUsdMicros) return null;
      const id = deps.newId();
      await tx.query("INSERT INTO reservations (id, job_id, attempt, usd_micros) VALUES ($1, $2, $3, $4)", [
        id,
        job.id,
        job.attempt,
        worst,
      ]);
      return { id, job };
    });
  }

  /** Settle a reservation once, charging min(actual, reserved). */
  async function settle(reservationId: string, actual: number): Promise<void> {
    await deps.db.transaction(async (tx) => {
      const rows = await tx.query<{ job_id: string; usd_micros: string; settled: boolean }>(
        "SELECT job_id, usd_micros, settled FROM reservations WHERE id = $1 FOR UPDATE",
        [reservationId],
      );
      const row = rows[0];
      if (row === undefined || row.settled) return;
      await tx.query("UPDATE reservations SET settled = true WHERE id = $1", [reservationId]);
      const job = await jobById(tx, row.job_id, true);
      if (job === null || job.status !== "running") return;
      const spent = recordSpend(job, job.attempt, Math.min(actual, Number(row.usd_micros)));
      if (spent.ok) await saveJob(tx, spent.value);
    });
  }

  const upstream = (path: string, init: { method: string; body?: string; request: RouteRequest }) => {
    if (deps.anthropic.key === null) throw new HttpError(503, "No model provider is configured.");
    const headers: Record<string, string> = { "x-api-key": deps.anthropic.key, "content-type": "application/json" };
    for (const name of ["anthropic-version", "anthropic-beta"]) {
      const value = init.request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    return deps.anthropic.fetch(`${deps.anthropic.url}${path}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(600_000),
    });
  };

  const resultsUrl = (id: string) =>
    `${deps.config.runner.internalUrl}/llm/v1/messages/batches/${encodeURIComponent(id)}/results`;
  const rewrite = (batch: Record<string, unknown>) =>
    typeof batch.id === "string" && typeof batch.results_url === "string" ? { ...batch, results_url: resultsUrl(batch.id) } : batch;

  async function body(request: RouteRequest): Promise<{ text: string; value: unknown }> {
    if (limited(String(request.headers["x-api-key"] ?? ""))) throw new HttpError(429, "Too many requests.");
    const bytes = await readBody(request.raw, REQUEST_LIMIT);
    try {
      return { text: bytes.toString("utf8"), value: JSON.parse(bytes.toString("utf8")) };
    } catch {
      throw new HttpError(400, "Malformed JSON.");
    }
  }

  async function ownBatch(request: RouteRequest, batchId: string): Promise<string> {
    return deps.db.transaction(async (tx) => {
      const job = await heldJob(tx, request);
      const rows = await tx.query<{ id: string }>("SELECT id FROM reservations WHERE job_id = $1 AND batch_id = $2", [job.id, batchId]);
      if (rows[0] === undefined) throw new HttpError(404, "No such batch for this job.");
      return rows[0].id;
    });
  }

  return [
    {
      method: "POST",
      pattern: "/llm/v1/messages",
      handler: async (request) => {
        const { text, value } = await body(request);
        const params = Params.safeParse(value);
        if (!params.success) throw new HttpError(400, "A model and max_tokens up to 64,000 are required.");
        const worst = worstCaseMicros(params.data.model, Buffer.byteLength(text), params.data.max_tokens, false);
        if (worst === null) throw new HttpError(400, "That model is not allowed.");
        const reservation = await reserve(request, worst);
        if (reservation === null) return capError();
        const response = await upstream("/v1/messages", { method: "POST", body: text, request });
        const reply = (await response.json().catch(() => null)) as { usage?: unknown; model?: string } | null;
        const usage = AnthropicUsage.safeParse(reply?.usage);
        const cost = response.ok && usage.success ? (actualMicros(reply?.model ?? params.data.model, usage.data, false) ?? worst) : 0;
        await settle(reservation.id, cost);
        return json(response.status, reply);
      },
    },
    {
      method: "POST",
      pattern: "/llm/v1/messages/batches",
      handler: async (request) => {
        const { text, value } = await body(request);
        const batch = BatchCreate.safeParse(value);
        if (!batch.success) throw new HttpError(400, "A batch needs requests with a model and max_tokens.");
        let worst = 0;
        for (const item of batch.data.requests) {
          const one = worstCaseMicros(item.params.model, Buffer.byteLength(JSON.stringify(item.params)), item.params.max_tokens, true);
          if (one === null) throw new HttpError(400, "That model is not allowed.");
          worst += one;
        }
        const reservation = await reserve(request, worst);
        if (reservation === null) return capError();
        const response = await upstream("/v1/messages/batches", { method: "POST", body: text, request });
        const reply = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok || reply === null || typeof reply.id !== "string") {
          await settle(reservation.id, 0);
          return json(response.status, reply);
        }
        await deps.db.query("UPDATE reservations SET batch_id = $2 WHERE id = $1", [reservation.id, reply.id]);
        return json(200, rewrite(reply));
      },
    },
    {
      method: "GET",
      pattern: "/llm/v1/messages/batches/:id",
      handler: async (request) => {
        const id = request.params.id ?? "";
        await ownBatch(request, id);
        const response = await upstream(`/v1/messages/batches/${encodeURIComponent(id)}`, { method: "GET", request });
        const reply = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        return json(response.status, reply === null ? null : rewrite(reply));
      },
    },
    {
      method: "POST",
      pattern: "/llm/v1/messages/batches/:id/cancel",
      handler: async (request) => {
        const id = request.params.id ?? "";
        await ownBatch(request, id);
        const response = await upstream(`/v1/messages/batches/${encodeURIComponent(id)}/cancel`, { method: "POST", request });
        const reply = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        return json(response.status, reply === null ? null : rewrite(reply));
      },
    },
    {
      method: "GET",
      pattern: "/llm/v1/messages/batches/:id/results",
      handler: async (request) => {
        const id = request.params.id ?? "";
        const reservationId = await ownBatch(request, id);
        const response = await upstream(`/v1/messages/batches/${encodeURIComponent(id)}/results`, { method: "GET", request });
        const text = await response.text();
        if (!response.ok) return { status: response.status, headers: { "content-type": "application/json" }, body: text };
        let cost = 0;
        for (const line of text.split("\n")) {
          if (line.trim() === "") continue;
          const parsed = (() => {
            try {
              return JSON.parse(line) as { result?: { type?: string; message?: { model?: string; usage?: unknown } } };
            } catch {
              return null;
            }
          })();
          const message = parsed?.result?.type === "succeeded" ? parsed.result.message : undefined;
          const usage = AnthropicUsage.safeParse(message?.usage);
          if (message && usage.success) cost += actualMicros(message.model ?? "claude-haiku-4-5", usage.data, true) ?? 0;
        }
        await settle(reservationId, cost);
        return { status: 200, headers: { "content-type": "application/x-jsonl" }, body: text };
      },
    },
  ];
}
```

Add to `Deps` in `app.ts`:

```ts
  /** Where the proxy forwards model calls; `key` null means no provider is configured. */
  anthropic: { url: string; key: string | null; fetch: typeof fetch };
```

In `testDeps`, default `anthropic: { url: "https://api.anthropic.test", key: null, fetch: fakeAnthropicFetch().fetch }`.

Add to `packages/server/src/index.ts`:

```ts
export { actualMicros, AnthropicUsage, worstCaseMicros } from "./proxy/cost.ts";
export { fakeAnthropicFetch } from "./proxy/fake-anthropic.ts";
export { llmRoutes } from "./routes/llm.ts";
```

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server
pnpm check
git add packages/server pnpm-lock.yaml
git -c user.email=sean.may101@gmail.com commit -m "feat(server): proxy the worker's model calls under a hard per-job cost cap"
```
