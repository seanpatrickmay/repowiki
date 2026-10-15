import { WikiExport } from "@repowiki/core";
import { authorize, type Generation, projectUrl } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { currentSession } from "../http/session.ts";
import { projectPage } from "../pages/project.ts";
import { pageSession, refusalPage } from "../pages/refusal.ts";
import { activeHandle } from "../store/accounts.ts";
import { generationById, latestRevision, previewOf, reviewOf, versionOf } from "../store/drafts.ts";
import { jobsOf } from "../store/jobs.ts";
import { ownedProject, repoFullName } from "./live.ts";

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

/** The project page, saving the portfolio layer and review (spec 2 §7, Contract §6.3). */
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
          publicUrl: projectUrl(deps.config.origin, handle ?? session.account.login, project.slug),
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
  ];
}
