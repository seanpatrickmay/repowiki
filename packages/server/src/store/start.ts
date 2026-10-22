import {
  type Account,
  type Action,
  authorize,
  createJob,
  type EligibilityFacts,
  type Job,
  type JobKind,
  jobCap,
  newProject,
  ok,
  PLANS,
  type Plan,
  type Project,
  type RefusalCode,
  type Result,
  revive,
  slugFor,
} from "@repowiki/hosted";
import type { Db, Queryable } from "../db/db.ts";
import type { GitHubRepo } from "../github/api.ts";
import { appendAudit } from "./audit.ts";
import { generationById, latestRevision } from "./drafts.ts";
import { activeJob, issueToken, saveJob, saveJobSpec } from "./jobs.ts";
import {
  correctionsOf,
  projectById,
  projectFor,
  saveProject,
  saveRepository,
  usageFor,
} from "./projects.ts";

/**
 * Measured cost on Haiku 5.5 (AlphaSettler, 120 files: $0.028 for the whole build, against
 * $0.297 on Haiku 4.5): about $0.023 per 100 indexed files. The estimate allows about that per
 * file, and the job's cap adds half again (PLATFORM.jobCapMultiplier).
 */
const PER_FILE_MICROS = 250;
const BASE_MICROS = 30_000;

/** A job's estimate before its files are counted: the plan's largest repository (spec 2 S15). */
export function estimateFor(plan: Plan): number {
  return BASE_MICROS + PER_FILE_MICROS * PLANS[plan].maxIndexedFiles;
}

export interface StartInput {
  account: Account;
  /** A live check, made just now (Contract C7). */
  facts: EligibilityFacts;
  repo: GitHubRepo;
  /** The default branch's head commit, which the job documents. */
  commitSha: string;
  /** Up to 100 of the author's commit shas, for the worker's people file (spec 2 §8). */
  commitShas: string[];
  now: string;
  newId: () => string;
}

/** `token` is the new job's first token, issued in the same transaction; null when not created. */
export type Started = Result<{
  project: Project;
  job: Job;
  created: boolean;
  token: string | null;
}>;

async function audit(
  tx: Queryable,
  input: StartInput,
  action: Action,
  target: string,
  outcome: RefusalCode | "allowed",
) {
  await appendAudit(tx, {
    id: input.newId(),
    actor: "author",
    action,
    target: { entity: "project", id: target },
    outcome,
    createdAt: input.now,
  });
}

/** The account's row locked, so two starts for one account run one after the other. */
async function lockAccount(tx: Queryable, account: Account): Promise<void> {
  await tx.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [account.id]);
}

/** The account's project for a repository, locked after its active job: the order succeed uses. */
async function lockedProject(
  tx: Queryable,
  accountId: string,
  githubRepoId: number,
): Promise<Project | null> {
  const found = await projectFor(tx, accountId, githubRepoId);
  if (found === null) return null;
  await activeJob(tx, found.id, true);
  return projectById(tx, found.id, true);
}

/** Authorize `action`, then create its job and the worker's spec (Contract §6.1, §7.1). */
/** What a correction job corrects: a generation of the project, and the flagged sentences. */
export interface CorrectionInput {
  generationId: string;
  items: { page: string; claimId: string; note: string }[];
}

const ACTION: Readonly<Record<JobKind, Action>> = {
  generate: "job.create",
  refresh: "job.refresh",
  correct: "job.correct",
};

async function start(
  tx: Queryable,
  input: StartInput,
  kind: JobKind,
  existing: Project | null,
  correction: CorrectionInput | null = null,
): Promise<Started> {
  const { account, repo, now } = input;
  const active = existing === null ? null : await activeJob(tx, existing.id, true);
  if (existing && active && active.kind === kind && active.commitSha === input.commitSha) {
    return ok({ project: existing, job: active, created: false, token: null });
  }
  const action = ACTION[kind];
  const usage = await usageFor(tx, account.id, now);
  // A correction is one small call per article flagged, and a retry (ADR-0023).
  const estimate =
    kind === "correct" ? Math.ceil(estimateFor(account.plan) / 10) : estimateFor(account.plan);
  const verdict = authorize(action, {
    now,
    caller: { kind: "account", account },
    ...(existing === null ? { githubRepoId: repo.id } : { project: existing }),
    facts: input.facts,
    usage,
    estimateUsdMicros: estimate,
    corrections: existing === null ? 0 : await correctionsOf(tx, existing.id),
  });
  const target = existing?.id ?? `repo:${repo.id}`;
  if (!verdict.ok) {
    await audit(tx, input, action, target, verdict.code);
    return verdict;
  }
  const cap = jobCap(estimate, PLANS[account.plan].monthlyUsdMicros - usage.monthUsdMicros);
  if (!cap.ok) return cap;
  // A purged project is built again as a fresh draft at its old address (ADR-0021).
  const revived = existing?.state === "purged" ? revive(existing) : null;
  let project = revived?.ok ? revived.value : existing;
  if (project === null) {
    const slugs = await tx.query<{ slug: string }>(
      "SELECT slug FROM projects WHERE account_id = $1",
      [account.id],
    );
    const taken = new Set(slugs.map((s) => s.slug));
    const slug = slugFor(repo.name, (s) => taken.has(s));
    project = newProject({
      id: input.newId(),
      accountId: account.id,
      githubRepoId: repo.id,
      slug,
      now,
    });
  }
  const created = createJob(
    {
      id: input.newId(),
      projectId: project.id,
      kind,
      commitSha: input.commitSha,
      estimateUsdMicros: estimate,
      capUsdMicros: cap.value,
      now,
    },
    active,
  );
  if (!created.ok) return created;
  const { job } = created.value;
  await saveRepository(tx, {
    githubRepoId: repo.id,
    fullName: repo.full_name,
    visibility: repo.private ? "private" : "public",
    isFork: repo.fork,
    defaultBranch: repo.default_branch,
    checkedAt: now,
  });
  await saveProject(tx, project);
  await saveJob(tx, job);
  await saveJobSpec(tx, job.id, {
    // The worker names its bare clone `repo.name`, so the wiki is named after the repository.
    repo: {
      githubRepoId: repo.id,
      fullName: repo.full_name,
      name: repo.name,
      // Built from the validated name: the worker clones from github.com and nowhere else.
      cloneUrl: `https://github.com/${repo.full_name}.git`,
      sizeKb: repo.size,
    },
    author: {
      login: account.login,
      githubUserId: account.githubUserId,
      commitShas: input.commitShas,
    },
    plan: account.plan,
    export: null,
    ...(correction === null ? {} : { correction: { ...correction, outcomes: null } }),
  });
  await audit(tx, input, action, project.id, "allowed");
  // In this transaction, so no sweep can see the job without a token and start a second runner.
  const token = await issueToken(tx, job.id, job.attempt, now);
  return ok({ project, job, created: true, token });
}

/**
 * A first generation for a repository (Contract §6.1, §7.1, §18.4), in one transaction. A second
 * request for the same repository and commit returns the job already queued or running.
 */
export async function startGeneration(db: Db, input: StartInput): Promise<Started> {
  return db.transaction(async (tx) => {
    await lockAccount(tx, input.account);
    const existing = await lockedProject(tx, input.account.id, input.repo.id);
    return start(tx, input, "generate", existing);
  });
}

/** A refresh of an existing project (Contract §6.1, §7.1); refused on Free. */
export async function startRefresh(
  db: Db,
  input: StartInput & { project: Project },
): Promise<Started> {
  return db.transaction(async (tx) => {
    await lockAccount(tx, input.account);
    const project = await lockedProject(tx, input.account.id, input.project.githubRepoId);
    if (project === null || project.id !== input.project.id) return refusedNotFound();
    return start(tx, input, "refresh", project);
  });
}

/**
 * A correction of the project's latest generation (ADR-0023), at that generation's commit. A
 * generation that is not the latest revision's is stale.
 */
export async function startCorrection(
  db: Db,
  input: StartInput & { project: Project; correction: CorrectionInput },
): Promise<Started> {
  return db.transaction(async (tx) => {
    await lockAccount(tx, input.account);
    const project = await lockedProject(tx, input.account.id, input.project.githubRepoId);
    if (project === null || project.id !== input.project.id) return refusedNotFound();
    const latest = await latestRevision(tx, project.id);
    const generation = await generationById(tx, input.correction.generationId);
    if (
      latest === null ||
      generation === null ||
      latest.generationId !== generation.id ||
      generation.commitSha !== input.commitSha
    ) {
      return { ok: false, code: "stale-revision" };
    }
    return start(tx, input, "correct", project, input.correction);
  });
}

const refusedNotFound = (): Started => ({ ok: false, code: "not-found" });
