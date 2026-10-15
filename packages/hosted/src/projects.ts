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
    unavailableSince: null,
    latestRevision: 0,
    currentVersion: 0,
    createdAt: input.now,
  };
}

const invalid = () => refused("invalid-transition");
const live = (p: Project) => p.state === "draft" || p.state === "published";
const withdraw = (p: Project, reason: WithdrawReason, now: string): Result<Project> =>
  ok({ ...p, state: "withdrawn", withdrawReason: reason, withdrawnAt: now });
const graceOver = (since: string | null, now: string) =>
  since !== null && Date.parse(now) - Date.parse(since) > PLATFORM.repositoryGraceDays * DAY_MS;

/** The author takes their page or draft down; the URL answers 410 and stays theirs. */
export function unpublish(project: Project, now: string): Result<Project> {
  return live(project) ? withdraw(project, "author", now) : invalid();
}

/**
 * The daily check found the repository private, deleted or a fork. A live project is withdrawn
 * for the repository; one the author already withdrew keeps its page as it is, but its purge
 * clock starts too, so nothing derived from the source outlives the grace period (D4).
 */
export function repositoryUnavailable(project: Project, now: string): Result<Project> {
  if (live(project)) {
    return ok({
      ...project,
      state: "withdrawn",
      withdrawReason: "repository",
      withdrawnAt: now,
      unavailableSince: now,
    });
  }
  const authorWithdrawn = project.state === "withdrawn" && project.withdrawReason === "author";
  if (authorWithdrawn && project.unavailableSince === null) {
    return ok({ ...project, unavailableSince: now });
  }
  return invalid();
}

export function takedown(project: Project, now: string): Result<Project> {
  return live(project) ? withdraw(project, "operator", now) : invalid();
}

/** Account deletion withdraws every page at once and starts the 30-day purge clock. */
export function accountDeleted(project: Project, now: string): Result<Project> {
  return project.state === "purged" ? invalid() : withdraw(project, "account-deleted", now);
}

/**
 * The repository is eligible again within the grace period. A repository withdrawal goes back
 * to where it was; an author withdrawal stays withdrawn with its purge clock stopped.
 */
export function restore(project: Project, now: string): Result<Project> {
  if (project.state !== "withdrawn" || project.unavailableSince === null) return invalid();
  if (project.withdrawReason !== "repository" && project.withdrawReason !== "author") {
    return invalid();
  }
  if (graceOver(project.unavailableSince, now)) return refused("restore-expired");
  if (project.withdrawReason === "author") return ok({ ...project, unavailableSince: null });
  return ok({
    ...project,
    state: project.currentVersion > 0 ? "published" : "draft",
    withdrawReason: null,
    withdrawnAt: null,
    unavailableSince: null,
  });
}

/** Delete everything derived from source; the row and slug remain as a tombstone. */
export function purge(project: Project, now: string): Result<Project> {
  if (project.state !== "withdrawn") return invalid();
  const since =
    project.withdrawReason === "account-deleted" ? project.withdrawnAt : project.unavailableSince;
  const purgeable = project.withdrawReason !== "operator" && graceOver(since, now);
  return purgeable ? ok({ ...project, state: "purged" }) : invalid();
}
