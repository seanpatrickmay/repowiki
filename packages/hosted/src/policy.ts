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
