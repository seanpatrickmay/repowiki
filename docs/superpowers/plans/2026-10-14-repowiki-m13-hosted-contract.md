# M13 Hosted Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/hosted`, the pure library that holds every rule of the hosted product: entities, state transitions, authorization, URL rules, plan limits and refusals.

**Architecture:** One workspace package with no I/O, no clock and no randomness. Every rule is a function over plain zod-validated data that returns `Result<T>`: either `{ ok: true, value }` or `{ ok: false, code, detail? }`, where `code` is one of the spec's 30 refusal codes. Specs 2–4 (server, worker, proxy, billing) call these functions inside their own transactions.

**Tech Stack:** TypeScript (strict, ESM, type stripping, `.ts` imports, no `enum`/`namespace`/parameter properties), zod 4.6.5, vitest 5, biome.

**Spec:** `docs/superpowers/specs/2026-10-14-repowiki-hosted-contract-design.md` (sections cited as §n).

## Global Constraints

- `packages/hosted` runtime dependencies are exactly `@repowiki/core` and `zod` (C1); its sources import nothing else but their own `./` files.
- No `Date.now()`, argument-less `new Date()`, `Math.random()`, `randomUUID` or `process.` in a hosted source (C1). `Date.parse(x)` and `new Date(x)` with an argument are fine.
- Money is integer micro-dollars (`usdMicros`) everywhere (§5).
- Ids are UUIDv4 strings supplied by the caller (C3); GitHub ids are positive integers (C2).
- Refusal codes, statuses and messages are exactly §11's 30 rows.
- Plan limits are exactly §10's `PLANS` and `PLATFORM`.
- Every commit passes `pnpm check`; Conventional Commits with scope `hosted`; author email `sean.may101@gmail.com`; no AI attribution; never `--no-verify`.
- Each task is one branch and PR under ~300 changed lines (tests included, lockfile excluded), stacked on the previous task's branch: `m13/hosted-scaffold`, `m13/hosted-urls`, `m13/hosted-entities`, `m13/hosted-jobs`, `m13/hosted-drafts`, `m13/hosted-policy`.

## Review Focus

1. **Timestamps with offsets near a month boundary** (`2026-10-31T23:30:00-05:00` is November in UTC): quotas must count in UTC months. Pinned in Task 1 (`monthOf`).
2. **A login or repository name that cuts to a trailing hyphen when suffixed** (`a-…-b` at 39 characters plus `-2`): handles and slugs must stay valid. Pinned in Task 2.
3. **A redirect chain or loop in handles** (login changed twice; corrupted data): lookup must end at the current handle or 404, never loop. Pinned in Task 2.
4. **Republishing a withdrawn project, or restoring one, when the plan is full**: it must not silently freeze every other project. Pinned in Task 6.
5. **An eligibility check for a different repository passed into publish**: the snapshot must belong to the project. Pinned in Task 5.

---

### Task 1: Package scaffold, results, refusals and plan limits (M13.2)

**Files:**
- Create: `packages/hosted/package.json`
- Create: `packages/hosted/src/result.ts`
- Create: `packages/hosted/src/refusals.ts`, `packages/hosted/src/refusals.test.ts`
- Create: `packages/hosted/src/limits.ts`, `packages/hosted/src/limits.test.ts`
- Create: `packages/hosted/src/boundaries.test.ts`
- Create: `packages/hosted/src/index.ts`
- Modify: `package.json` (root devDependencies: add `"@repowiki/hosted": "workspace:*"`)
- Modify: `CLAUDE.md` (Layout: add the `packages/hosted` line after `packages/query`)

**Interfaces:**
- Produces: `Result<T>`, `Ok<T>`, `Refused`, `ok(value)`, `refused(code, detail?)`; `REFUSAL_CODES`, `RefusalCode` (schema and type), `REFUSALS`, `RefusalInfo`; `Plan` (schema and type), `PlanLimits`, `PLANS`, `PLATFORM`, `DAY_MS`, `monthOf(at)`, `jobCap(estimateUsdMicros, remainingUsdMicros): Result<number>`, `isFrozen(plan, activeProjects): boolean`.

- [ ] **Step 1: Create the branch and package manifest**

```bash
git switch -c m13/hosted-scaffold
```

`packages/hosted/package.json`:

```json
{
  "name": "@repowiki/hosted",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@repowiki/core": "workspace:*",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@repowiki/query": "workspace:*"
  }
}
```

Add `"@repowiki/hosted": "workspace:*",` to the root `package.json` devDependencies (alphabetical, after `@repowiki/eval`), then run `pnpm install`.

- [ ] **Step 2: Write the failing boundary test**

`packages/hosted/src/boundaries.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchCalls, refusedImports, sourceImports } from "@repowiki/query/test-boundaries";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

/** Clock, randomness and environment reads a hosted source may not make: callers pass them in. */
const IMPURE = /\bDate\.now\s*\(|new Date\(\s*\)|Math\.random\s*\(|\brandomUUID\b|\bprocess\./;

/** @repowiki/hosted is the hosted product's rules as pure functions (Contract spec C1). */
describe("@repowiki/hosted's boundaries", () => {
  const sources = sourceImports(SRC);

  it("finds the package's sources and leaves its tests out", () => {
    expect(sources.has("limits.ts")).toBe(true);
    expect(sources.has("limits.test.ts")).toBe(false);
  });

  it("depends at run time on core and zod only", () => {
    const pkg = JSON.parse(readFileSync(`${SRC}/../package.json`, "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@repowiki/core", "zod"]);
  });

  it("imports only core, zod and its own modules, and calls no fetch", () => {
    const allowed = (s: string) => s.startsWith("./") || ["@repowiki/core", "zod"].includes(s);
    expect(refusedImports(sources, allowed)).toEqual([]);
    expect(fetchCalls(sources)).toEqual([]);
  });

  it("reads no clock, randomness or environment", () => {
    const impure = [...sources].filter(([, s]) => IMPURE.test(s.text)).map(([path]) => path);
    expect(impure).toEqual([]);
    expect(IMPURE.test("const t = Date.now();")).toBe(true);
    expect(IMPURE.test("const t = new Date();")).toBe(true);
    expect(IMPURE.test("const t = new Date(at);")).toBe(false);
  });
});
```

- [ ] **Step 3: Write the failing refusal and limit tests**

`packages/hosted/src/refusals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { REFUSAL_CODES, RefusalCode, REFUSALS } from "./refusals.ts";
import { ok, refused } from "./result.ts";

describe("refusals (Contract spec §11)", () => {
  it("has exactly the spec's 30 codes, each with one entry", () => {
    expect(REFUSAL_CODES).toHaveLength(30);
    expect(new Set(REFUSAL_CODES).size).toBe(30);
    expect(Object.keys(REFUSALS)).toEqual([...REFUSAL_CODES]);
  });

  it("gives every code an HTTP error status and one plain sentence", () => {
    for (const code of REFUSAL_CODES) {
      const { status, message } = REFUSALS[code];
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
      expect(message, code).toMatch(/^[A-Z][^\n<>]*[.)]$/);
    }
  });

  it("pins the statuses the server relies on", () => {
    expect(REFUSALS["not-signed-in"].status).toBe(401);
    expect(REFUSALS["not-found"].status).toBe(404);
    expect(REFUSALS.withdrawn.status).toBe(410);
    expect(REFUSALS["stale-revision"].status).toBe(409);
    expect(REFUSALS["plan-project-limit"].status).toBe(402);
    expect(REFUSALS["platform-paused"].status).toBe(503);
  });

  it("marks only a paused platform and a failed job as worth retrying", () => {
    const retryable = REFUSAL_CODES.filter((code) => REFUSALS[code].retryable);
    expect(retryable).toEqual(["platform-paused", "job-failed"]);
  });

  it("parses a known code and refuses an unknown one", () => {
    expect(RefusalCode.safeParse("frozen").success).toBe(true);
    expect(RefusalCode.safeParse("forbidden").success).toBe(false);
  });

  it("builds results with and without detail", () => {
    expect(ok(3)).toEqual({ ok: true, value: 3 });
    expect(refused("frozen")).toEqual({ ok: false, code: "frozen" });
    expect(refused("invalid-input", "title")).toEqual({
      ok: false,
      code: "invalid-input",
      detail: "title",
    });
  });
});
```

`packages/hosted/src/limits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isFrozen, jobCap, monthOf, PLANS, PLATFORM } from "./limits.ts";

describe("plan limits (Contract spec §10)", () => {
  it("are the owner's numbers", () => {
    expect(PLANS.free).toEqual({
      projects: 1,
      generationsLifetime: 1,
      generationsPerMonth: 1,
      refreshesPerMonth: 0,
      maxIndexedFiles: 1000,
      monthlyUsdMicros: 1_000_000,
    });
    expect(PLANS.pro).toEqual({
      projects: 10,
      generationsLifetime: null,
      generationsPerMonth: 10,
      refreshesPerMonth: 30,
      maxIndexedFiles: 3000,
      monthlyUsdMicros: 4_000_000,
    });
    expect(PLATFORM).toEqual({
      dailyUsdMicros: 25_000_000,
      freeAccountMinAgeDays: 30,
      jobMaxAttempts: 3,
      jobCapMultiplier: 1.5,
      liveCheckMaxAgeMs: 60_000,
      eligibilityMaxAgeMs: 3_600_000,
      repositoryGraceDays: 30,
    });
  });

  it("counts months in UTC, whatever offset a timestamp carries", () => {
    expect(monthOf("2026-10-14T12:00:00Z")).toBe("2026-10");
    expect(monthOf("2026-10-31T23:30:00-05:00")).toBe("2026-11");
    expect(monthOf("2026-11-01T00:30:00+01:00")).toBe("2026-10");
  });

  it("caps a job at 1.5 times its estimate, never past what the month has left", () => {
    expect(jobCap(1_000_000, 4_000_000)).toEqual({ ok: true, value: 1_500_000 });
    expect(jobCap(333_333, 4_000_000)).toEqual({ ok: true, value: 500_000 });
    expect(jobCap(3_000_000, 4_000_000)).toEqual({ ok: true, value: 4_000_000 });
    expect(jobCap(4_000_000, 4_000_000)).toEqual({ ok: true, value: 4_000_000 });
    expect(jobCap(0, 0)).toEqual({ ok: true, value: 0 });
  });

  it("refuses a job whose estimate is more than the month has left", () => {
    expect(jobCap(4_000_001, 4_000_000)).toEqual({ ok: false, code: "monthly-cost-ceiling" });
    expect(jobCap(1, -5)).toEqual({ ok: false, code: "monthly-cost-ceiling" });
  });

  it("freezes an account's projects only when it has more than its plan covers (C9)", () => {
    expect(isFrozen("free", 0)).toBe(false);
    expect(isFrozen("free", 1)).toBe(false);
    expect(isFrozen("free", 2)).toBe(true);
    expect(isFrozen("pro", 10)).toBe(false);
    expect(isFrozen("pro", 11)).toBe(true);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/hosted`
Expected: FAIL — cannot resolve `./refusals.ts`, `./limits.ts`; the boundary test fails on `sources.has("limits.ts")`.

- [ ] **Step 5: Write the implementation**

`packages/hosted/src/result.ts`:

```ts
import type { RefusalCode } from "./refusals.ts";

export interface Ok<T> {
  ok: true;
  value: T;
}

/** A rule said no: one of the spec's refusal codes (§11), with the field or reason when useful. */
export interface Refused {
  ok: false;
  code: RefusalCode;
  detail?: string;
}

/** What every hosted rule returns: the new value, or the refusal the caller shows the author. */
export type Result<T> = Ok<T> | Refused;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function refused(code: RefusalCode, detail?: string): Refused {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}
```

`packages/hosted/src/refusals.ts`:

```ts
import { z } from "zod";

/** Every refusal a hosted rule can give (Contract spec §11), in the spec's order. */
export const REFUSAL_CODES = [
  "not-signed-in",
  "not-found",
  "github-token-revoked",
  "repo-private",
  "repo-fork",
  "repo-no-push",
  "repo-no-commits",
  "repo-too-large",
  "plan-project-limit",
  "plan-generation-limit",
  "plan-refresh-limit",
  "monthly-cost-ceiling",
  "account-too-new",
  "platform-paused",
  "job-active",
  "job-cost-cap",
  "job-interrupted",
  "job-failed",
  "stale-revision",
  "stale-publication",
  "preview-mismatch",
  "not-reviewed",
  "needs-review-flags",
  "contribution-missing",
  "frozen",
  "withdrawn",
  "restore-expired",
  "invalid-input",
  "invalid-transition",
  "account-deleting",
] as const;

export const RefusalCode = z.enum(REFUSAL_CODES);
export type RefusalCode = z.infer<typeof RefusalCode>;

export interface RefusalInfo {
  /** The HTTP status the server answers with. */
  status: number;
  /** Whether trying the same thing again later can succeed. */
  retryable: boolean;
  /** One plain sentence for the author. */
  message: string;
}

export const REFUSALS: Readonly<Record<RefusalCode, RefusalInfo>> = {
  "not-signed-in": { status: 401, retryable: false, message: "Sign in with GitHub to continue." },
  "not-found": { status: 404, retryable: false, message: "We couldn't find that." },
  "github-token-revoked": {
    status: 401,
    retryable: false,
    message: "GitHub access was revoked. Sign in again to continue.",
  },
  "repo-private": {
    status: 403,
    retryable: false,
    message: "Only public repositories can have a project page.",
  },
  "repo-fork": {
    status: 403,
    retryable: false,
    message: "Forks can't have a project page. Use the original repository.",
  },
  "repo-no-push": {
    status: 403,
    retryable: false,
    message: "You need push access to this repository on GitHub.",
  },
  "repo-no-commits": {
    status: 403,
    retryable: false,
    message: "GitHub shows no commits from your account in this repository.",
  },
  "repo-too-large": {
    status: 422,
    retryable: false,
    message: "This repository has more files than your plan allows.",
  },
  "plan-project-limit": {
    status: 402,
    retryable: false,
    message: "Your plan's project limit is reached. Withdraw a project or upgrade.",
  },
  "plan-generation-limit": {
    status: 402,
    retryable: false,
    message: "You have used this month's generations.",
  },
  "plan-refresh-limit": {
    status: 402,
    retryable: false,
    message: "You have used this month's refreshes, or your plan has none.",
  },
  "monthly-cost-ceiling": {
    status: 402,
    retryable: false,
    message: "This job would go over your plan's monthly limit.",
  },
  "account-too-new": {
    status: 403,
    retryable: false,
    message: "Free accounts need a GitHub account at least 30 days old.",
  },
  "platform-paused": {
    status: 503,
    retryable: true,
    message: "New free jobs are paused for today. Try again tomorrow.",
  },
  "job-active": {
    status: 409,
    retryable: false,
    message: "A job is already running for this project.",
  },
  "job-cost-cap": {
    status: 422,
    retryable: false,
    message: "This job reached its cost limit and stopped. Nothing was charged to your quota.",
  },
  "job-interrupted": {
    status: 500,
    retryable: false,
    message: "This job was interrupted too many times. Start a new one.",
  },
  "job-failed": {
    status: 500,
    retryable: true,
    message: "Something went wrong while building your draft. Nothing was charged to your quota.",
  },
  "stale-revision": {
    status: 409,
    retryable: false,
    message: "This draft changed in another tab or by a refresh. Reload to see it.",
  },
  "stale-publication": {
    status: 409,
    retryable: false,
    message: "A newer version was published. Reload before publishing.",
  },
  "preview-mismatch": {
    status: 409,
    retryable: false,
    message: "The preview is out of date. Preview again before publishing.",
  },
  "not-reviewed": {
    status: 409,
    retryable: false,
    message: "Review this version before publishing.",
  },
  "needs-review-flags": {
    status: 409,
    retryable: false,
    message: "Some generated text under your edits changed. Check the flagged fields and save.",
  },
  "contribution-missing": {
    status: 422,
    retryable: false,
    message: "Write your contribution statement before review.",
  },
  frozen: {
    status: 402,
    retryable: false,
    message: "Your plan no longer covers this project. You can unpublish or export it.",
  },
  withdrawn: { status: 410, retryable: false, message: "This project page is no longer available." },
  "restore-expired": {
    status: 410,
    retryable: false,
    message: "This project can no longer be restored.",
  },
  "invalid-input": {
    status: 400,
    retryable: false,
    message: "Some of what you sent isn't valid. (the field and rule follow)",
  },
  "invalid-transition": {
    status: 409,
    retryable: false,
    message: "That isn't possible right now. Reload to see the current state.",
  },
  "account-deleting": { status: 410, retryable: false, message: "This account is being deleted." },
};
```

`packages/hosted/src/limits.ts`:

```ts
import { z } from "zod";
import { ok, type Result, refused } from "./result.ts";

export const Plan = z.enum(["free", "pro"]);
export type Plan = z.infer<typeof Plan>;

export interface PlanLimits {
  /** Active (draft or published) projects the plan covers; more than this freezes them (C9). */
  projects: number;
  /** Generations an account may ever run, or null when only the monthly limit applies. */
  generationsLifetime: number | null;
  generationsPerMonth: number;
  refreshesPerMonth: number;
  maxIndexedFiles: number;
  /** The hard monthly model-cost ceiling. */
  monthlyUsdMicros: number;
}

/** Contract spec §10, from the owner's D3. */
export const PLANS: Readonly<Record<Plan, PlanLimits>> = {
  free: {
    projects: 1,
    generationsLifetime: 1,
    generationsPerMonth: 1,
    refreshesPerMonth: 0,
    maxIndexedFiles: 1000,
    monthlyUsdMicros: 1_000_000,
  },
  pro: {
    projects: 10,
    generationsLifetime: null,
    generationsPerMonth: 10,
    refreshesPerMonth: 30,
    maxIndexedFiles: 3000,
    monthlyUsdMicros: 4_000_000,
  },
};

export const PLATFORM = {
  /** Platform-wide model spend per UTC day past which new Free jobs pause. */
  dailyUsdMicros: 25_000_000,
  freeAccountMinAgeDays: 30,
  jobMaxAttempts: 3,
  jobCapMultiplier: 1.5,
  /** How old an eligibility check may be for an action that spends money or publishes (C7). */
  liveCheckMaxAgeMs: 60_000,
  /** How old it may be for an action that changes only private state (C7). */
  eligibilityMaxAgeMs: 3_600_000,
  repositoryGraceDays: 30,
} as const;

export const DAY_MS = 86_400_000;

/** The UTC calendar month of a timestamp, as "YYYY-MM": the period plan quotas count in. */
export function monthOf(at: string): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** A job's cost cap: its estimate times the multiplier, never past what the month has left. */
export function jobCap(estimateUsdMicros: number, remainingUsdMicros: number): Result<number> {
  if (estimateUsdMicros > remainingUsdMicros) return refused("monthly-cost-ceiling");
  const cap = Math.ceil(estimateUsdMicros * PLATFORM.jobCapMultiplier);
  return ok(Math.min(cap, remainingUsdMicros));
}

/** C9: an account with more active projects than its plan covers has every project frozen. */
export function isFrozen(plan: Plan, activeProjects: number): boolean {
  return activeProjects > PLANS[plan].projects;
}
```

`packages/hosted/src/index.ts`:

```ts
export {
  DAY_MS,
  isFrozen,
  jobCap,
  monthOf,
  PLANS,
  PLATFORM,
  Plan,
  type PlanLimits,
} from "./limits.ts";
export { REFUSAL_CODES, RefusalCode, REFUSALS, type RefusalInfo } from "./refusals.ts";
export { type Ok, ok, type Refused, type Result, refused } from "./result.ts";
```

`CLAUDE.md`, after the `packages/query` Layout line:

```markdown
- `packages/hosted` — the hosted product's rules as pure functions (entities, state transitions, authorization, URL rules, plan limits, refusals; Contract spec `2026-10-14-repowiki-hosted-contract-design.md`); depends on `core` and `zod` only: no I/O, clock or randomness
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm format && node node_modules/vitest/vitest.mjs run packages/hosted`
Expected: PASS (4 files).

- [ ] **Step 7: Run the full check and commit**

```bash
pnpm check
git add package.json pnpm-lock.yaml CLAUDE.md packages/hosted
git -c user.email=sean.may101@gmail.com commit -m "feat(hosted): add the hosted package with refusals and plan limits"
```

---

### Task 2: URL, handle and slug rules (M13.3)

**Files:**
- Create: `packages/hosted/src/urls.ts`, `packages/hosted/src/urls.test.ts`
- Modify: `packages/hosted/src/index.ts`

**Interfaces:**
- Consumes: `ok`, `refused`, `Result` (Task 1).
- Produces: `HANDLE_PATTERN`, `HANDLE_MAX_LENGTH` (39), `SLUG_MAX_LENGTH` (64), `RESERVED_HANDLES`, `isReservedHandle(name)`, `HandleName` (schema), `Slug` (schema), `Origin` (schema), `handleFor(login, taken): Result<string>`, `slugFor(repoName, taken): string`, `HandleState` (schema and type), `HandleRecord` (interface: `handle`, `accountId`, `state`, `redirectTo`, `createdAt`), `HandleLookup`, `lookupHandle(handles: ReadonlyMap<string, HandleRecord>, name): HandleLookup`, `claimHandle(handles, accountId, login, now): Result<HandleRecord[]>`, `tombstoneHandles(handles: Iterable<HandleRecord>, accountId): HandleRecord[]`, `projectUrl(origin, handle, slug)`, `profileUrl(origin, handle)`, `siteKey(projectId, version)`.

- [ ] **Step 1: Branch**

```bash
git switch -c m13/hosted-urls
```

- [ ] **Step 2: Write the failing tests**

`packages/hosted/src/urls.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  claimHandle,
  type HandleRecord,
  HandleName,
  handleFor,
  lookupHandle,
  Origin,
  profileUrl,
  projectUrl,
  RESERVED_HANDLES,
  Slug,
  siteKey,
  slugFor,
  tombstoneHandles,
} from "./urls.ts";

const T0 = "2026-10-14T12:00:00Z";
const T1 = "2026-11-01T09:00:00Z";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const record = (handle: string, patch: Partial<HandleRecord> = {}): HandleRecord => ({
  handle,
  accountId: A,
  state: "active",
  redirectTo: null,
  createdAt: T0,
  ...patch,
});
const byName = (...records: HandleRecord[]) => new Map(records.map((r) => [r.handle, r]));
const none = () => false;

describe("handles (Contract spec §9)", () => {
  it("accept GitHub logins and refuse anything else", () => {
    for (const ok of ["a", "seanpatrickmay", "a-b-c", "x".repeat(39), "0day"]) {
      expect(HandleName.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["", "-a", "a-", "a--b", "A", "a_b", "a.b", "x".repeat(40), "_x", ".x"]) {
      expect(HandleName.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("are never one of the reserved route names", () => {
    expect(RESERVED_HANDLES.has("api")).toBe(true);
    expect(RESERVED_HANDLES.size).toBe(27);
    for (const name of RESERVED_HANDLES) expect(HandleName.safeParse(name).success).toBe(false);
  });

  it("come from the login lowercased, suffixed when taken or reserved", () => {
    expect(handleFor("SeanPatrickMay", none)).toEqual({ ok: true, value: "seanpatrickmay" });
    const taken = (h: string) => ["sean", "sean-2"].includes(h);
    expect(handleFor("Sean", taken)).toEqual({ ok: true, value: "sean-3" });
    expect(handleFor("Pricing", none)).toEqual({ ok: true, value: "pricing-2" });
  });

  it("stay valid when a suffix cuts a long login at a hyphen", () => {
    const login = `${"a".repeat(36)}-bc`;
    const result = handleFor(login, (h) => h === login);
    expect(result).toEqual({ ok: true, value: `${"a".repeat(36)}-2` });
    if (result.ok) expect(HandleName.safeParse(result.value).success).toBe(true);
  });

  it("refuse a login GitHub could not have issued", () => {
    expect(handleFor("not a login", none)).toMatchObject({ ok: false, code: "invalid-input" });
  });
});

describe("slugs (Contract spec §9)", () => {
  it("are the repository name in lowercase kebab case", () => {
    expect(slugFor("RepoWiki", none)).toBe("repowiki");
    expect(slugFor("my_cool.project--v2", none)).toBe("my-cool-project-v2");
    expect(slugFor("--x--", none)).toBe("x");
    expect(slugFor("___", none)).toBe("project");
    expect(slugFor("Ünïcode", none)).toBe("n-code");
  });

  it("are cut to 64 characters and suffixed on collision within the handle", () => {
    const long = `${"a".repeat(63)}-b`;
    expect(slugFor(long, none)).toBe(`${"a".repeat(63)}`);
    expect(slugFor("repowiki", (s) => s === "repowiki")).toBe("repowiki-2");
    const slug = slugFor(long, (s) => s === "a".repeat(63));
    expect(slug).toBe(`${"a".repeat(62)}-2`);
    expect(Slug.safeParse(slug).success).toBe(true);
  });
});

describe("handle lookup (Contract spec §9)", () => {
  it("finds an active handle, follows redirects to it, and answers gone or missing", () => {
    const handles = byName(
      record("new"),
      record("mid", { state: "redirect", redirectTo: "new" }),
      record("old", { state: "redirect", redirectTo: "mid" }),
      record("dead", { accountId: B, state: "tombstoned" }),
    );
    expect(lookupHandle(handles, "new")).toEqual({ kind: "active", accountId: A, handle: "new" });
    expect(lookupHandle(handles, "old")).toEqual({ kind: "redirect", to: "new" });
    expect(lookupHandle(handles, "dead")).toEqual({ kind: "gone" });
    expect(lookupHandle(handles, "nobody")).toEqual({ kind: "missing" });
  });

  it("ends a redirect loop or a dangling redirect as missing", () => {
    const loop = byName(
      record("a", { state: "redirect", redirectTo: "b" }),
      record("b", { state: "redirect", redirectTo: "a" }),
    );
    expect(lookupHandle(loop, "a")).toEqual({ kind: "missing" });
    const dangling = byName(record("a", { state: "redirect", redirectTo: "zzz" }));
    expect(lookupHandle(dangling, "a")).toEqual({ kind: "missing" });
  });
});

describe("handle changes (Contract spec §9)", () => {
  it("retire the old handle as a redirect when the author claims their new login", () => {
    const result = claimHandle(byName(record("old")), A, "New", T1);
    expect(result).toEqual({
      ok: true,
      value: [
        record("old", { state: "redirect", redirectTo: "new" }),
        record("new", { createdAt: T1 }),
      ],
    });
  });

  it("let an author reclaim a handle that redirects to them", () => {
    const handles = byName(record("new"), record("old", { state: "redirect", redirectTo: "new" }));
    expect(claimHandle(handles, A, "old", T1)).toEqual({
      ok: true,
      value: [record("new", { state: "redirect", redirectTo: "old" }), record("old")],
    });
  });

  it("refuse a handle someone else holds or held, a reserved one, or no change", () => {
    const handles = byName(record("mine"), record("theirs", { accountId: B, state: "tombstoned" }));
    expect(claimHandle(handles, A, "theirs", T1)).toMatchObject({ code: "invalid-input" });
    expect(claimHandle(handles, A, "api", T1)).toMatchObject({ code: "invalid-input" });
    expect(claimHandle(handles, A, "mine", T1)).toMatchObject({ code: "invalid-transition" });
    expect(claimHandle(handles, B, "fresh", T1)).toMatchObject({ code: "invalid-transition" });
  });

  it("tombstone every handle of a deleted account and nobody else's", () => {
    const handles = [
      record("new"),
      record("old", { state: "redirect", redirectTo: "new" }),
      record("other", { accountId: B }),
    ];
    expect(tombstoneHandles(handles, A)).toEqual([
      record("new", { state: "tombstoned" }),
      record("old", { state: "tombstoned" }),
    ]);
  });
});

describe("URLs (Contract spec §9)", () => {
  it("are our own https origin plus handle and slug", () => {
    expect(projectUrl("https://repowiki.dev", "sean", "repowiki")).toBe(
      "https://repowiki.dev/sean/repowiki",
    );
    expect(profileUrl("https://repowiki.dev", "sean")).toBe("https://repowiki.dev/sean");
    expect(siteKey(A, 3)).toBe(`sites/${A}/v3/`);
  });

  it("never use a provider's hostname or a non-https origin", () => {
    expect(Origin.safeParse("https://repowiki.dev").success).toBe(true);
    expect(Origin.safeParse("https://localhost:4387").success).toBe(true);
    for (const bad of [
      "http://repowiki.dev",
      "https://repowiki.dev/",
      "https://repowiki.dev/x",
      "https://repowiki.fly.dev",
      "https://pub-1.r2.dev",
      "https://x.workers.dev",
    ]) {
      expect(Origin.safeParse(bad).success, bad).toBe(false);
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/hosted/src/urls.test.ts`
Expected: FAIL — cannot resolve `./urls.ts`.

- [ ] **Step 4: Write the implementation**

`packages/hosted/src/urls.ts`:

```ts
import { z } from "zod";
import { ok, type Result, refused } from "./result.ts";

/** GitHub's login rule: 1–39 of [a-z0-9-], no leading, trailing or doubled hyphen. */
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
export const HANDLE_MAX_LENGTH = 39;
export const SLUG_MAX_LENGTH = 64;

/** Route names a handle may never take (Contract spec §9). */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "about",
  "account",
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "blog",
  "dashboard",
  "docs",
  "help",
  "login",
  "logout",
  "new",
  "p",
  "pricing",
  "privacy",
  "settings",
  "signin",
  "signup",
  "static",
  "status",
  "support",
  "terms",
  "u",
  "www",
]);

export function isReservedHandle(name: string): boolean {
  return RESERVED_HANDLES.has(name);
}

export const HandleName = z
  .string()
  .regex(HANDLE_PATTERN, "expected a GitHub login")
  .refine((name) => !isReservedHandle(name), "that handle is reserved");

export const Slug = z
  .string()
  .max(SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "expected a lowercase kebab-case slug");

/** Hostnames that belong to a hosting provider; nothing published may link to them (§9). */
const PROVIDER_HOST = /\.(?:fly\.dev|r2\.dev|r2\.cloudflarestorage\.com|workers\.dev|pages\.dev|neon\.tech)$/;

/** RepoWiki's own https origin, with no path: "https://repowiki.dev". */
export const Origin = z
  .string()
  .regex(/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/, "expected an https origin with no path")
  .refine((origin) => !PROVIDER_HOST.test(origin.replace(/:\d+$/, "")), "a provider hostname");

/** `base`, else `base-2`, `base-3`, …, each cut to fit `max` without a trailing hyphen. */
function firstFree(base: string, max: number, free: (candidate: string) => boolean): string {
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, max - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (free(candidate)) return candidate;
  }
}

/** A new account's handle: its GitHub login lowercased, suffixed when taken or reserved. */
export function handleFor(login: string, taken: (handle: string) => boolean): Result<string> {
  const base = login.toLowerCase();
  if (!HANDLE_PATTERN.test(base)) return refused("invalid-input", "not a GitHub login");
  return ok(firstFree(base, HANDLE_MAX_LENGTH, (h) => !isReservedHandle(h) && !taken(h)));
}

/** A new project's slug: the repository name in kebab case, suffixed on collision (§9). */
export function slugFor(repoName: string, taken: (slug: string) => boolean): string {
  const kebab = repoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
  return firstFree(kebab || "project", SLUG_MAX_LENGTH, (slug) => !taken(slug));
}

export const HandleState = z.enum(["active", "redirect", "tombstoned"]);
export type HandleState = z.infer<typeof HandleState>;

export interface HandleRecord {
  handle: string;
  accountId: string;
  state: HandleState;
  /** The handle this one points to, set exactly when `state` is "redirect". */
  redirectTo: string | null;
  createdAt: string;
}

/** What a request for /<name> resolves to: the account, a 301 to its handle, a 410 or a 404. */
export type HandleLookup =
  | { kind: "active"; accountId: string; handle: string }
  | { kind: "redirect"; to: string }
  | { kind: "gone" }
  | { kind: "missing" };

const MAX_REDIRECTS = 16;

export function lookupHandle(
  handles: ReadonlyMap<string, HandleRecord>,
  name: string,
): HandleLookup {
  let record = handles.get(name);
  if (record === undefined) return { kind: "missing" };
  if (record.state === "tombstoned") return { kind: "gone" };
  if (record.state === "active") {
    return { kind: "active", accountId: record.accountId, handle: record.handle };
  }
  for (let hops = 0; hops < MAX_REDIRECTS && record.state === "redirect"; hops++) {
    const next = record.redirectTo === null ? undefined : handles.get(record.redirectTo);
    if (next === undefined) return { kind: "missing" };
    record = next;
  }
  if (record.state === "active") return { kind: "redirect", to: record.handle };
  return record.state === "tombstoned" ? { kind: "gone" } : { kind: "missing" };
}

/**
 * The author's GitHub login changed (§9): the new login becomes their active handle and the old
 * one redirects to it for ever. Returns the changed records, the retired one first. A handle that
 * already redirects to this author may be reclaimed; any other existing handle may not.
 */
export function claimHandle(
  handles: ReadonlyMap<string, HandleRecord>,
  accountId: string,
  login: string,
  now: string,
): Result<HandleRecord[]> {
  const current = [...handles.values()].find(
    (h) => h.accountId === accountId && h.state === "active",
  );
  const name = login.toLowerCase();
  if (current === undefined || current.handle === name) return refused("invalid-transition");
  if (!HANDLE_PATTERN.test(name) || isReservedHandle(name)) {
    return refused("invalid-input", "that handle is not available");
  }
  const existing = handles.get(name);
  if (existing !== undefined && !(existing.accountId === accountId && existing.state === "redirect")) {
    return refused("invalid-input", "that handle is not available");
  }
  const claimed: HandleRecord =
    existing === undefined
      ? { handle: name, accountId, state: "active", redirectTo: null, createdAt: now }
      : { ...existing, state: "active", redirectTo: null };
  return ok([{ ...current, state: "redirect", redirectTo: name }, claimed]);
}

/** Account deletion: every handle the account ever held answers 410 and is never reassigned. */
export function tombstoneHandles(
  handles: Iterable<HandleRecord>,
  accountId: string,
): HandleRecord[] {
  return [...handles]
    .filter((h) => h.accountId === accountId)
    .map((h) => ({ ...h, state: "tombstoned", redirectTo: null }));
}

export function projectUrl(origin: string, handle: string, slug: string): string {
  return `${origin}/${handle}/${slug}`;
}

export function profileUrl(origin: string, handle: string): string {
  return `${origin}/${handle}`;
}

/** Where a published version's static site lives; written once, never overwritten (§9). */
export function siteKey(projectId: string, version: number): string {
  return `sites/${projectId}/v${version}/`;
}
```

Add to `packages/hosted/src/index.ts`:

```ts
export {
  claimHandle,
  HANDLE_MAX_LENGTH,
  HANDLE_PATTERN,
  type HandleLookup,
  HandleName,
  type HandleRecord,
  HandleState,
  handleFor,
  isReservedHandle,
  lookupHandle,
  Origin,
  profileUrl,
  projectUrl,
  RESERVED_HANDLES,
  SLUG_MAX_LENGTH,
  Slug,
  siteKey,
  slugFor,
  tombstoneHandles,
} from "./urls.ts";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm format && node node_modules/vitest/vitest.mjs run packages/hosted`
Expected: PASS.

- [ ] **Step 6: Check and commit**

```bash
pnpm check
git add packages/hosted
git -c user.email=sean.may101@gmail.com commit -m "feat(hosted): add handle, slug and URL rules"
```

---

### Task 3: Entity schemas and the content model (M13.4)

**Files:**
- Create: `packages/hosted/src/content.ts`, `packages/hosted/src/content.test.ts`
- Create: `packages/hosted/src/entities.ts`, `packages/hosted/src/entities.test.ts`
- Create: `packages/hosted/src/test-fixtures.ts`
- Modify: `packages/hosted/src/index.ts`

**Interfaces:**
- Consumes: `Plan` (Task 1), `RefusalCode` (Task 1), `HandleName`, `HandleState`, `Slug` (Task 2); from core `FeatureId`, `GitSha`, `IsoDateTime`, `Sha256Hex`, `INVISIBLE_CHARACTERS`.
- Produces (schemas and same-named types): `plainText(max)`, `Suggestions`, `AuthorFacts`, `Facts`, `Overrides`, `EMPTY_OVERRIDES`, `ATTESTATIONS`, `ATTESTATION_VERSION`; `Uuid`, `GithubId`, `UsdMicros`, `Account`, `Handle`, `Repository`, `ProjectState`, `WithdrawReason`, `Project`, `JOB_STEPS`, `JobKind`, `JobStatus`, `JobStep`, `Job`, `Generation`, `RevisionFlag`, `DraftRevision`, `Review`, `Preview`, `Permission`, `EligibilityFacts`, `PublishedVersion`, `LedgerEntry`, `ACTIONS`, `Action`, `Actor`, `AuditEvent`. Test-only: `test-fixtures.ts` exports `T0`, `ids`, `SHA`, `HASH`, and builders `anAccount`, `aProject`, `aJob`, `aGeneration`, `aRevision`, `aReview`, `aPreview`, `eligibleFacts`, `aPublishedVersion`, each `(patch?) => value`.

- [ ] **Step 1: Branch**

```bash
git switch -c m13/hosted-entities
```

- [ ] **Step 2: Write the test fixtures**

`packages/hosted/src/test-fixtures.ts`:

```ts
import type {
  Account,
  DraftRevision,
  EligibilityFacts,
  Generation,
  Job,
  Preview,
  Project,
  PublishedVersion,
  Review,
} from "./entities.ts";
import { EMPTY_OVERRIDES } from "./content.ts";

/** Test-only builders: one valid example of each entity, patched per test. */
export const T0 = "2026-10-14T12:00:00Z";
export const SHA = "a".repeat(40);
export const HASH = "b".repeat(64);
export const ids = {
  account: "00000000-0000-4000-8000-000000000001",
  other: "00000000-0000-4000-8000-000000000002",
  project: "00000000-0000-4000-8000-000000000003",
  job: "00000000-0000-4000-8000-000000000004",
  generation: "00000000-0000-4000-8000-000000000005",
  generation2: "00000000-0000-4000-8000-000000000006",
} as const;

export const anAccount = (patch: Partial<Account> = {}): Account => ({
  id: ids.account,
  githubUserId: 101,
  login: "sean",
  displayName: "Sean May",
  githubCreatedAt: "2019-01-01T00:00:00Z",
  plan: "free",
  status: "active",
  createdAt: T0,
  ...patch,
});

export const aProject = (patch: Partial<Project> = {}): Project => ({
  id: ids.project,
  accountId: ids.account,
  githubRepoId: 202,
  slug: "repowiki",
  state: "draft",
  withdrawReason: null,
  withdrawnAt: null,
  latestRevision: 0,
  currentVersion: 0,
  createdAt: T0,
  ...patch,
});

export const aJob = (patch: Partial<Job> = {}): Job => ({
  id: ids.job,
  projectId: ids.project,
  kind: "generate",
  commitSha: SHA,
  status: "queued",
  step: null,
  attempt: 1,
  leaseExpiresAt: null,
  estimateUsdMicros: 400_000,
  capUsdMicros: 600_000,
  spentUsdMicros: 0,
  refusal: null,
  createdAt: T0,
  startedAt: null,
  finishedAt: null,
  ...patch,
});

export const aGeneration = (patch: Partial<Generation> = {}): Generation => ({
  id: ids.generation,
  jobId: ids.job,
  projectId: ids.project,
  commitSha: SHA,
  exportKey: `exports/${ids.generation}.json`,
  exportHash: HASH,
  suggestions: {
    tagline: "A citation-backed wiki for a git repository",
    summary: "RepoWiki turns a repository into a wiki whose every claim cites the code.",
    contributionDraft: "I built the indexing and verification pipeline.",
    highlightCandidates: ["indexing", "verify"],
  },
  facts: {
    languages: [{ name: "TypeScript", share: 0.97 }],
    indexedFiles: 585,
    featureIds: ["indexing", "verify", "site"],
    author: {
      commits: 600,
      totalCommits: 620,
      currentLines: 40_000,
      totalLines: 41_000,
      features: [{ featureId: "indexing", commits: 120, currentLines: 9000 }],
    },
  },
  engineVersion: "0.0.0",
  models: ["claude-haiku-4-5"],
  spentUsdMicros: 580_800,
  createdAt: T0,
  ...patch,
});

export const aRevision = (patch: Partial<DraftRevision> = {}): DraftRevision => ({
  projectId: ids.project,
  number: 1,
  generationId: ids.generation,
  overrides: EMPTY_OVERRIDES,
  flags: [],
  source: "generation",
  createdAt: T0,
  ...patch,
});

export const aReview = (patch: Partial<Review> = {}): Review => ({
  projectId: ids.project,
  revision: 1,
  attestationVersion: 1,
  createdAt: T0,
  ...patch,
});

export const aPreview = (patch: Partial<Preview> = {}): Preview => ({
  projectId: ids.project,
  revision: 1,
  siteKey: `previews/${ids.project}/r1/`,
  siteHash: HASH,
  createdAt: T0,
  ...patch,
});

export const eligibleFacts = (patch: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  checkedAt: T0,
  githubUserId: 101,
  githubRepoId: 202,
  fullName: "seanpatrickmay/repowiki",
  visibility: "public",
  isFork: false,
  permission: "admin",
  authoredCommits: 600,
  indexedFiles: 585,
  tokenValid: true,
  ...patch,
});

export const aPublishedVersion = (patch: Partial<PublishedVersion> = {}): PublishedVersion => ({
  projectId: ids.project,
  version: 1,
  revision: 1,
  siteKey: `sites/${ids.project}/v1/`,
  siteHash: HASH,
  authorization: eligibleFacts(),
  publishedAt: T0,
  ...patch,
});
```

- [ ] **Step 3: Write the failing content tests**

`packages/hosted/src/content.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ATTESTATIONS, EMPTY_OVERRIDES, Facts, Overrides, plainText } from "./content.ts";
import { aGeneration } from "./test-fixtures.ts";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("plain text (Contract spec §8)", () => {
  const text = plainText(20);

  it("accepts up to the limit, newlines and tabs, and up to three paragraphs", () => {
    expect(ok(text, "")).toBe(true);
    expect(ok(text, "x".repeat(20))).toBe(true);
    expect(ok(text, "a\tb\nc")).toBe(true);
    expect(ok(text, "a\n\nb\n\nc")).toBe(true);
  });

  it("refuses too long, four paragraphs, control or invisible characters, and HTML", () => {
    expect(ok(text, "x".repeat(21))).toBe(false);
    expect(ok(text, "a\n\nb\n\nc\n \nd")).toBe(false);
    expect(ok(text, "a\rb")).toBe(false);
    expect(ok(text, "a‮b")).toBe(false);
    expect(ok(text, "a​b")).toBe(false);
    expect(ok(text, "<b>x</b>")).toBe(false);
    expect(ok(text, "<!-- x")).toBe(false);
    expect(ok(text, "a < b")).toBe(true);
  });
});

describe("overrides (Contract spec §8)", () => {
  it("start empty and accept up to four distinct highlights", () => {
    expect(ok(Overrides, EMPTY_OVERRIDES)).toBe(true);
    const four = ["a", "b", "c", "d"].map((featureId) => ({ featureId, blurb: "x" }));
    expect(ok(Overrides, { ...EMPTY_OVERRIDES, highlights: four })).toBe(true);
    const five = [...four, { featureId: "e", blurb: "x" }];
    expect(ok(Overrides, { ...EMPTY_OVERRIDES, highlights: five })).toBe(false);
  });

  it("refuse a duplicate, a hidden highlight, a long blurb and unknown fields", () => {
    const h = (featureId: string, blurb = "x") => ({ featureId, blurb });
    expect(ok(Overrides, { ...EMPTY_OVERRIDES, highlights: [h("a"), h("a")] })).toBe(false);
    expect(ok(Overrides, { ...EMPTY_OVERRIDES, hiddenFeatureIds: ["a", "a"] })).toBe(false);
    expect(
      ok(Overrides, { ...EMPTY_OVERRIDES, highlights: [h("a")], hiddenFeatureIds: ["a"] }),
    ).toBe(false);
    expect(ok(Overrides, { ...EMPTY_OVERRIDES, highlights: [h("a", "x".repeat(141))] })).toBe(
      false,
    );
    expect(ok(Overrides, { ...EMPTY_OVERRIDES, html: "<b>" })).toBe(false);
  });
});

describe("facts (Contract spec §8)", () => {
  const facts = aGeneration().facts;

  it("accept a generation's facts", () => {
    expect(ok(Facts, facts)).toBe(true);
  });

  it("refuse an author share above the total, languages over 100% and unknown features", () => {
    expect(ok(Facts, { ...facts, author: { ...facts.author, commits: 621 } })).toBe(false);
    expect(ok(Facts, { ...facts, author: { ...facts.author, currentLines: 41_001 } })).toBe(false);
    const languages = [
      { name: "A", share: 0.6 },
      { name: "B", share: 0.6 },
    ];
    expect(ok(Facts, { ...facts, languages })).toBe(false);
    const features = [{ featureId: "elsewhere", commits: 1, currentLines: 1 }];
    expect(ok(Facts, { ...facts, author: { ...facts.author, features } })).toBe(false);
  });
});

it("keeps attestation 1's wording (Contract spec §8)", () => {
  expect(ATTESTATIONS[1]).toBe(
    "I reviewed this version. The contribution statement describes my own work accurately, and I checked the summary and highlights against the project.",
  );
});
```

- [ ] **Step 4: Write the failing entity tests**

`packages/hosted/src/entities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  Account,
  ACTIONS,
  AuditEvent,
  DraftRevision,
  EligibilityFacts,
  Generation,
  Handle,
  Job,
  LedgerEntry,
  Preview,
  Project,
  PublishedVersion,
  Repository,
  Review,
} from "./entities.ts";
import {
  aGeneration,
  aJob,
  anAccount,
  aPreview,
  aProject,
  aPublishedVersion,
  aReview,
  aRevision,
  eligibleFacts,
  ids,
  T0,
} from "./test-fixtures.ts";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("entities (Contract spec §5)", () => {
  it("accept one valid example of each", () => {
    expect(ok(Account, anAccount())).toBe(true);
    expect(ok(Project, aProject())).toBe(true);
    expect(ok(Job, aJob())).toBe(true);
    expect(ok(Generation, aGeneration())).toBe(true);
    expect(ok(DraftRevision, aRevision())).toBe(true);
    expect(ok(Review, aReview())).toBe(true);
    expect(ok(Preview, aPreview())).toBe(true);
    expect(ok(EligibilityFacts, eligibleFacts())).toBe(true);
    expect(ok(PublishedVersion, aPublishedVersion())).toBe(true);
    const handle = { handle: "sean", accountId: ids.account, state: "active", redirectTo: null };
    expect(ok(Handle, { ...handle, createdAt: T0 })).toBe(true);
    const repo = {
      githubRepoId: 202,
      fullName: "seanpatrickmay/repowiki",
      visibility: "public",
      isFork: false,
      defaultBranch: "main",
      checkedAt: T0,
    };
    expect(ok(Repository, repo)).toBe(true);
  });

  it("refuse unknown fields, non-v4 ids and non-integer GitHub ids", () => {
    expect(ok(Account, { ...anAccount(), admin: true })).toBe(false);
    expect(ok(Account, anAccount({ id: "00000000-0000-1000-8000-000000000001" }))).toBe(false);
    expect(ok(Account, anAccount({ githubUserId: 1.5 }))).toBe(false);
    expect(ok(Account, anAccount({ githubUserId: 0 }))).toBe(false);
  });

  it("set a handle's redirect target exactly when it redirects", () => {
    const base = { handle: "old", accountId: ids.account, createdAt: T0 };
    expect(ok(Handle, { ...base, state: "redirect", redirectTo: "new" })).toBe(true);
    expect(ok(Handle, { ...base, state: "redirect", redirectTo: null })).toBe(false);
    expect(ok(Handle, { ...base, state: "active", redirectTo: "new" })).toBe(false);
  });

  it("give a withdrawn or purged project a reason and time, and nothing else one", () => {
    expect(ok(Project, aProject({ state: "withdrawn" }))).toBe(false);
    const withdrawn = aProject({ state: "withdrawn", withdrawReason: "author", withdrawnAt: T0 });
    expect(ok(Project, withdrawn)).toBe(true);
    expect(ok(Project, { ...withdrawn, state: "purged", withdrawReason: "repository" })).toBe(true);
    expect(ok(Project, aProject({ withdrawReason: "author", withdrawnAt: T0 }))).toBe(false);
  });

  it("refuse a published project with no published version", () => {
    expect(ok(Project, aProject({ state: "published", currentVersion: 0 }))).toBe(false);
    expect(ok(Project, aProject({ state: "published", currentVersion: 1 }))).toBe(true);
  });

  it("give a failed job its refusal code, and keep spend and estimate within the cap", () => {
    expect(ok(Job, aJob({ status: "failed" }))).toBe(false);
    expect(ok(Job, aJob({ status: "failed", refusal: "job-failed" }))).toBe(true);
    expect(ok(Job, aJob({ refusal: "job-failed" }))).toBe(false);
    expect(ok(Job, aJob({ spentUsdMicros: 600_001 }))).toBe(false);
    expect(ok(Job, aJob({ estimateUsdMicros: 600_001 }))).toBe(false);
    expect(ok(Job, aJob({ attempt: 4 }))).toBe(false);
  });

  it("only suggest highlights the generation's wiki has", () => {
    const g = aGeneration();
    const suggestions = { ...g.suggestions, highlightCandidates: ["nowhere"] };
    expect(ok(Generation, { ...g, suggestions })).toBe(false);
  });

  it("accept only the three kinds of revision flag", () => {
    for (const flag of [
      "suggestion-changed:tagline",
      "suggestion-changed:summary",
      "suggestion-changed:contribution",
      "highlight-missing:indexing",
      "hidden-missing:site",
    ]) {
      expect(ok(DraftRevision, aRevision({ flags: [flag] })), flag).toBe(true);
    }
    for (const flag of ["suggestion-changed:title", "highlight-missing:", "stale"]) {
      expect(ok(DraftRevision, aRevision({ flags: [flag] })), flag).toBe(false);
    }
  });

  it("number revisions and versions from 1 and cap authored commits at 1000", () => {
    expect(ok(DraftRevision, aRevision({ number: 0 }))).toBe(false);
    expect(ok(PublishedVersion, aPublishedVersion({ version: 0 }))).toBe(false);
    expect(ok(EligibilityFacts, eligibleFacts({ authoredCommits: 1001 }))).toBe(false);
    expect(ok(EligibilityFacts, eligibleFacts({ indexedFiles: null }))).toBe(true);
  });

  it("name the quota exactly on quota ledger entries", () => {
    const entry = {
      id: ids.generation,
      accountId: ids.account,
      jobId: ids.job,
      kind: "quota",
      usdMicros: 0,
      quota: "generation",
      createdAt: T0,
    };
    expect(ok(LedgerEntry, entry)).toBe(true);
    expect(ok(LedgerEntry, { ...entry, quota: null })).toBe(false);
    expect(ok(LedgerEntry, { ...entry, kind: "spend", quota: "generation" })).toBe(false);
    expect(ok(LedgerEntry, { ...entry, kind: "spend", quota: null, usdMicros: -1 })).toBe(false);
  });

  it("audit an action with its actor, target and outcome", () => {
    expect(ACTIONS).toHaveLength(18);
    const event = {
      id: ids.generation,
      actor: "author",
      action: "project.publish",
      target: { entity: "project", id: ids.project },
      outcome: "allowed",
      createdAt: T0,
    };
    expect(ok(AuditEvent, event)).toBe(true);
    expect(ok(AuditEvent, { ...event, outcome: "frozen" })).toBe(true);
    expect(ok(AuditEvent, { ...event, outcome: "maybe" })).toBe(false);
    expect(ok(AuditEvent, { ...event, action: "job.lease" })).toBe(true);
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/hosted`
Expected: FAIL — cannot resolve `./content.ts`, `./entities.ts`.

- [ ] **Step 6: Write the content model**

`packages/hosted/src/content.ts`:

```ts
import { FeatureId, INVISIBLE_CHARACTERS } from "@repowiki/core";
import { z } from "zod";

/** Control and invisible characters (core's shared rule), tested once with no global state. */
const INVISIBLE = new RegExp(INVISIBLE_CHARACTERS.source, "u");
/** An HTML tag, comment or declaration opening; a lone "<" in prose is fine. */
const MARKUP = /<[a-z!/?]/i;
export const MAX_PARAGRAPHS = 3;

/** Plain text shown on a project page (§8): no markup, no hidden characters, ≤ 3 paragraphs. */
export function plainText(max: number) {
  return z
    .string()
    .max(max)
    .refine((t) => !INVISIBLE.test(t.replace(/[\n\t]/g, "")), "control or invisible characters")
    .refine((t) => !MARKUP.test(t), "HTML is not allowed")
    .refine(
      (t) => t.trim().split(/\n[ \t]*\n\s*/).length <= MAX_PARAGRAPHS,
      `at most ${MAX_PARAGRAPHS} paragraphs`,
    );
}

const distinct = (values: readonly string[]) => new Set(values).size === values.length;
const count = z.int().nonnegative();

/** What a generation proposes; the author's overrides replace any of it (§8). */
export const Suggestions = z.strictObject({
  tagline: plainText(90),
  summary: plainText(900),
  contributionDraft: plainText(1200),
  highlightCandidates: z.array(FeatureId).max(6).refine(distinct, "duplicate feature"),
});
export type Suggestions = z.infer<typeof Suggestions>;

/** The author's git-history facts at the generation's commit (D2); the page always shows them. */
export const AuthorFacts = z
  .strictObject({
    commits: count,
    totalCommits: count,
    currentLines: count,
    totalLines: count,
    features: z.array(
      z.strictObject({ featureId: FeatureId, commits: count, currentLines: count }),
    ),
  })
  .refine(
    (a) => a.commits <= a.totalCommits && a.currentLines <= a.totalLines,
    "an author's share cannot exceed the total",
  );
export type AuthorFacts = z.infer<typeof AuthorFacts>;

export const Facts = z
  .strictObject({
    languages: z
      .array(z.strictObject({ name: z.string().min(1).max(40), share: z.number().min(0).max(1) }))
      .max(20),
    indexedFiles: count,
    featureIds: z.array(FeatureId).refine(distinct, "duplicate feature"),
    author: AuthorFacts,
  })
  .refine((f) => f.languages.reduce((sum, l) => sum + l.share, 0) <= 1 + 1e-9, "shares over 1")
  .refine(
    (f) => f.author.features.every((a) => f.featureIds.includes(a.featureId)),
    "an author feature the wiki does not have",
  );
export type Facts = z.infer<typeof Facts>;

/** The portfolio layer an author edits (§8); a missing tagline or summary uses the suggestion. */
export const Overrides = z
  .strictObject({
    tagline: plainText(90).optional(),
    summary: plainText(900).optional(),
    contribution: plainText(1200),
    highlights: z
      .array(z.strictObject({ featureId: FeatureId, blurb: plainText(140) }))
      .max(4),
    hiddenFeatureIds: z.array(FeatureId).max(500),
  })
  .refine((o) => distinct(o.highlights.map((h) => h.featureId)), "duplicate highlight")
  .refine((o) => distinct(o.hiddenFeatureIds), "duplicate hidden feature")
  .refine(
    (o) => o.highlights.every((h) => !o.hiddenFeatureIds.includes(h.featureId)),
    "a highlighted feature cannot be hidden",
  );
export type Overrides = z.infer<typeof Overrides>;

export const EMPTY_OVERRIDES: Overrides = { contribution: "", highlights: [], hiddenFeatureIds: [] };

/** The review declaration's wording by version; a Review records which one the author accepted. */
export const ATTESTATIONS = {
  1: "I reviewed this version. The contribution statement describes my own work accurately, and I checked the summary and highlights against the project.",
} as const;
export const ATTESTATION_VERSION = 1;
```

- [ ] **Step 7: Write the entities**

`packages/hosted/src/entities.ts`:

```ts
import { GitSha, IsoDateTime, Sha256Hex } from "@repowiki/core";
import { z } from "zod";
import { Facts, Overrides, Suggestions } from "./content.ts";
import { Plan } from "./limits.ts";
import { RefusalCode } from "./refusals.ts";
import { HandleName, HandleState, Slug } from "./urls.ts";

export const Uuid = z.uuidv4();
export const GithubId = z.int().positive();
export const UsdMicros = z.int().nonnegative();
const ObjectKey = z.string().min(1).max(512);
const Ordinal = z.int().positive();
const Count = z.int().nonnegative();

export const Account = z.strictObject({
  id: Uuid,
  githubUserId: GithubId,
  login: z.string().min(1).max(39),
  displayName: z.string().min(1).max(120),
  githubCreatedAt: IsoDateTime,
  plan: Plan,
  status: z.enum(["active", "deleting"]),
  createdAt: IsoDateTime,
});
export type Account = z.infer<typeof Account>;

export const Handle = z
  .strictObject({
    handle: HandleName,
    accountId: Uuid,
    state: HandleState,
    redirectTo: HandleName.nullable(),
    createdAt: IsoDateTime,
  })
  .refine((h) => (h.state === "redirect") === (h.redirectTo !== null), "redirectTo mismatch");
export type Handle = z.infer<typeof Handle>;

export const Repository = z.strictObject({
  githubRepoId: GithubId,
  fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "expected owner/name"),
  visibility: z.enum(["public", "private"]),
  isFork: z.boolean(),
  defaultBranch: z.string().min(1).max(255),
  checkedAt: IsoDateTime,
});
export type Repository = z.infer<typeof Repository>;

export const ProjectState = z.enum(["draft", "published", "withdrawn", "purged"]);
export type ProjectState = z.infer<typeof ProjectState>;
export const WithdrawReason = z.enum(["author", "repository", "operator", "account-deleted"]);
export type WithdrawReason = z.infer<typeof WithdrawReason>;

export const Project = z
  .strictObject({
    id: Uuid,
    accountId: Uuid,
    githubRepoId: GithubId,
    slug: Slug,
    state: ProjectState,
    withdrawReason: WithdrawReason.nullable(),
    withdrawnAt: IsoDateTime.nullable(),
    latestRevision: Count,
    currentVersion: Count,
    createdAt: IsoDateTime,
  })
  .refine((p) => {
    const gone = p.state === "withdrawn" || p.state === "purged";
    return gone === (p.withdrawReason !== null) && gone === (p.withdrawnAt !== null);
  }, "a reason and time exactly when withdrawn or purged")
  .refine((p) => p.state !== "published" || p.currentVersion > 0, "published without a version");
export type Project = z.infer<typeof Project>;

/** The pipeline steps a job reports, in order (§6.1); they drive the progress display only. */
export const JOB_STEPS = [
  "fetch",
  "index",
  "cluster",
  "manifest",
  "write",
  "verify",
  "people",
  "facts",
  "render",
] as const;
export const JobStep = z.enum(JOB_STEPS);
export type JobStep = z.infer<typeof JobStep>;
export const JobKind = z.enum(["generate", "refresh"]);
export type JobKind = z.infer<typeof JobKind>;
export const JobStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z
  .strictObject({
    id: Uuid,
    projectId: Uuid,
    kind: JobKind,
    commitSha: GitSha,
    status: JobStatus,
    step: JobStep.nullable(),
    attempt: z.int().min(1).max(3),
    leaseExpiresAt: IsoDateTime.nullable(),
    estimateUsdMicros: UsdMicros,
    capUsdMicros: UsdMicros,
    spentUsdMicros: UsdMicros,
    refusal: RefusalCode.nullable(),
    createdAt: IsoDateTime,
    startedAt: IsoDateTime.nullable(),
    finishedAt: IsoDateTime.nullable(),
  })
  .refine((j) => (j.status === "failed") === (j.refusal !== null), "a refusal exactly when failed")
  .refine((j) => j.estimateUsdMicros <= j.capUsdMicros, "estimate above cap")
  .refine((j) => j.spentUsdMicros <= j.capUsdMicros, "spend above cap");
export type Job = z.infer<typeof Job>;

export const Generation = z
  .strictObject({
    id: Uuid,
    jobId: Uuid,
    projectId: Uuid,
    commitSha: GitSha,
    exportKey: ObjectKey,
    exportHash: Sha256Hex,
    suggestions: Suggestions,
    facts: Facts,
    engineVersion: z.string().min(1).max(64),
    models: z.array(z.string().min(1).max(128)).min(1),
    spentUsdMicros: UsdMicros,
    createdAt: IsoDateTime,
  })
  .refine(
    (g) => g.suggestions.highlightCandidates.every((id) => g.facts.featureIds.includes(id)),
    "a suggested highlight the wiki does not have",
  );
export type Generation = z.infer<typeof Generation>;

/** Why a revision cannot be reviewed yet (§6.3). */
export const RevisionFlag = z
  .string()
  .regex(
    /^(?:suggestion-changed:(?:tagline|summary|contribution)|(?:highlight|hidden)-missing:[a-z0-9]+(?:-[a-z0-9]+)*)$/,
    "unknown revision flag",
  );
export type RevisionFlag = z.infer<typeof RevisionFlag>;

export const DraftRevision = z.strictObject({
  projectId: Uuid,
  number: Ordinal,
  generationId: Uuid,
  overrides: Overrides,
  flags: z.array(RevisionFlag),
  source: z.enum(["generation", "author"]),
  createdAt: IsoDateTime,
});
export type DraftRevision = z.infer<typeof DraftRevision>;

export const Review = z.strictObject({
  projectId: Uuid,
  revision: Ordinal,
  attestationVersion: z.literal(1),
  createdAt: IsoDateTime,
});
export type Review = z.infer<typeof Review>;

export const Preview = z.strictObject({
  projectId: Uuid,
  revision: Ordinal,
  siteKey: ObjectKey,
  siteHash: Sha256Hex,
  createdAt: IsoDateTime,
});
export type Preview = z.infer<typeof Preview>;

export const Permission = z.enum(["admin", "maintain", "push", "triage", "pull", "none"]);
export type Permission = z.infer<typeof Permission>;

/** What GitHub said about the user and repository at one moment (§7.2). */
export const EligibilityFacts = z.strictObject({
  checkedAt: IsoDateTime,
  githubUserId: GithubId,
  githubRepoId: GithubId,
  fullName: z.string().min(1).max(201),
  visibility: z.enum(["public", "private"]),
  isFork: z.boolean(),
  permission: Permission,
  authoredCommits: z.int().min(0).max(1000),
  indexedFiles: Count.nullable(),
  tokenValid: z.boolean(),
});
export type EligibilityFacts = z.infer<typeof EligibilityFacts>;

export const PublishedVersion = z.strictObject({
  projectId: Uuid,
  version: Ordinal,
  revision: Ordinal,
  siteKey: ObjectKey,
  siteHash: Sha256Hex,
  authorization: EligibilityFacts,
  publishedAt: IsoDateTime,
});
export type PublishedVersion = z.infer<typeof PublishedVersion>;

export const LedgerEntry = z
  .strictObject({
    id: Uuid,
    accountId: Uuid,
    jobId: Uuid,
    kind: z.enum(["reserve", "spend", "release", "quota"]),
    usdMicros: UsdMicros,
    quota: z.enum(["generation", "refresh"]).nullable(),
    createdAt: IsoDateTime,
  })
  .refine((e) => (e.kind === "quota") === (e.quota !== null), "a quota exactly on quota entries");
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** Everything a person can ask to do (§7.1). */
export const ACTIONS = [
  "public.read",
  "repos.list",
  "job.create",
  "job.refresh",
  "job.read",
  "job.cancel",
  "job.retry",
  "draft.read",
  "preview.read",
  "draft.save",
  "draft.review",
  "project.publish",
  "project.unpublish",
  "project.export",
  "project.restore",
  "account.delete",
  "project.takedown",
  "project.reinstate",
] as const;
export const Action = z.enum(ACTIONS);
export type Action = z.infer<typeof Action>;
export const Actor = z.enum(["anonymous", "author", "other", "system", "operator"]);
export type Actor = z.infer<typeof Actor>;

export const AuditEvent = z.strictObject({
  id: Uuid,
  actor: Actor,
  /** A person's action, or a system event such as "job.lease" or "project.purge". */
  action: z.string().regex(/^[a-z]+\.[a-z-]+$/),
  target: z.strictObject({
    entity: z.enum(["account", "handle", "project", "job", "revision", "version"]),
    id: z.string().min(1).max(128),
  }),
  outcome: z.union([z.literal("allowed"), RefusalCode]),
  createdAt: IsoDateTime,
});
export type AuditEvent = z.infer<typeof AuditEvent>;
```

Add to `packages/hosted/src/index.ts`:

```ts
export {
  ATTESTATION_VERSION,
  ATTESTATIONS,
  AuthorFacts,
  EMPTY_OVERRIDES,
  Facts,
  MAX_PARAGRAPHS,
  Overrides,
  plainText,
  Suggestions,
} from "./content.ts";
export {
  Account,
  ACTIONS,
  Action,
  Actor,
  AuditEvent,
  DraftRevision,
  EligibilityFacts,
  GithubId,
  Generation,
  Handle,
  JOB_STEPS,
  Job,
  JobKind,
  JobStatus,
  JobStep,
  LedgerEntry,
  Permission,
  Preview,
  Project,
  ProjectState,
  PublishedVersion,
  Repository,
  Review,
  RevisionFlag,
  UsdMicros,
  Uuid,
  WithdrawReason,
} from "./entities.ts";
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm format && node node_modules/vitest/vitest.mjs run packages/hosted`
Expected: PASS.

- [ ] **Step 9: Check and commit**

```bash
pnpm check
git add packages/hosted
git -c user.email=sean.may101@gmail.com commit -m "feat(hosted): add the entity schemas and the portfolio content model"
```

---

### Task 4: Job transitions (M13.5)

**Files:**
- Create: `packages/hosted/src/jobs.ts`, `packages/hosted/src/jobs.test.ts`
- Modify: `packages/hosted/src/index.ts`

**Interfaces:**
- Consumes: `Job`, `JobKind`, `JobStatus`, `JobStep`, `JOB_STEPS` (Task 3); `REFUSALS`, `RefusalCode`, `PLATFORM`, `Result` (Task 1).
- Produces: `NewJob` (interface: `id`, `projectId`, `kind`, `commitSha`, `estimateUsdMicros`, `capUsdMicros`, `now`), `isTerminal(status)`, `createJob(input, active: Job | null): Result<{ job: Job; created: boolean }>`, `leaseJob(job, now, leaseMs)`, `heartbeatJob(job, step, now, leaseMs)`, `recordSpend(job, usdMicros)`, `succeedJob(job, now)`, `failJob(job, code, now)`, `recoverJob(job, now)`, `retryJob(job)`, `cancelJob(job, now)`; all but `createJob` return `Result<Job>`.

- [ ] **Step 1: Branch**

```bash
git switch -c m13/hosted-jobs
```

- [ ] **Step 2: Write the failing tests**

`packages/hosted/src/jobs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Job, JobStatus } from "./entities.ts";
import {
  cancelJob,
  createJob,
  failJob,
  heartbeatJob,
  leaseJob,
  type NewJob,
  recordSpend,
  recoverJob,
  retryJob,
  succeedJob,
} from "./jobs.ts";
import type { Result } from "./result.ts";
import { aJob, ids, SHA, T0 } from "./test-fixtures.ts";

const T1 = "2026-10-14T12:01:00Z";
const LATER = "2026-10-14T13:00:00Z";
const LEASE = 120_000;
const newJob: NewJob = {
  id: ids.job,
  projectId: ids.project,
  kind: "generate",
  commitSha: SHA,
  estimateUsdMicros: 400_000,
  capUsdMicros: 600_000,
  now: T0,
};
const running = (patch: Partial<Job> = {}) =>
  aJob({ status: "running", step: "fetch", startedAt: T0, leaseExpiresAt: T1, ...patch });
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.value;
};

describe("creating a job (Contract spec §6.1)", () => {
  it("queues attempt 1 with its estimate and cap", () => {
    expect(createJob(newJob, null)).toEqual({ ok: true, value: { job: aJob(), created: true } });
  });

  it("returns the active job for the same kind and commit, and refuses any other", () => {
    const active = running();
    expect(createJob(newJob, active)).toEqual({ ok: true, value: { job: active, created: false } });
    expect(createJob({ ...newJob, kind: "refresh" }, active)).toEqual({
      ok: false,
      code: "job-active",
    });
    expect(createJob({ ...newJob, commitSha: "c".repeat(40) }, active)).toMatchObject({
      code: "job-active",
    });
  });

  it("ignores a finished job passed as active", () => {
    const done = aJob({ status: "succeeded", finishedAt: T0 });
    expect(createJob(newJob, done)).toMatchObject({ ok: true, value: { created: true } });
  });
});

describe("running a job (Contract spec §6.1)", () => {
  it("leases a queued job and extends the lease as its steps advance", () => {
    const leased = value(leaseJob(aJob(), T0, LEASE));
    expect(leased).toEqual(running({ leaseExpiresAt: "2026-10-14T12:02:00.000Z" }));
    const later = value(heartbeatJob(leased, "write", T1, LEASE));
    expect(later).toMatchObject({ step: "write", leaseExpiresAt: "2026-10-14T12:03:00.000Z" });
    expect(heartbeatJob(later, "index", T1, LEASE)).toMatchObject({ code: "invalid-transition" });
    expect(value(heartbeatJob(later, "write", T1, LEASE)).step).toBe("write");
  });

  it("adds spend up to the cap and refuses to pass it", () => {
    const job = running({ spentUsdMicros: 500_000 });
    expect(value(recordSpend(job, 100_000)).spentUsdMicros).toBe(600_000);
    expect(recordSpend(job, 100_001)).toEqual({ ok: false, code: "job-cost-cap" });
    expect(recordSpend(job, -1)).toMatchObject({ code: "invalid-input" });
    expect(recordSpend(job, 0.5)).toMatchObject({ code: "invalid-input" });
  });

  it("succeeds or fails with a code, clearing the lease", () => {
    expect(value(succeedJob(running(), T1))).toMatchObject({
      status: "succeeded",
      finishedAt: T1,
      leaseExpiresAt: null,
    });
    expect(value(failJob(running(), "repo-too-large", T1))).toMatchObject({
      status: "failed",
      refusal: "repo-too-large",
      finishedAt: T1,
      leaseExpiresAt: null,
    });
  });
});

describe("recovering and retrying (Contract spec §6.1)", () => {
  it("requeues a job whose lease expired, up to three attempts", () => {
    expect(recoverJob(running(), T0)).toMatchObject({ code: "invalid-transition" });
    expect(value(recoverJob(running(), LATER))).toMatchObject({
      status: "queued",
      attempt: 2,
      step: null,
      leaseExpiresAt: null,
    });
    expect(value(recoverJob(running({ attempt: 3 }), LATER))).toMatchObject({
      status: "failed",
      refusal: "job-interrupted",
      attempt: 3,
      finishedAt: LATER,
    });
  });

  it("retries only a retryable failure with attempts left, keeping what was spent", () => {
    const failed = aJob({ status: "failed", refusal: "job-failed", spentUsdMicros: 90_000 });
    expect(value(retryJob(failed))).toMatchObject({
      status: "queued",
      attempt: 2,
      refusal: null,
      spentUsdMicros: 90_000,
      finishedAt: null,
    });
    expect(retryJob({ ...failed, attempt: 3 })).toMatchObject({ code: "invalid-transition" });
    expect(retryJob({ ...failed, refusal: "job-cost-cap" })).toMatchObject({
      code: "invalid-transition",
    });
  });

  it("cancels a queued or running job", () => {
    expect(value(cancelJob(aJob(), T1))).toMatchObject({ status: "cancelled", finishedAt: T1 });
    expect(value(cancelJob(running(), T1))).toMatchObject({
      status: "cancelled",
      leaseExpiresAt: null,
    });
  });
});

describe("every (status, event) pair (Contract spec §6.1)", () => {
  const events: Record<string, (job: Job) => Result<Job>> = {
    lease: (j) => leaseJob(j, T0, LEASE),
    heartbeat: (j) => heartbeatJob(j, "fetch", T0, LEASE),
    spend: (j) => recordSpend(j, 1),
    succeed: (j) => succeedJob(j, T1),
    fail: (j) => failJob(j, "job-failed", T1),
    recover: (j) => recoverJob(j, LATER),
    retry: (j) => retryJob(j),
    cancel: (j) => cancelJob(j, T1),
  };
  const allowed: Record<JobStatus, string[]> = {
    queued: ["lease", "cancel"],
    running: ["heartbeat", "spend", "succeed", "fail", "recover", "cancel"],
    succeeded: [],
    failed: ["retry"],
    cancelled: [],
  };
  const sample: Record<JobStatus, Job> = {
    queued: aJob(),
    running: running(),
    succeeded: aJob({ status: "succeeded", finishedAt: T1 }),
    failed: aJob({ status: "failed", refusal: "job-failed", finishedAt: T1 }),
    cancelled: aJob({ status: "cancelled", finishedAt: T1 }),
  };

  for (const status of Object.keys(sample) as JobStatus[]) {
    for (const [event, run] of Object.entries(events)) {
      const expected = allowed[status].includes(event);
      it(`${status} + ${event} → ${expected ? "allowed" : "invalid-transition"}`, () => {
        const result = run(sample[status]);
        if (expected) expect(result.ok).toBe(true);
        else expect(result).toEqual({ ok: false, code: "invalid-transition" });
      });
    }
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/hosted/src/jobs.test.ts`
Expected: FAIL — cannot resolve `./jobs.ts`.

- [ ] **Step 4: Write the implementation**

`packages/hosted/src/jobs.ts`:

```ts
import { JOB_STEPS, type Job, type JobKind, type JobStatus, type JobStep } from "./entities.ts";
import { PLATFORM } from "./limits.ts";
import { type RefusalCode, REFUSALS } from "./refusals.ts";
import { ok, type Result, refused } from "./result.ts";

export interface NewJob {
  id: string;
  projectId: string;
  kind: JobKind;
  commitSha: string;
  estimateUsdMicros: number;
  /** From `jobCap` (§10), computed by the caller with the account's month so far. */
  capUsdMicros: number;
  now: string;
}

export function isTerminal(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

const after = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();
const invalid = () => refused("invalid-transition");

/**
 * A new queued job (§6.1). `active` is the project's non-terminal job, if any: the same kind
 * and commit returns it unchanged (an idempotent retry of the request); anything else is
 * `job-active`.
 */
export function createJob(
  input: NewJob,
  active: Job | null,
): Result<{ job: Job; created: boolean }> {
  if (active !== null && !isTerminal(active.status)) {
    if (active.kind === input.kind && active.commitSha === input.commitSha) {
      return ok({ job: active, created: false });
    }
    return refused("job-active");
  }
  const job: Job = {
    id: input.id,
    projectId: input.projectId,
    kind: input.kind,
    commitSha: input.commitSha,
    status: "queued",
    step: null,
    attempt: 1,
    leaseExpiresAt: null,
    estimateUsdMicros: input.estimateUsdMicros,
    capUsdMicros: input.capUsdMicros,
    spentUsdMicros: 0,
    refusal: null,
    createdAt: input.now,
    startedAt: null,
    finishedAt: null,
  };
  return ok({ job, created: true });
}

/** A worker takes a queued job. */
export function leaseJob(job: Job, now: string, leaseMs: number): Result<Job> {
  if (job.status !== "queued") return invalid();
  return ok({
    ...job,
    status: "running",
    step: "fetch",
    leaseExpiresAt: after(now, leaseMs),
    startedAt: job.startedAt ?? now,
  });
}

/** The worker is alive and at `step`; steps only move forward. */
export function heartbeatJob(job: Job, step: JobStep, now: string, leaseMs: number): Result<Job> {
  if (job.status !== "running") return invalid();
  if (job.step !== null && JOB_STEPS.indexOf(step) < JOB_STEPS.indexOf(job.step)) return invalid();
  return ok({ ...job, step, leaseExpiresAt: after(now, leaseMs) });
}

/** Money the job's model calls cost; the job stops rather than pass its cap. */
export function recordSpend(job: Job, usdMicros: number): Result<Job> {
  if (job.status !== "running") return invalid();
  if (!Number.isInteger(usdMicros) || usdMicros < 0) return refused("invalid-input", "usdMicros");
  if (job.spentUsdMicros + usdMicros > job.capUsdMicros) return refused("job-cost-cap");
  return ok({ ...job, spentUsdMicros: job.spentUsdMicros + usdMicros });
}

export function succeedJob(job: Job, now: string): Result<Job> {
  if (job.status !== "running") return invalid();
  return ok({ ...job, status: "succeeded", leaseExpiresAt: null, finishedAt: now });
}

export function failJob(job: Job, code: RefusalCode, now: string): Result<Job> {
  if (job.status !== "running") return invalid();
  return ok({ ...job, status: "failed", refusal: code, leaseExpiresAt: null, finishedAt: now });
}

/** A running job whose lease ran out goes back on the queue, or fails after its last attempt. */
export function recoverJob(job: Job, now: string): Result<Job> {
  if (job.status !== "running" || job.leaseExpiresAt === null) return invalid();
  if (Date.parse(job.leaseExpiresAt) > Date.parse(now)) return invalid();
  if (job.attempt >= PLATFORM.jobMaxAttempts) {
    return failJob(job, "job-interrupted", now);
  }
  return ok({ ...job, status: "queued", attempt: job.attempt + 1, step: null, leaseExpiresAt: null });
}

/** The author retries a retryable failure; money already spent stays counted against the cap. */
export function retryJob(job: Job): Result<Job> {
  if (job.status !== "failed" || job.refusal === null) return invalid();
  if (!REFUSALS[job.refusal].retryable || job.attempt >= PLATFORM.jobMaxAttempts) return invalid();
  return ok({
    ...job,
    status: "queued",
    attempt: job.attempt + 1,
    step: null,
    refusal: null,
    finishedAt: null,
  });
}

export function cancelJob(job: Job, now: string): Result<Job> {
  if (job.status !== "queued" && job.status !== "running") return invalid();
  return ok({ ...job, status: "cancelled", leaseExpiresAt: null, finishedAt: now });
}
```

Add to `packages/hosted/src/index.ts`:

```ts
export {
  cancelJob,
  createJob,
  failJob,
  heartbeatJob,
  isTerminal,
  leaseJob,
  type NewJob,
  recordSpend,
  recoverJob,
  retryJob,
  succeedJob,
} from "./jobs.ts";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm format && node node_modules/vitest/vitest.mjs run packages/hosted`
Expected: PASS.

- [ ] **Step 6: Check and commit**

```bash
pnpm check
git add packages/hosted
git -c user.email=sean.may101@gmail.com commit -m "feat(hosted): add job transitions with leases, cost caps and bounded retries"
```

---

### Task 5: Project, draft-revision and publish transitions (M13.6)

**Files:**
- Create: `packages/hosted/src/projects.ts`, `packages/hosted/src/projects.test.ts`
- Create: `packages/hosted/src/revisions.ts`, `packages/hosted/src/revisions.test.ts`
- Create: `packages/hosted/src/publish.ts`, `packages/hosted/src/publish.test.ts`
- Modify: `packages/hosted/src/index.ts`

**Interfaces:**
- Consumes: `Project`, `DraftRevision`, `Generation`, `Review`, `Preview`, `PublishedVersion`, `EligibilityFacts` (Task 3); `Overrides`, `EMPTY_OVERRIDES`, `ATTESTATION_VERSION` (Task 3); `siteKey` (Task 2); `PLATFORM`, `DAY_MS`, `Result` (Task 1).
- Produces: `newProject({ id, accountId, githubRepoId, slug, now }): Project`, `unpublish`, `repositoryUnavailable`, `takedown`, `accountDeleted`, `restore`, `purge` (each `(project, now) => Result<Project>`); `firstRevision(project, generation, now)`, `refreshRevision(project, latest, previous, next, now)`, `saveRevision(project, latest, generation, baseRevision, input: unknown, now)` (each `Result<{ project: Project; revision: DraftRevision }>`), `reviewRevision(latest, revision, now): Result<Review>`; `PublishInput`, `publish(input): Result<{ project: Project; version: PublishedVersion; created: boolean }>`.

- [ ] **Step 1: Branch**

```bash
git switch -c m13/hosted-drafts
```

- [ ] **Step 2: Write the failing project tests**

`packages/hosted/src/projects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Project } from "./entities.ts";
import {
  accountDeleted,
  newProject,
  purge,
  repositoryUnavailable,
  restore,
  takedown,
  unpublish,
} from "./projects.ts";
import { aProject, ids, T0 } from "./test-fixtures.ts";

const T1 = "2026-10-20T00:00:00Z";
const DAY29 = "2026-11-12T12:00:00Z";
const DAY31 = "2026-11-14T12:00:00Z";
const published = aProject({ state: "published", currentVersion: 2, latestRevision: 3 });
const withdrawn = (reason: Project["withdrawReason"], patch: Partial<Project> = {}) =>
  aProject({ state: "withdrawn", withdrawReason: reason, withdrawnAt: T0, ...patch });

describe("projects (Contract spec §6.2)", () => {
  it("start as drafts", () => {
    const input = { id: ids.project, accountId: ids.account, githubRepoId: 202, slug: "repowiki" };
    expect(newProject({ ...input, now: T0 })).toEqual(aProject());
  });

  it("withdraw by the author only from published", () => {
    expect(unpublish(published, T1)).toEqual({
      ok: true,
      value: { ...published, state: "withdrawn", withdrawReason: "author", withdrawnAt: T1 },
    });
    expect(unpublish(aProject(), T1)).toMatchObject({ code: "invalid-transition" });
    expect(unpublish(withdrawn("author"), T1)).toMatchObject({ code: "invalid-transition" });
  });

  it("withdraw for the repository or an operator from draft or published", () => {
    for (const p of [aProject(), published]) {
      expect(repositoryUnavailable(p, T1)).toMatchObject({
        ok: true,
        value: { state: "withdrawn", withdrawReason: "repository", withdrawnAt: T1 },
      });
      expect(takedown(p, T1)).toMatchObject({ value: { withdrawReason: "operator" } });
    }
    expect(repositoryUnavailable(withdrawn("author"), T1)).toMatchObject({
      code: "invalid-transition",
    });
  });

  it("withdraw everything but purged projects when the account is deleted", () => {
    expect(accountDeleted(withdrawn("author"), T1)).toMatchObject({
      value: { withdrawReason: "account-deleted", withdrawnAt: T1 },
    });
    const purged = withdrawn("repository", { state: "purged" });
    expect(accountDeleted(purged, T1)).toMatchObject({ code: "invalid-transition" });
  });

  it("restore a repository withdrawal within 30 days to where it was", () => {
    const wasPublished = withdrawn("repository", { currentVersion: 2 });
    expect(restore(wasPublished, DAY29)).toMatchObject({
      value: { state: "published", withdrawReason: null, withdrawnAt: null },
    });
    expect(restore(withdrawn("repository"), DAY29)).toMatchObject({ value: { state: "draft" } });
    expect(restore(wasPublished, DAY31)).toEqual({ ok: false, code: "restore-expired" });
    expect(restore(withdrawn("author"), DAY29)).toMatchObject({ code: "invalid-transition" });
    expect(restore(withdrawn("operator"), DAY29)).toMatchObject({ code: "invalid-transition" });
  });

  it("purge repository and account withdrawals after 30 days, keeping the tombstone", () => {
    expect(purge(withdrawn("repository"), DAY29)).toMatchObject({ code: "invalid-transition" });
    expect(purge(withdrawn("repository"), DAY31)).toMatchObject({
      value: { state: "purged", withdrawReason: "repository", slug: "repowiki" },
    });
    expect(purge(withdrawn("account-deleted"), DAY31)).toMatchObject({ ok: true });
    expect(purge(withdrawn("author"), DAY31)).toMatchObject({ code: "invalid-transition" });
  });
});
```

- [ ] **Step 3: Write the failing revision tests**

`packages/hosted/src/revisions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EMPTY_OVERRIDES, type Overrides } from "./content.ts";
import type { Result } from "./result.ts";
import { firstRevision, refreshRevision, reviewRevision, saveRevision } from "./revisions.ts";
import { aGeneration, aProject, aRevision, aReview, ids, T0 } from "./test-fixtures.ts";

const T1 = "2026-10-15T00:00:00Z";
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.value;
};
const edited: Overrides = {
  tagline: "My tagline",
  summary: "My summary",
  contribution: "I wrote it.",
  highlights: [{ featureId: "indexing", blurb: "Fast" }],
  hiddenFeatureIds: ["site"],
};

describe("draft revisions (Contract spec §6.3)", () => {
  it("start at revision 1 with empty overrides when the first generation lands", () => {
    expect(firstRevision(aProject(), aGeneration(), T0)).toEqual({
      ok: true,
      value: { project: aProject({ latestRevision: 1 }), revision: aRevision() },
    });
    expect(firstRevision(aProject({ latestRevision: 1 }), aGeneration(), T0)).toMatchObject({
      code: "invalid-transition",
    });
  });

  it("save the author's overrides as a new revision against the latest one only", () => {
    const project = aProject({ latestRevision: 1 });
    const saved = value(saveRevision(project, aRevision(), aGeneration(), 1, edited, T1));
    expect(saved.project.latestRevision).toBe(2);
    expect(saved.revision).toEqual(
      aRevision({ number: 2, overrides: edited, source: "author", createdAt: T1 }),
    );
    expect(saveRevision(project, aRevision(), aGeneration(), 0, edited, T1)).toEqual({
      ok: false,
      code: "stale-revision",
    });
  });

  it("refuse invalid overrides and features the wiki does not have", () => {
    const project = aProject({ latestRevision: 1 });
    expect(
      saveRevision(project, aRevision(), aGeneration(), 1, { ...edited, tagline: "<b>" }, T1),
    ).toMatchObject({ code: "invalid-input" });
    const unknown = { ...edited, hiddenFeatureIds: ["nowhere"] };
    expect(saveRevision(project, aRevision(), aGeneration(), 1, unknown, T1)).toMatchObject({
      code: "invalid-input",
      detail: "unknown feature nowhere",
    });
  });

  it("carry overrides through a refresh and flag what changed under them", () => {
    const project = aProject({ latestRevision: 2 });
    const latest = aRevision({ number: 2, overrides: edited, source: "author" });
    const previous = aGeneration();
    const next = aGeneration({
      id: ids.generation2,
      suggestions: { ...previous.suggestions, summary: "A new summary." },
      facts: { ...previous.facts, featureIds: ["verify", "site"] },
    });
    const refreshed = value(refreshRevision(project, latest, previous, next, T1));
    expect(refreshed.project.latestRevision).toBe(3);
    expect(refreshed.revision).toEqual(
      aRevision({
        number: 3,
        generationId: ids.generation2,
        overrides: edited,
        flags: ["suggestion-changed:summary", "highlight-missing:indexing"],
        source: "generation",
        createdAt: T1,
      }),
    );
  });

  it("raise no flag for a suggestion the author did not override, and keep old flags", () => {
    const project = aProject({ latestRevision: 1 });
    const latest = aRevision({ flags: ["hidden-missing:old"] });
    const previous = aGeneration();
    const next = aGeneration({
      id: ids.generation2,
      suggestions: { ...previous.suggestions, tagline: "Changed", contributionDraft: "Changed" },
    });
    expect(value(refreshRevision(project, latest, previous, next, T1)).revision.flags).toEqual([
      "hidden-missing:old",
    ]);
  });

  it("refuse a refresh that does not build on the latest revision's generation", () => {
    const project = aProject({ latestRevision: 1 });
    const other = aGeneration({ id: ids.generation2 });
    expect(refreshRevision(project, aRevision(), other, other, T1)).toMatchObject({
      code: "invalid-transition",
    });
    expect(
      refreshRevision(aProject({ latestRevision: 2 }), aRevision(), aGeneration(), other, T1),
    ).toMatchObject({ code: "stale-revision" });
  });

  it("review only the latest unflagged revision with a contribution statement", () => {
    const ready = aRevision({ overrides: { ...EMPTY_OVERRIDES, contribution: "I wrote it." } });
    expect(reviewRevision(ready, 1, T0)).toEqual({ ok: true, value: aReview() });
    expect(reviewRevision(ready, 2, T0)).toEqual({ ok: false, code: "stale-revision" });
    expect(reviewRevision({ ...ready, flags: ["hidden-missing:x"] }, 1, T0)).toMatchObject({
      code: "needs-review-flags",
    });
    expect(reviewRevision(aRevision(), 1, T0)).toMatchObject({ code: "contribution-missing" });
    const blank = aRevision({ overrides: { ...EMPTY_OVERRIDES, contribution: "  \n " } });
    expect(reviewRevision(blank, 1, T0)).toMatchObject({ code: "contribution-missing" });
  });
});
```

- [ ] **Step 4: Write the failing publish tests**

`packages/hosted/src/publish.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EMPTY_OVERRIDES } from "./content.ts";
import { type PublishInput, publish } from "./publish.ts";
import {
  aPreview,
  aProject,
  aPublishedVersion,
  aReview,
  aRevision,
  eligibleFacts,
  HASH,
  ids,
  T0,
} from "./test-fixtures.ts";

const T1 = "2026-10-15T00:00:00Z";
const ready = aRevision({ overrides: { ...EMPTY_OVERRIDES, contribution: "I wrote it." } });
const input = (patch: Partial<PublishInput> = {}): PublishInput => ({
  project: aProject({ latestRevision: 1 }),
  latest: ready,
  review: aReview(),
  preview: aPreview(),
  current: null,
  revision: 1,
  expectedVersion: 0,
  previewHash: HASH,
  authorization: eligibleFacts({ checkedAt: T1 }),
  now: T1,
  ...patch,
});

describe("publish (Contract spec §6.4)", () => {
  it("creates version 1 from the previewed bytes with the eligibility snapshot", () => {
    expect(publish(input())).toEqual({
      ok: true,
      value: {
        project: aProject({ latestRevision: 1, state: "published", currentVersion: 1 }),
        version: aPublishedVersion({
          authorization: eligibleFacts({ checkedAt: T1 }),
          publishedAt: T1,
        }),
        created: true,
      },
    });
  });

  it("republishes an author-withdrawn project at the next version", () => {
    const project = aProject({
      latestRevision: 1,
      state: "withdrawn",
      withdrawReason: "author",
      withdrawnAt: T0,
      currentVersion: 1,
    });
    const result = publish(input({ project, expectedVersion: 1 }));
    expect(result).toMatchObject({
      ok: true,
      value: {
        project: { state: "published", currentVersion: 2, withdrawReason: null, withdrawnAt: null },
        version: { version: 2, siteKey: `sites/${ids.project}/v2/` },
      },
    });
  });

  it("is a no-op for the revision that is already current", () => {
    const project = aProject({ latestRevision: 1, state: "published", currentVersion: 1 });
    const current = aPublishedVersion();
    expect(publish(input({ project, current, expectedVersion: 1 }))).toEqual({
      ok: true,
      value: { project, version: current, created: false },
    });
  });

  it("refuses each failed condition on its own", () => {
    expect(publish(input({ revision: 2 }))).toMatchObject({ code: "stale-revision" });
    expect(publish(input({ latest: { ...ready, flags: ["hidden-missing:x"] } }))).toMatchObject({
      code: "needs-review-flags",
    });
    expect(publish(input({ latest: aRevision() }))).toMatchObject({
      code: "contribution-missing",
    });
    expect(publish(input({ review: null }))).toMatchObject({ code: "not-reviewed" });
    expect(publish(input({ review: aReview({ revision: 2 }) }))).toMatchObject({
      code: "not-reviewed",
    });
    expect(publish(input({ expectedVersion: 1 }))).toMatchObject({ code: "stale-publication" });
    expect(publish(input({ preview: null }))).toMatchObject({ code: "preview-mismatch" });
    expect(publish(input({ previewHash: "c".repeat(64) }))).toMatchObject({
      code: "preview-mismatch",
    });
    expect(publish(input({ preview: aPreview({ revision: 2 }) }))).toMatchObject({
      code: "preview-mismatch",
    });
  });

  it("refuses an eligibility check for another repository or user", () => {
    const project = aProject({ latestRevision: 1 });
    expect(
      publish(input({ project, authorization: eligibleFacts({ githubRepoId: 999 }) })),
    ).toMatchObject({ code: "invalid-input", detail: "authorization is for another repository" });
  });

  it("refuses a project withdrawn for any reason but the author's, or purged", () => {
    for (const withdrawReason of ["repository", "operator", "account-deleted"] as const) {
      const project = aProject({
        latestRevision: 1,
        state: "withdrawn",
        withdrawReason,
        withdrawnAt: T0,
      });
      expect(publish(input({ project }))).toMatchObject({ code: "invalid-transition" });
    }
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/hosted`
Expected: FAIL — cannot resolve `./projects.ts`, `./revisions.ts`, `./publish.ts`.

- [ ] **Step 6: Write the implementation**

`packages/hosted/src/projects.ts`:

```ts
import type { Project, WithdrawReason } from "./entities.ts";
import { DAY_MS, PLATFORM } from "./limits.ts";
import { ok, type Result, refused } from "./result.ts";

export interface NewProject {
  id: string;
  accountId: string;
  githubRepoId: number;
  slug: string;
  now: string;
}

export function newProject(input: NewProject): Project {
  return {
    id: input.id,
    accountId: input.accountId,
    githubRepoId: input.githubRepoId,
    slug: input.slug,
    state: "draft",
    withdrawReason: null,
    withdrawnAt: null,
    latestRevision: 0,
    currentVersion: 0,
    createdAt: input.now,
  };
}

const invalid = () => refused("invalid-transition");
const live = (p: Project) => p.state === "draft" || p.state === "published";
const withdraw = (p: Project, reason: WithdrawReason, now: string): Result<Project> =>
  ok({ ...p, state: "withdrawn", withdrawReason: reason, withdrawnAt: now });
const graceOver = (p: Project, now: string) =>
  p.withdrawnAt !== null &&
  Date.parse(now) - Date.parse(p.withdrawnAt) > PLATFORM.repositoryGraceDays * DAY_MS;

/** The author takes their page down; the URL answers 410 and stays theirs. */
export function unpublish(project: Project, now: string): Result<Project> {
  return project.state === "published" ? withdraw(project, "author", now) : invalid();
}

/** The daily check found the repository private, deleted or a fork. */
export function repositoryUnavailable(project: Project, now: string): Result<Project> {
  return live(project) ? withdraw(project, "repository", now) : invalid();
}

export function takedown(project: Project, now: string): Result<Project> {
  return live(project) ? withdraw(project, "operator", now) : invalid();
}

/** Account deletion withdraws every page at once and starts the 30-day purge clock. */
export function accountDeleted(project: Project, now: string): Result<Project> {
  return project.state === "purged" ? invalid() : withdraw(project, "account-deleted", now);
}

/** The repository is eligible again within the grace period: back to where it was. */
export function restore(project: Project, now: string): Result<Project> {
  if (project.state !== "withdrawn" || project.withdrawReason !== "repository") return invalid();
  if (graceOver(project, now)) return refused("restore-expired");
  return ok({
    ...project,
    state: project.currentVersion > 0 ? "published" : "draft",
    withdrawReason: null,
    withdrawnAt: null,
  });
}

/** Delete everything derived from source; the row and slug remain as a tombstone. */
export function purge(project: Project, now: string): Result<Project> {
  const purgeable =
    project.state === "withdrawn" &&
    (project.withdrawReason === "repository" || project.withdrawReason === "account-deleted");
  return purgeable && graceOver(project, now) ? ok({ ...project, state: "purged" }) : invalid();
}
```

`packages/hosted/src/revisions.ts`:

```ts
import { ATTESTATION_VERSION, EMPTY_OVERRIDES, Overrides } from "./content.ts";
import type { DraftRevision, Generation, Project, Review } from "./entities.ts";
import { ok, type Result, refused } from "./result.ts";

type Revised = Result<{ project: Project; revision: DraftRevision }>;

const next = (project: Project, revision: DraftRevision): Revised =>
  ok({ project: { ...project, latestRevision: revision.number }, revision });

/** Revision 1, when a project's first generation lands (§6.3). */
export function firstRevision(project: Project, generation: Generation, now: string): Revised {
  if (project.latestRevision !== 0) return refused("invalid-transition");
  return next(project, {
    projectId: project.id,
    number: 1,
    generationId: generation.id,
    overrides: EMPTY_OVERRIDES,
    flags: [],
    source: "generation",
    createdAt: now,
  });
}

/**
 * A refresh landed: the latest overrides carry forward onto the new generation, flagged where
 * the generated text under an override changed or a chosen feature disappeared (§6.3).
 */
export function refreshRevision(
  project: Project,
  latest: DraftRevision,
  previous: Generation,
  generation: Generation,
  now: string,
): Revised {
  if (latest.number !== project.latestRevision) return refused("stale-revision");
  if (latest.generationId !== previous.id) return refused("invalid-transition");
  const { overrides } = latest;
  const was = previous.suggestions;
  const is = generation.suggestions;
  const features = new Set(generation.facts.featureIds);
  const flags = [
    ...latest.flags,
    ...(overrides.tagline !== undefined && was.tagline !== is.tagline
      ? ["suggestion-changed:tagline"]
      : []),
    ...(overrides.summary !== undefined && was.summary !== is.summary
      ? ["suggestion-changed:summary"]
      : []),
    ...(overrides.contribution !== "" && was.contributionDraft !== is.contributionDraft
      ? ["suggestion-changed:contribution"]
      : []),
    ...overrides.highlights
      .filter((h) => !features.has(h.featureId))
      .map((h) => `highlight-missing:${h.featureId}`),
    ...overrides.hiddenFeatureIds
      .filter((id) => !features.has(id))
      .map((id) => `hidden-missing:${id}`),
  ];
  return next(project, {
    projectId: project.id,
    number: latest.number + 1,
    generationId: generation.id,
    overrides,
    flags: [...new Set(flags)],
    source: "generation",
    createdAt: now,
  });
}

/** The author saves overrides made against `baseRevision`; saving clears every flag (§6.3). */
export function saveRevision(
  project: Project,
  latest: DraftRevision,
  generation: Generation,
  baseRevision: number,
  input: unknown,
  now: string,
): Revised {
  if (baseRevision !== latest.number || latest.number !== project.latestRevision) {
    return refused("stale-revision");
  }
  if (generation.id !== latest.generationId) return refused("invalid-transition");
  const parsed = Overrides.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refused("invalid-input", `${issue?.path.join(".") || "overrides"}: ${issue?.message}`);
  }
  const features = new Set(generation.facts.featureIds);
  const chosen = [
    ...parsed.data.highlights.map((h) => h.featureId),
    ...parsed.data.hiddenFeatureIds,
  ];
  const unknown = chosen.find((id) => !features.has(id));
  if (unknown !== undefined) return refused("invalid-input", `unknown feature ${unknown}`);
  return next(project, {
    projectId: project.id,
    number: latest.number + 1,
    generationId: latest.generationId,
    overrides: parsed.data,
    flags: [],
    source: "author",
    createdAt: now,
  });
}

/** The author attests to exactly the latest revision (§6.3, §8). */
export function reviewRevision(latest: DraftRevision, revision: number, now: string): Result<Review> {
  if (revision !== latest.number) return refused("stale-revision");
  if (latest.flags.length > 0) return refused("needs-review-flags");
  if (latest.overrides.contribution.trim() === "") return refused("contribution-missing");
  return ok({
    projectId: latest.projectId,
    revision,
    attestationVersion: ATTESTATION_VERSION,
    createdAt: now,
  });
}
```

`packages/hosted/src/publish.ts`:

```ts
import type {
  DraftRevision,
  EligibilityFacts,
  Preview,
  Project,
  PublishedVersion,
  Review,
} from "./entities.ts";
import { ok, type Result, refused } from "./result.ts";
import { siteKey } from "./urls.ts";

export interface PublishInput {
  project: Project;
  /** The project's latest revision. */
  latest: DraftRevision;
  /** The review of the revision being published, if any. */
  review: Review | null;
  /** The stored preview of the revision being published, if any. */
  preview: Preview | null;
  /** The project's current published version, if any. */
  current: PublishedVersion | null;
  /** What the author asked to publish, the version they saw, and the preview they saw. */
  revision: number;
  expectedVersion: number;
  previewHash: string;
  /** The live eligibility check the policy accepted (§7). */
  authorization: EligibilityFacts;
  now: string;
}

/**
 * Promote the exact previewed site of a reviewed revision to the next published version (§6.4).
 * Authorization is the policy's job and comes first; this checks the draft, version and bytes.
 */
export function publish(
  input: PublishInput,
): Result<{ project: Project; version: PublishedVersion; created: boolean }> {
  const { project, latest, review, preview, current, revision } = input;
  const republish = project.state === "withdrawn" && project.withdrawReason === "author";
  if (project.state !== "draft" && project.state !== "published" && !republish) {
    return refused("invalid-transition");
  }
  if (input.authorization.githubRepoId !== project.githubRepoId) {
    return refused("invalid-input", "authorization is for another repository");
  }
  if (
    project.state === "published" &&
    current !== null &&
    current.version === project.currentVersion &&
    current.revision === revision
  ) {
    return ok({ project, version: current, created: false });
  }
  if (revision !== latest.number || latest.number !== project.latestRevision) {
    return refused("stale-revision");
  }
  if (latest.flags.length > 0) return refused("needs-review-flags");
  if (latest.overrides.contribution.trim() === "") return refused("contribution-missing");
  if (review === null || review.revision !== revision) return refused("not-reviewed");
  if (input.expectedVersion !== project.currentVersion) return refused("stale-publication");
  if (preview === null || preview.revision !== revision || preview.siteHash !== input.previewHash) {
    return refused("preview-mismatch");
  }
  const number = project.currentVersion + 1;
  const version: PublishedVersion = {
    projectId: project.id,
    version: number,
    revision,
    siteKey: siteKey(project.id, number),
    siteHash: preview.siteHash,
    authorization: input.authorization,
    publishedAt: input.now,
  };
  return ok({
    project: {
      ...project,
      state: "published",
      withdrawReason: null,
      withdrawnAt: null,
      currentVersion: number,
    },
    version,
    created: true,
  });
}
```

Add to `packages/hosted/src/index.ts`:

```ts
export {
  accountDeleted,
  type NewProject,
  newProject,
  purge,
  repositoryUnavailable,
  restore,
  takedown,
  unpublish,
} from "./projects.ts";
export { type PublishInput, publish } from "./publish.ts";
export { firstRevision, refreshRevision, reviewRevision, saveRevision } from "./revisions.ts";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm format && node node_modules/vitest/vitest.mjs run packages/hosted`
Expected: PASS.

- [ ] **Step 8: Check and commit**

```bash
pnpm check
git add packages/hosted
git -c user.email=sean.may101@gmail.com commit -m "feat(hosted): add project, draft-revision and publish transitions"
```

---

### Task 6: Authorization policy and eligibility (M13.7)

**Files:**
- Create: `packages/hosted/src/policy.ts`, `packages/hosted/src/policy.test.ts`
- Modify: `packages/hosted/src/index.ts`

**Interfaces:**
- Consumes: `Account`, `Action`, `ACTIONS`, `EligibilityFacts`, `Project` (Task 3); `PLANS`, `PLATFORM`, `DAY_MS`, `isFrozen`, `jobCap`, `Result` (Task 1).
- Produces: `Caller` (`{ kind: "anonymous" } | { kind: "account"; account: Account } | { kind: "system" } | { kind: "operator" }`), `Usage` (`activeProjects`, `generationsLifetime`, `generationsThisMonth`, `refreshesThisMonth`, `monthUsdMicros`, `platformDayUsdMicros`), `PolicyContext`, `checkEligibility(facts, now, maxAgeMs): Result<EligibilityFacts>`, `authorize(action, ctx): Result<true>`.

- [ ] **Step 1: Branch**

```bash
git switch -c m13/hosted-policy
```

- [ ] **Step 2: Write the failing tests**

`packages/hosted/src/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ACTIONS, type Action } from "./entities.ts";
import { authorize, type Caller, checkEligibility, type PolicyContext, type Usage } from "./policy.ts";
import { anAccount, aProject, eligibleFacts, ids, T0 } from "./test-fixtures.ts";

const NOW = "2026-10-14T12:00:30Z";
const free = anAccount();
const pro = anAccount({ plan: "pro" });
const usage = (patch: Partial<Usage> = {}): Usage => ({
  activeProjects: 0,
  generationsLifetime: 0,
  generationsThisMonth: 0,
  refreshesThisMonth: 0,
  monthUsdMicros: 0,
  platformDayUsdMicros: 0,
  ...patch,
});
const signedIn = (account = free): Caller => ({ kind: "account", account });
const ctx = (patch: Partial<PolicyContext> = {}): PolicyContext => ({
  now: NOW,
  caller: signedIn(),
  ownerId: ids.account,
  facts: eligibleFacts(),
  usage: usage({ activeProjects: 1 }),
  estimateUsdMicros: 400_000,
  ...patch,
});

describe("eligibility (Contract spec §7.2)", () => {
  it("accepts a fresh check of a public, unforked repository the user pushes and committed to", () => {
    expect(checkEligibility(eligibleFacts(), NOW, 60_000)).toEqual({
      ok: true,
      value: eligibleFacts(),
    });
    for (const permission of ["admin", "maintain", "push"] as const) {
      expect(checkEligibility(eligibleFacts({ permission }), NOW, 60_000).ok).toBe(true);
    }
  });

  it("refuses with the first failing condition, in the spec's order", () => {
    const all = eligibleFacts({
      tokenValid: false,
      visibility: "private",
      isFork: true,
      permission: "pull",
      authoredCommits: 0,
    });
    expect(checkEligibility(all, NOW, 60_000)).toMatchObject({ code: "github-token-revoked" });
    expect(checkEligibility({ ...all, tokenValid: true }, NOW, 60_000)).toMatchObject({
      code: "repo-private",
    });
    const pub = { ...all, tokenValid: true, visibility: "public" as const };
    expect(checkEligibility(pub, NOW, 60_000)).toMatchObject({ code: "repo-fork" });
    expect(checkEligibility({ ...pub, isFork: false }, NOW, 60_000)).toMatchObject({
      code: "repo-no-push",
    });
    for (const permission of ["triage", "pull", "none"] as const) {
      expect(checkEligibility(eligibleFacts({ permission }), NOW, 60_000)).toMatchObject({
        code: "repo-no-push",
      });
    }
    expect(checkEligibility(eligibleFacts({ authoredCommits: 0 }), NOW, 60_000)).toMatchObject({
      code: "repo-no-commits",
    });
  });

  it("refuses a missing or stale check", () => {
    expect(checkEligibility(null, NOW, 60_000)).toMatchObject({ code: "invalid-input" });
    expect(checkEligibility(eligibleFacts(), "2026-10-14T12:01:01Z", 60_000)).toMatchObject({
      code: "invalid-input",
      detail: "eligibility check is stale",
    });
  });
});

describe("who may do what (Contract spec §7.1)", () => {
  const OWNER_ACTIONS: Action[] = [
    "job.refresh",
    "job.read",
    "job.cancel",
    "job.retry",
    "draft.read",
    "preview.read",
    "draft.save",
    "draft.review",
    "project.publish",
    "project.unpublish",
    "project.export",
    "project.restore",
  ];

  it("lets an anonymous reader only read public pages", () => {
    for (const action of ACTIONS.filter((a) => a !== "public.read")) {
      const operatorOnly = action === "project.takedown" || action === "project.reinstate";
      const expected = operatorOnly ? "not-found" : "not-signed-in";
      expect(authorize(action, ctx({ caller: { kind: "anonymous" } })), action).toMatchObject({
        code: expected,
      });
    }
  });

  it("answers not-found for another account's resources", () => {
    for (const action of OWNER_ACTIONS) {
      expect(authorize(action, ctx({ ownerId: ids.other })), action).toEqual({
        ok: false,
        code: "not-found",
      });
    }
  });

  it("lets the system and the operator do only their own things", () => {
    for (const action of ACTIONS.filter((a) => a !== "public.read")) {
      expect(authorize(action, ctx({ caller: { kind: "system" } })), action).toMatchObject({
        code: "not-found",
      });
    }
    expect(authorize("project.takedown", ctx({ caller: { kind: "operator" } })).ok).toBe(true);
    expect(authorize("project.reinstate", ctx({ caller: { kind: "operator" } })).ok).toBe(true);
    expect(authorize("project.takedown", ctx())).toMatchObject({ code: "not-found" });
  });

  it("refuses everything but public reads for an account being deleted", () => {
    const deleting = signedIn(anAccount({ status: "deleting" }));
    for (const action of ["repos.list", "job.read", "project.export"] as const) {
      expect(authorize(action, ctx({ caller: deleting })), action).toMatchObject({
        code: "account-deleting",
      });
    }
  });

  it("always lets the owner read, cancel, unpublish and export, even when frozen", () => {
    const frozen = ctx({ usage: usage({ activeProjects: 2 }), facts: null });
    for (const action of ["job.read", "job.cancel", "draft.read", "preview.read"] as const) {
      expect(authorize(action, frozen), action).toEqual({ ok: true, value: true });
    }
    expect(authorize("project.unpublish", frozen).ok).toBe(true);
    expect(authorize("project.export", frozen).ok).toBe(true);
    expect(authorize("account.delete", frozen).ok).toBe(true);
    expect(authorize("repos.list", frozen).ok).toBe(true);
  });
});

describe("public pages (Contract spec §7.1, C10)", () => {
  const read = (patch: Partial<PolicyContext>) =>
    authorize("public.read", ctx({ caller: { kind: "anonymous" }, ownerStatus: "active", ...patch }));

  it("show a published project of an active account", () => {
    expect(read({ project: aProject({ state: "published", currentVersion: 1 }) }).ok).toBe(true);
  });

  it("answer 404 for a draft and 410 once withdrawn, purged or deleting", () => {
    expect(read({ project: aProject() })).toMatchObject({ code: "not-found" });
    const gone = aProject({ state: "withdrawn", withdrawReason: "author", withdrawnAt: T0 });
    expect(read({ project: gone })).toMatchObject({ code: "withdrawn" });
    expect(read({ project: { ...gone, state: "purged" } })).toMatchObject({ code: "withdrawn" });
    const live = aProject({ state: "published", currentVersion: 1 });
    expect(read({ project: live, ownerStatus: "deleting" })).toMatchObject({ code: "withdrawn" });
  });
});

describe("starting a generation (Contract spec §7.1, §10)", () => {
  const create = (patch: Partial<PolicyContext>) =>
    authorize("job.create", ctx({ usage: usage(), ...patch }));

  it("allows a first project on Free", () => {
    expect(create({})).toEqual({ ok: true, value: true });
  });

  it("refuses a stale check, ineligibility, a new GitHub account and a full plan", () => {
    expect(create({ now: "2026-10-14T12:01:01Z" })).toMatchObject({ code: "invalid-input" });
    expect(create({ facts: eligibleFacts({ isFork: true }) })).toMatchObject({ code: "repo-fork" });
    const young = signedIn(anAccount({ githubCreatedAt: "2026-09-20T00:00:00Z" }));
    expect(create({ caller: young })).toMatchObject({ code: "account-too-new" });
    expect(create({ caller: signedIn(anAccount({ plan: "pro", githubCreatedAt: T0 })) }).ok).toBe(true);
    expect(create({ usage: usage({ activeProjects: 1 }) })).toMatchObject({
      code: "plan-project-limit",
    });
    expect(create({ usage: usage({ generationsLifetime: 1 }) })).toMatchObject({
      code: "plan-generation-limit",
    });
    const proMonth = usage({ activeProjects: 3, generationsThisMonth: 10 });
    expect(create({ caller: signedIn(pro), usage: proMonth })).toMatchObject({
      code: "plan-generation-limit",
    });
    expect(create({ caller: signedIn(pro), usage: usage({ generationsLifetime: 50 }) }).ok).toBe(true);
  });

  it("refuses an oversized repository, a paused platform and a busted monthly ceiling", () => {
    expect(create({ facts: eligibleFacts({ indexedFiles: 1001 }) })).toMatchObject({
      code: "repo-too-large",
    });
    expect(create({ facts: eligibleFacts({ indexedFiles: null }) }).ok).toBe(true);
    expect(create({ caller: signedIn(pro), facts: eligibleFacts({ indexedFiles: 3000 }) }).ok).toBe(true);
    expect(create({ usage: usage({ platformDayUsdMicros: 25_000_000 }) })).toMatchObject({
      code: "platform-paused",
    });
    const proPaused = usage({ platformDayUsdMicros: 25_000_000 });
    expect(create({ caller: signedIn(pro), usage: proPaused }).ok).toBe(true);
    expect(create({ estimateUsdMicros: 1_000_001 })).toMatchObject({
      code: "monthly-cost-ceiling",
    });
    const spent = usage({ monthUsdMicros: 3_800_000 });
    expect(create({ caller: signedIn(pro), usage: spent, estimateUsdMicros: 300_000 })).toMatchObject({
      code: "monthly-cost-ceiling",
    });
  });
});

describe("refreshing, editing, publishing and restoring (Contract spec §7.1, C7, C9)", () => {
  it("refreshes only on a plan with refreshes left", () => {
    expect(authorize("job.refresh", ctx())).toMatchObject({ code: "plan-refresh-limit" });
    expect(authorize("job.refresh", ctx({ caller: signedIn(pro) }))).toEqual({ ok: true, value: true });
    const used = usage({ activeProjects: 1, refreshesThisMonth: 30 });
    expect(authorize("job.refresh", ctx({ caller: signedIn(pro), usage: used }))).toMatchObject({
      code: "plan-refresh-limit",
    });
    const big = eligibleFacts({ indexedFiles: 3001 });
    expect(authorize("job.refresh", ctx({ caller: signedIn(pro), facts: big }))).toMatchObject({
      code: "repo-too-large",
    });
  });

  it("freezes refresh, save, review and publish when the plan is over its project count", () => {
    const over = ctx({ caller: signedIn(pro), usage: usage({ activeProjects: 11 }) });
    for (const action of ["job.refresh", "draft.save", "draft.review", "project.publish"] as const) {
      expect(authorize(action, over), action).toMatchObject({ code: "frozen" });
    }
  });

  it("accepts an hour-old check for saving and reviewing but not for publishing", () => {
    const later = ctx({ now: "2026-10-14T12:59:00Z" });
    expect(authorize("draft.save", later).ok).toBe(true);
    expect(authorize("draft.review", later).ok).toBe(true);
    expect(authorize("project.publish", later)).toMatchObject({ code: "invalid-input" });
    expect(authorize("draft.save", ctx({ now: "2026-10-14T13:00:01Z" }))).toMatchObject({
      code: "invalid-input",
    });
    expect(authorize("draft.save", ctx({ facts: eligibleFacts({ permission: "pull" }) }))).toMatchObject({
      code: "repo-no-push",
    });
  });

  it("refuses a republish or restore that would push the plan over its project count", () => {
    const withdrawn = aProject({ state: "withdrawn", withdrawReason: "author", withdrawnAt: T0 });
    expect(authorize("project.publish", ctx({ project: withdrawn }))).toMatchObject({
      code: "plan-project-limit",
    });
    expect(
      authorize("project.publish", ctx({ project: withdrawn, usage: usage({ activeProjects: 0 }) }))
        .ok,
    ).toBe(true);
    expect(authorize("project.publish", ctx({ project: aProject() })).ok).toBe(true);
    const unavailable = { ...withdrawn, withdrawReason: "repository" as const };
    expect(authorize("project.restore", ctx({ project: unavailable }))).toMatchObject({
      code: "plan-project-limit",
    });
    expect(
      authorize("project.restore", ctx({ project: unavailable, usage: usage({ activeProjects: 0 }) }))
        .ok,
    ).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/hosted/src/policy.test.ts`
Expected: FAIL — cannot resolve `./policy.ts`.

- [ ] **Step 4: Write the implementation**

`packages/hosted/src/policy.ts`:

```ts
import type { Account, Action, EligibilityFacts, Project } from "./entities.ts";
import { DAY_MS, isFrozen, jobCap, PLANS, PLATFORM } from "./limits.ts";
import { ok, type Result, refused } from "./result.ts";

/** Who is asking: nobody, a signed-in account, the worker or scheduler, or the service owner. */
export type Caller =
  | { kind: "anonymous" }
  | { kind: "account"; account: Account }
  | { kind: "system" }
  | { kind: "operator" };

/** The account's counters, from the ledger and project table (spec 3 computes them). */
export interface Usage {
  /** Projects in state draft or published. */
  activeProjects: number;
  generationsLifetime: number;
  generationsThisMonth: number;
  refreshesThisMonth: number;
  /** Reserved plus spent this UTC month. */
  monthUsdMicros: number;
  /** Platform-wide spend this UTC day. */
  platformDayUsdMicros: number;
}

export interface PolicyContext {
  now: string;
  caller: Caller;
  /** The account owning the project, job or draft acted on. */
  ownerId?: string;
  /** The owner's status, for public reads. */
  ownerStatus?: Account["status"];
  /** The project acted on, for public reads, republishing and restoring. */
  project?: Project;
  facts?: EligibilityFacts | null;
  usage?: Usage;
  estimateUsdMicros?: number;
}

const ELIGIBLE_PERMISSIONS: ReadonlySet<string> = new Set(["admin", "maintain", "push"]);

/** Owner actions that need no eligibility check and work even when frozen (§7.1, D4). */
const ALWAYS_OWNER: ReadonlySet<Action> = new Set([
  "job.read",
  "job.cancel",
  "job.retry",
  "draft.read",
  "preview.read",
  "project.unpublish",
  "project.export",
]);

/** Private-state edits accept an hour-old check; the rest must be live (C7). */
const RECENT_ENOUGH: ReadonlySet<Action> = new Set(["draft.save", "draft.review"]);

/** The eligibility rule (§7.2), refusing with the first failing condition in the spec's order. */
export function checkEligibility(
  facts: EligibilityFacts | null | undefined,
  now: string,
  maxAgeMs: number,
): Result<EligibilityFacts> {
  if (facts === null || facts === undefined) {
    return refused("invalid-input", "eligibility was not checked");
  }
  if (Date.parse(now) - Date.parse(facts.checkedAt) > maxAgeMs) {
    return refused("invalid-input", "eligibility check is stale");
  }
  if (!facts.tokenValid) return refused("github-token-revoked");
  if (facts.visibility !== "public") return refused("repo-private");
  if (facts.isFork) return refused("repo-fork");
  if (!ELIGIBLE_PERMISSIONS.has(facts.permission)) return refused("repo-no-push");
  if (facts.authoredCommits < 1) return refused("repo-no-commits");
  return ok(facts);
}

function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`authorize needs ${name}`);
  return value;
}

/** Whether `ctx.caller` may do `action` (§7.1). Programming errors (missing context) throw. */
export function authorize(action: Action, ctx: PolicyContext): Result<true> {
  if (action === "public.read") return publicRead(ctx);
  const { caller } = ctx;
  if (action === "project.takedown" || action === "project.reinstate") {
    return caller.kind === "operator" ? ok(true) : refused("not-found");
  }
  if (caller.kind === "anonymous") return refused("not-signed-in");
  if (caller.kind !== "account") return refused("not-found");
  const { account } = caller;
  if (account.status === "deleting") return refused("account-deleting");
  if (action === "repos.list" || action === "account.delete") return ok(true);
  if (action === "job.create") return startGeneration(account, ctx);
  if (ctx.ownerId !== account.id) return refused("not-found");
  if (ALWAYS_OWNER.has(action)) return ok(true);

  const usage = need(ctx.usage, "usage");
  if (action !== "project.restore" && isFrozen(account.plan, usage.activeProjects)) {
    return refused("frozen");
  }
  const maxAge = RECENT_ENOUGH.has(action)
    ? PLATFORM.eligibilityMaxAgeMs
    : PLATFORM.liveCheckMaxAgeMs;
  const eligible = checkEligibility(ctx.facts, ctx.now, maxAge);
  if (!eligible.ok) return eligible;
  if (action === "job.refresh") return startRefresh(account, eligible.value, usage, ctx);
  if (action === "project.publish" || action === "project.restore") {
    const reactivates = ctx.project?.state === "withdrawn";
    if (reactivates && usage.activeProjects >= PLANS[account.plan].projects) {
      return refused("plan-project-limit");
    }
  }
  return ok(true);
}

function publicRead(ctx: PolicyContext): Result<true> {
  const project = need(ctx.project, "project");
  if (project.state === "draft") return refused("not-found");
  if (project.state !== "published" || ctx.ownerStatus !== "active") return refused("withdrawn");
  return ok(true);
}

function withinSizeAndCost(
  account: Account,
  facts: EligibilityFacts,
  usage: Usage,
  ctx: PolicyContext,
): Result<true> {
  const plan = PLANS[account.plan];
  if (facts.indexedFiles !== null && facts.indexedFiles > plan.maxIndexedFiles) {
    return refused("repo-too-large");
  }
  if (account.plan === "free" && usage.platformDayUsdMicros >= PLATFORM.dailyUsdMicros) {
    return refused("platform-paused");
  }
  const estimate = need(ctx.estimateUsdMicros, "estimateUsdMicros");
  const cap = jobCap(estimate, plan.monthlyUsdMicros - usage.monthUsdMicros);
  return cap.ok ? ok(true) : cap;
}

function startGeneration(account: Account, ctx: PolicyContext): Result<true> {
  const usage = need(ctx.usage, "usage");
  const eligible = checkEligibility(ctx.facts, ctx.now, PLATFORM.liveCheckMaxAgeMs);
  if (!eligible.ok) return eligible;
  const plan = PLANS[account.plan];
  const age = Date.parse(ctx.now) - Date.parse(account.githubCreatedAt);
  if (account.plan === "free" && age < PLATFORM.freeAccountMinAgeDays * DAY_MS) {
    return refused("account-too-new");
  }
  if (usage.activeProjects >= plan.projects) return refused("plan-project-limit");
  const lifetimeUsed =
    plan.generationsLifetime !== null && usage.generationsLifetime >= plan.generationsLifetime;
  if (lifetimeUsed || usage.generationsThisMonth >= plan.generationsPerMonth) {
    return refused("plan-generation-limit");
  }
  return withinSizeAndCost(account, eligible.value, usage, ctx);
}

function startRefresh(
  account: Account,
  facts: EligibilityFacts,
  usage: Usage,
  ctx: PolicyContext,
): Result<true> {
  if (usage.refreshesThisMonth >= PLANS[account.plan].refreshesPerMonth) {
    return refused("plan-refresh-limit");
  }
  return withinSizeAndCost(account, facts, usage, ctx);
}
```

Add to `packages/hosted/src/index.ts`:

```ts
export {
  authorize,
  type Caller,
  checkEligibility,
  type PolicyContext,
  type Usage,
} from "./policy.ts";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm format && node node_modules/vitest/vitest.mjs run packages/hosted`
Expected: PASS.

- [ ] **Step 6: Check and commit**

```bash
pnpm check
git add packages/hosted
git -c user.email=sean.may101@gmail.com commit -m "feat(hosted): add the authorization policy and eligibility rule"
```

---

## Exit (spec §16)

- [ ] `pnpm check` passes on `m13/hosted-policy`.
- [ ] Every rule in spec §§4–11 has a failing-if-removed test (cross-check with the spec's section list).
- [ ] The boundary test passes (no I/O, clock or randomness).
