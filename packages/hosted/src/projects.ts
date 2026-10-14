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
