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
  /** The default branch's head commit, which the job documents. */
  commitSha: string;
  /** Up to 100 of the author's commit shas, for the worker's people file (spec 2 §8). */
  commitShas: string[];
  now: string;
  newId: () => string;
}

export type Started = Result<{ project: Project; job: Job; created: boolean }>;

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

/** Authorize `action`, then create its job and the worker's spec (Contract §6.1, §7.1). */
async function start(
  tx: Queryable,
  input: StartInput,
  kind: JobKind,
  existing: Project | null,
): Promise<Started> {
  const { account, repo, now } = input;
  const active = existing === null ? null : await activeJob(tx, existing.id, true);
  if (existing && active && active.kind === kind && active.commitSha === input.commitSha) {
    return ok({ project: existing, job: active, created: false });
  }
  const action = kind === "generate" ? "job.create" : "job.refresh";
  const usage = await usageFor(tx, account.id, now);
  const estimate = estimateFor(account.plan);
  const verdict = authorize(action, {
    now,
    caller: { kind: "account", account },
    ...(existing === null ? { githubRepoId: repo.id } : { project: existing }),
    facts: input.facts,
    usage,
    estimateUsdMicros: estimate,
  });
  const target = existing?.id ?? `repo:${repo.id}`;
  if (!verdict.ok) {
    await audit(tx, input, action, target, verdict.code);
    return verdict;
  }
  const cap = jobCap(estimate, PLANS[account.plan].monthlyUsdMicros - usage.monthUsdMicros);
  if (!cap.ok) return cap;
  let project = existing;
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
  });
  await audit(tx, input, action, project.id, "allowed");
  return ok({ project, job, created: true });
}

/**
 * A first generation for a repository (Contract §6.1, §7.1, §18.4), in one transaction. A second
 * request for the same repository and commit returns the job already queued or running.
 */
export async function startGeneration(db: Db, input: StartInput): Promise<Started> {
  return db.transaction(async (tx) => {
    await lockAccount(tx, input.account);
    const existing = await projectFor(tx, input.account.id, input.repo.id, true);
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
    const project = await projectFor(tx, input.account.id, input.project.githubRepoId, true);
    if (project === null || project.id !== input.project.id) return refusedNotFound();
    return start(tx, input, "refresh", project);
  });
}

const refusedNotFound = (): Started => ({ ok: false, code: "not-found" });
