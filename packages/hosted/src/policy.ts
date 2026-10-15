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
  /** Succeeded generations, ever and this UTC month. */
  generationsLifetime: number;
  generationsThisMonth: number;
  /** Succeeded refreshes this UTC month. */
  refreshesThisMonth: number;
  /** Generate and refresh jobs queued or running now; they count against quotas until they end. */
  inFlightGenerations: number;
  inFlightRefreshes: number;
  /** This UTC month: the cap reserved by every unfinished job plus what finished jobs spent (C8). */
  monthUsdMicros: number;
  /** Platform-wide spend this UTC day. */
  platformDayUsdMicros: number;
}

export interface PolicyContext {
  now: string;
  caller: Caller;
  /** The account owning the job or draft acted on, when there is no project in hand. */
  ownerId?: string;
  /** The owner's status, for public reads. */
  ownerStatus?: Account["status"];
  /** The project acted on; required for every project-scoped action that changes anything. */
  project?: Project;
  /** For `job.create` on a repository that has no project yet. */
  githubRepoId?: number;
  facts?: EligibilityFacts | null;
  usage?: Usage;
  estimateUsdMicros?: number;
}

/** The GitHub user and repository an eligibility check must be about. */
export interface EligibilitySubject {
  githubUserId: number;
  githubRepoId: number;
}

const ELIGIBLE_PERMISSIONS: ReadonlySet<string> = new Set(["admin", "maintain", "push"]);

/** Owner actions that spend nothing, need no eligibility check and work even when frozen (D4). */
const ALWAYS_OWNER: ReadonlySet<Action> = new Set([
  "job.read",
  "job.cancel",
  "draft.read",
  "preview.read",
  "project.unpublish",
  "project.export",
]);

/** A review changes only private state and accepts an hour-old check; the rest must be live (C7). */
const RECENT_ENOUGH: ReadonlySet<Action> = new Set(["draft.review"]);

/**
 * The eligibility rule (§7.2): the check must be about this user and repository and fresh
 * enough, then the first failing condition in the spec's order refuses.
 */
export function checkEligibility(
  facts: EligibilityFacts | null | undefined,
  now: string,
  maxAgeMs: number,
  subject: EligibilitySubject,
): Result<EligibilityFacts> {
  if (facts === null || facts === undefined) {
    return refused("invalid-input", "eligibility was not checked");
  }
  if (facts.githubUserId !== subject.githubUserId) {
    return refused("invalid-input", "eligibility is for another user");
  }
  if (facts.githubRepoId !== subject.githubRepoId) {
    return refused("invalid-input", "eligibility is for another repository");
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

/** A project an author may still edit, refresh or publish: not taken down, not purged. */
function workable(project: Project): boolean {
  return (
    project.state === "draft" ||
    project.state === "published" ||
    (project.state === "withdrawn" && project.withdrawReason === "author")
  );
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

  if (ctx.project && ctx.ownerId !== undefined && ctx.ownerId !== ctx.project.accountId) {
    return refused("not-found");
  }
  const ownerId = ctx.project?.accountId ?? ctx.ownerId;
  if (action === "job.create") {
    if (ownerId !== undefined && ownerId !== account.id) return refused("not-found");
    return startGeneration(account, ctx);
  }
  if (ownerId !== account.id) return refused("not-found");
  if (ALWAYS_OWNER.has(action)) return ok(true);

  const project = need(ctx.project, "project");
  const usage = need(ctx.usage, "usage");
  if (action !== "project.restore") {
    if (!workable(project)) return refused("invalid-transition");
    if (isFrozen(account.plan, usage.activeProjects)) return refused("frozen");
  }
  const maxAge = RECENT_ENOUGH.has(action)
    ? PLATFORM.eligibilityMaxAgeMs
    : PLATFORM.liveCheckMaxAgeMs;
  const subject = { githubUserId: account.githubUserId, githubRepoId: project.githubRepoId };
  const eligible = checkEligibility(ctx.facts, ctx.now, maxAge, subject);
  if (!eligible.ok) return eligible;
  if (action === "job.refresh") return startRefresh(account, eligible.value, usage, ctx);
  const reactivates =
    project.state === "withdrawn" &&
    (action === "project.publish" ||
      (action === "project.restore" && project.withdrawReason === "repository"));
  if (reactivates && usage.activeProjects >= PLANS[account.plan].projects) {
    return refused("plan-project-limit");
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

/**
 * A first generation, for a new project or for an existing project whose first job never
 * produced a draft. A new project needs a free slot; an existing one already holds its slot.
 */
function startGeneration(account: Account, ctx: PolicyContext): Result<true> {
  const usage = need(ctx.usage, "usage");
  const { project } = ctx;
  if (project !== undefined && !(project.state === "draft" && project.latestRevision === 0)) {
    return refused("invalid-transition");
  }
  const githubRepoId = project?.githubRepoId ?? need(ctx.githubRepoId, "githubRepoId");
  const subject = { githubUserId: account.githubUserId, githubRepoId };
  const eligible = checkEligibility(ctx.facts, ctx.now, PLATFORM.liveCheckMaxAgeMs, subject);
  if (!eligible.ok) return eligible;
  const plan = PLANS[account.plan];
  const age = Date.parse(ctx.now) - Date.parse(account.githubCreatedAt);
  if (account.plan === "free" && age < PLATFORM.freeAccountMinAgeDays * DAY_MS) {
    return refused("account-too-new");
  }
  if (project === undefined && usage.activeProjects >= plan.projects) {
    return refused("plan-project-limit");
  }
  const lifetime = usage.generationsLifetime + usage.inFlightGenerations;
  const month = usage.generationsThisMonth + usage.inFlightGenerations;
  const lifetimeUsed = plan.generationsLifetime !== null && lifetime >= plan.generationsLifetime;
  if (lifetimeUsed || month >= plan.generationsPerMonth) return refused("plan-generation-limit");
  return withinSizeAndCost(account, eligible.value, usage, ctx);
}

function startRefresh(
  account: Account,
  facts: EligibilityFacts,
  usage: Usage,
  ctx: PolicyContext,
): Result<true> {
  const used = usage.refreshesThisMonth + usage.inFlightRefreshes;
  if (used >= PLANS[account.plan].refreshesPerMonth) return refused("plan-refresh-limit");
  return withinSizeAndCost(account, facts, usage, ctx);
}
