import { authorize, cancelJob, type Job, ok, type Result, retryJob } from "@repowiki/hosted";
import { type Deps, logOf, nameOf } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import type { Route } from "../http/router.ts";
import { redirect } from "../http/server.ts";
import type { Session } from "../http/session.ts";
import { pageSession, refusalPage } from "../pages/refusal.ts";
import {
  activeJob,
  issueToken,
  jobById,
  revokeTokens,
  saveJob,
  settleOpen,
} from "../store/jobs.ts";
import { usageFor } from "../store/projects.ts";
import { auditAuthor, mutation } from "./drafts.ts";
import { isUuid, liveEligibility, ownedProject } from "./live.ts";

type Owned = NonNullable<Awaited<ReturnType<typeof ownedProject>>>;

/**
 * The job and its project for the session's owner, locked job first, then project: the order
 * `succeed` and `startRefresh` lock them in (M14c M5). Null when either is not the owner's.
 */
async function lockedJob(
  tx: Queryable,
  session: Session,
  projectId: string,
  jobId: string,
): Promise<{ job: Job; project: Owned } | null> {
  if (!isUuid(jobId)) return null;
  const job = await jobById(tx, jobId, true);
  if (job === null || job.projectId !== projectId) return null;
  const project = await ownedProject(tx, session, projectId, true);
  return project === null ? null : { job, project };
}

/** Cancel and retry of a project's job (Contract §6.1, M14e A2). */
export function jobRoutes(deps: Deps): Route[] {
  return [
    {
      method: "POST",
      pattern: "/projects/:id/jobs/:job/cancel",
      handler: async (request) => {
        const { session } = await mutation(deps, request);
        const projectId = request.params.id ?? "";
        const back = `/projects/${projectId}`;
        const result = await deps.db.transaction(async (tx): Promise<Result<true>> => {
          const found = await lockedJob(tx, session, projectId, request.params.job ?? "");
          if (found === null) return { ok: false, code: "not-found" };
          const now = deps.now();
          const caller = { kind: "account" as const, account: session.account };
          const verdict = authorize("job.cancel", { now, caller, project: found.project });
          if (!verdict.ok) return verdict;
          // Open spend is charged before the job stops, as every ending does (spec 2 §6).
          const cancelled = cancelJob(await settleOpen(tx, found.job, now), now);
          if (!cancelled.ok) return cancelled;
          await saveJob(tx, cancelled.value);
          await revokeTokens(tx, found.job.id);
          await auditAuthor(tx, deps, "job.cancel", projectId, "allowed");
          return ok(true);
        });
        if (!result.ok) return refusalPage(result.code, pageSession(session), { back });
        return redirect(back);
      },
    },
    {
      method: "POST",
      pattern: "/projects/:id/jobs/:job/retry",
      handler: async (request) => {
        const { session } = await mutation(deps, request);
        const shown = pageSession(session);
        const owned = await ownedProject(deps.db, session, request.params.id ?? "");
        if (owned === null) return refusalPage("not-found", shown);
        const live = await liveEligibility(deps, session, owned.githubRepoId);
        if (!live.ok) return live.reply;
        const back = `/projects/${owned.id}`;
        const result = await deps.db.transaction(
          async (tx): Promise<Result<{ job: Job; token: string }>> => {
            const found = await lockedJob(tx, session, owned.id, request.params.job ?? "");
            if (found === null) return { ok: false, code: "not-found" };
            const now = deps.now();
            const usage = await usageFor(tx, session.account.id, now);
            const caller = { kind: "account" as const, account: session.account };
            const context = { now, caller, project: found.project, facts: live.facts, usage };
            const verdict = authorize("job.retry", context);
            if (!verdict.ok) return verdict;
            if ((await activeJob(tx, owned.id)) !== null) return { ok: false, code: "job-active" };
            const retried = retryJob(found.job);
            if (!retried.ok) return retried;
            await saveJob(tx, retried.value);
            // One worker per attempt (M14c A5): every old token dies before the new one exists.
            await revokeTokens(tx, found.job.id);
            const token = await issueToken(tx, found.job.id, retried.value.attempt, now);
            await auditAuthor(tx, deps, "job.retry", owned.id, "allowed");
            return ok({ job: retried.value, token });
          },
        );
        if (!result.ok) {
          await deps.db.transaction((tx) =>
            auditAuthor(tx, deps, "job.retry", owned.id, result.code),
          );
          return refusalPage(result.code, shown, { back });
        }
        const { job, token } = result.value;
        // A failed start leaves the job queued with its token; the sweeper restarts it (S16).
        await deps.runner
          .start({ jobId: job.id, attempt: job.attempt, token })
          .catch((error: unknown) =>
            logOf(deps)({ runner: "start-failed", job: job.id, error: nameOf(error) }),
          );
        return redirect(back);
      },
    },
  ];
}
