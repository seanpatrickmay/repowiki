import { WikiExport } from "@repowiki/core";
import {
  type Action,
  authorize,
  type Generation,
  projectUrl,
  type RefusalCode,
  type Result,
  reviewRevision,
} from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { readForm } from "../http/body.ts";
import type { Reply, Route, RouteRequest } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { checkMutation, currentSession, type Session } from "../http/session.ts";
import { projectPage } from "../pages/project.ts";
import { pageSession, refusalPage } from "../pages/refusal.ts";
import { activeHandle } from "../store/accounts.ts";
import { appendAudit } from "../store/audit.ts";
import {
  generationById,
  latestRevision,
  previewOf,
  reviewOf,
  saveReview,
  versionOf,
} from "../store/drafts.ts";
import { jobsOf } from "../store/jobs.ts";
import { usageFor } from "../store/projects.ts";
import { liveEligibility, ownedProject, repoFullName } from "./live.ts";

const titleCache = new Map<string, ReadonlyMap<string, string>>();

/** A generation's stored export, parsed; null when the object is missing. */
export async function storedExport(deps: Deps, generation: Generation): Promise<WikiExport | null> {
  const object = await deps.objects.get(generation.exportKey);
  return object === null
    ? null
    : WikiExport.parse(JSON.parse(new TextDecoder().decode(object.body)));
}

/** Feature titles from a generation's export, cached by export key (an export never changes). */
export async function featureTitles(
  deps: Deps,
  generation: Generation,
): Promise<ReadonlyMap<string, string>> {
  const cached = titleCache.get(generation.exportKey);
  if (cached !== undefined) return cached;
  const exp = await storedExport(deps, generation);
  const titles = new Map((exp?.manifest.features ?? []).map((f) => [f.id as string, f.title]));
  if (titleCache.size >= 200) titleCache.clear();
  titleCache.set(generation.exportKey, titles);
  return titles;
}

/** One audit event by the author about a project. */
export async function auditAuthor(
  tx: Queryable,
  deps: Deps,
  action: string,
  projectId: string,
  outcome: RefusalCode | "allowed",
): Promise<void> {
  await appendAudit(tx, {
    id: deps.newId(),
    actor: "author",
    action,
    target: { entity: "project", id: projectId },
    outcome,
    createdAt: deps.now(),
  });
}

/** The session, the form and the CSRF check every author mutation starts with (spec 2 S6). */
export async function mutation(
  deps: Deps,
  request: RouteRequest,
): Promise<{ session: Session; form: URLSearchParams }> {
  const session = await currentSession(deps.db, deps.config, request, deps.now());
  const form = await readForm(request.raw);
  checkMutation(deps.config, request.headers, session, form.get("csrf"));
  return { session, form };
}

/**
 * One draft mutation (S5): the owner's project, a live eligibility check, then one transaction
 * that locks the project, asks the policy, applies the change and audits it.
 */
async function mutateDraft(
  deps: Deps,
  session: Session,
  projectId: string,
  action: Action,
  apply: (
    tx: Queryable,
    project: NonNullable<Awaited<ReturnType<typeof ownedProject>>>,
  ) => Promise<Result<true>>,
): Promise<Reply> {
  const shown = pageSession(session);
  const owned = await ownedProject(deps.db, session, projectId);
  if (owned === null) return refusalPage("not-found", shown);
  const live = await liveEligibility(deps, session, owned.githubRepoId);
  if (!live.ok) return live.reply;
  const back = `/projects/${owned.id}`;
  const result = await deps.db.transaction(async (tx): Promise<Result<true>> => {
    const project = await ownedProject(tx, session, owned.id, true);
    if (project === null) return { ok: false, code: "not-found" };
    const now = deps.now();
    const usage = await usageFor(tx, session.account.id, now);
    const caller = { kind: "account" as const, account: session.account };
    const verdict = authorize(action, { now, caller, project, facts: live.facts, usage });
    if (!verdict.ok) return verdict;
    const applied = await apply(tx, project);
    if (applied.ok) await auditAuthor(tx, deps, action, project.id, "allowed");
    return applied;
  });
  if (result.ok) return redirect(back);
  await deps.db.transaction((tx) => auditAuthor(tx, deps, action, owned.id, result.code));
  return refusalPage(result.code, shown, {
    back,
    ...(result.detail ? { detail: result.detail } : {}),
  });
}

/** The project page and its review (spec 2 §7, Contract §6.3, ADR-0012). */
export function draftRoutes(deps: Deps): Route[] {
  return [
    {
      method: "GET",
      pattern: "/projects/:id",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        if (session === null) return redirect("/auth/github");
        const shown = pageSession(session);
        const project = await ownedProject(deps.db, session, request.params.id ?? "");
        if (project === null) return refusalPage("not-found", shown);
        const caller = { kind: "account" as const, account: session.account };
        const verdict = authorize("draft.read", { now: deps.now(), caller, project });
        if (!verdict.ok) return refusalPage(verdict.code, shown);
        const [jobs, revision, handle, repo] = await Promise.all([
          jobsOf(deps.db, project.id),
          latestRevision(deps.db, project.id),
          activeHandle(deps.db, session.account.id),
          repoFullName(deps.db, project.githubRepoId),
        ]);
        const generation =
          revision === null ? null : await generationById(deps.db, revision.generationId);
        const current =
          project.currentVersion === 0
            ? null
            : await versionOf(deps.db, project.id, project.currentVersion);
        const body = projectPage({
          project,
          publicUrl: projectUrl(
            deps.config.publicOrigin,
            handle ?? session.account.login,
            project.slug,
          ),
          repoFullName: repo,
          job: jobs[0] ?? null,
          revision,
          generation,
          review: revision === null ? null : await reviewOf(deps.db, project.id, revision.number),
          preview: revision === null ? null : await previewOf(deps.db, project.id, revision.number),
          current,
          titles: generation === null ? new Map() : await featureTitles(deps, generation),
          session: shown,
        });
        return html(200, body, { "cache-control": "private, no-store" });
      },
    },
    {
      method: "POST",
      pattern: "/projects/:id/review",
      handler: async (request) => {
        const { session, form } = await mutation(deps, request);
        const id = request.params.id ?? "";
        if (form.get("attest") !== "yes") {
          const detail = "Tick the declaration to record your review.";
          return refusalPage("invalid-input", pageSession(session), {
            detail,
            back: `/projects/${id}`,
          });
        }
        const revision = Number(form.get("revision"));
        return mutateDraft(deps, session, id, "draft.review", async (tx, project) => {
          const latest = await latestRevision(tx, project.id);
          if (latest === null) return { ok: false, code: "invalid-transition" };
          const review = reviewRevision(latest, revision, deps.now());
          if (!review.ok) return review;
          await saveReview(tx, review.value);
          return { ok: true, value: true };
        });
      },
    },
  ];
}
