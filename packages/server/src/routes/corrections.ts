import type { Claim, WikiExport } from "@repowiki/core";
import { CORRECTION, type Generation, type Project } from "@repowiki/hosted";
import { type Deps, logOf, nameOf } from "../app.ts";
import { githubApi, TokenRevoked } from "../github/api.ts";
import { eligibilityFacts } from "../github/facts.ts";
import { readForm } from "../http/body.ts";
import type { Reply, Route, RouteRequest } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { checkMutation, currentSession, type Session } from "../http/session.ts";
import { correctionForm, correctionsIndex } from "../pages/corrections.ts";
import { pageSession, refusalPage } from "../pages/refusal.ts";
import { generationById, latestRevision } from "../store/drafts.ts";
import { readGitHubToken } from "../store/github-tokens.ts";
import { startCorrection } from "../store/start.ts";
import { storedExport } from "./drafts.ts";
import { ownedProject } from "./live.ts";

/** The engine's name for the About article in a correction's items (its ABOUT_ARTICLE). */
const ABOUT = "@about";
const PRIVATE = { "cache-control": "private, no-store" };

interface Draft {
  session: Session;
  project: Project;
  generation: Generation;
  exp: WikiExport;
}

/** An article of the export: the About article (`about`) or a feature's page. */
function articleOf(
  exp: WikiExport,
  which: string,
): {
  page: string;
  title: string;
  sections: readonly { key: string; claims: readonly Claim[] }[];
} | null {
  if (which === ABOUT) {
    const about = exp.architecture.at(-1);
    return about === undefined
      ? null
      : { page: ABOUT, title: `About ${about.title}`, sections: about.sections };
  }
  const page = exp.pages.find((p) => p.featureId === which);
  if (page === undefined) return null;
  const title = exp.manifest.features.find((f) => f.id === which)?.title ?? which;
  return { page: which, title, sections: page.sections };
}

/** Correcting a sentence of the latest draft (sentence corrections spec, ADR-0023). */
export function correctionRoutes(deps: Deps): Route[] {
  const api = githubApi(deps.fetch, deps.github);

  /** The signed-in owner's project, its latest revision's generation and that export; or why not. */
  async function draft(request: RouteRequest, session: Session | null): Promise<Draft | Reply> {
    if (session === null) return redirect("/auth/github");
    const shown = pageSession(session);
    const project = await ownedProject(deps.db, session, request.params.id ?? "");
    if (project === null) return refusalPage("not-found", shown);
    const latest = await latestRevision(deps.db, project.id);
    const generation = latest === null ? null : await generationById(deps.db, latest.generationId);
    const exp = generation === null ? null : await storedExport(deps, generation);
    if (generation === null || exp === null) return refusalPage("not-found", shown);
    return { session, project, generation, exp };
  }

  const isDraft = (value: Draft | Reply): value is Draft => "exp" in value;

  async function show(request: RouteRequest, which: string): Promise<Reply> {
    const session = await currentSession(deps.db, deps.config, request, deps.now());
    const found = await draft(request, session);
    if (!isDraft(found)) return found;
    const article = articleOf(found.exp, which);
    if (article === null) return refusalPage("not-found", pageSession(found.session));
    const base = `/projects/${found.project.id}/corrections`;
    const body = correctionForm({
      projectId: found.project.id,
      title: article.title,
      action: which === ABOUT ? `${base}/about` : `${base}/pages/${which}`,
      generationId: found.generation.id,
      sections: article.sections,
      exp: found.exp,
      session: pageSession(found.session),
    });
    return html(200, body, PRIVATE);
  }

  async function start(request: RouteRequest, which: string): Promise<Reply> {
    const session = await currentSession(deps.db, deps.config, request, deps.now());
    const form = await readForm(request.raw);
    checkMutation(deps.config, request.headers, session, form.get("csrf"));
    const found = await draft(request, session);
    if (!isDraft(found)) return found;
    const shown = pageSession(found.session);
    const back = `/projects/${found.project.id}/corrections`;
    const article = articleOf(found.exp, which);
    if (article === null) return refusalPage("not-found", shown);
    if (form.get("generation") !== found.generation.id) {
      return refusalPage("stale-revision", shown, { back });
    }
    const known = new Set(article.sections.flatMap((s) => s.claims.map((c) => c.id)));
    const ids = [...new Set(form.getAll("claim"))];
    const items = ids.map((id) => ({
      page: article.page,
      claimId: id,
      note: (form.get(`note-${id}`) ?? "").trim(),
    }));
    const usable =
      items.length > 0 &&
      items.length <= CORRECTION.items &&
      items.every(
        (i) => known.has(i.claimId) && i.note !== "" && i.note.length <= CORRECTION.noteLength,
      );
    if (!usable) {
      const detail = `Tick 1 to ${CORRECTION.items} sentences and say what's wrong with each, in at most ${CORRECTION.noteLength} characters.`;
      return refusalPage("invalid-input", shown, { detail, back });
    }
    try {
      return await begin(found, items);
    } catch (error) {
      if (error instanceof TokenRevoked) return refusalPage("github-token-revoked", shown);
      throw error;
    }
  }

  /** The live eligibility check, then the job and its runner, as a refresh starts (C7). */
  async function begin(found: Draft, items: { page: string; claimId: string; note: string }[]) {
    const { session, project, generation } = found;
    const shown = pageSession(session);
    const token = await readGitHubToken(deps.db, deps.config.tokenKey, session.account.id);
    if (token === null) return redirect("/auth/github");
    const now = deps.now();
    const { account } = session;
    const { facts, repo } = await eligibilityFacts(api, token, {
      githubUserId: account.githubUserId,
      login: account.login,
      githubRepoId: project.githubRepoId,
      now,
      indexedFiles: null,
    });
    if (repo === null) {
      return refusalPage(facts.tokenValid ? "repo-private" : "github-token-revoked", shown);
    }
    const started = await startCorrection(deps.db, {
      account,
      facts,
      repo,
      commitSha: generation.commitSha,
      commitShas: [],
      now,
      newId: deps.newId,
      project,
      correction: { generationId: generation.id, items },
    });
    if (!started.ok) return refusalPage(started.code, shown, { back: `/projects/${project.id}` });
    const { job, token: jobToken } = started.value;
    if (jobToken !== null) {
      // A failed start leaves the job queued with its token; the sweeper restarts it (S16).
      await deps.runner
        .start({ jobId: job.id, attempt: job.attempt, token: jobToken })
        .catch((error: unknown) =>
          logOf(deps)({ runner: "start-failed", job: job.id, error: nameOf(error) }),
        );
    }
    return redirect(`/projects/${project.id}`);
  }

  return [
    {
      method: "GET",
      pattern: "/projects/:id/corrections",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        const found = await draft(request, session);
        if (!isDraft(found)) return found;
        const body = correctionsIndex({
          projectId: found.project.id,
          slug: found.project.slug,
          exp: found.exp,
          session: pageSession(found.session),
        });
        return html(200, body, PRIVATE);
      },
    },
    { method: "GET", pattern: "/projects/:id/corrections/about", handler: (r) => show(r, ABOUT) },
    {
      method: "GET",
      pattern: "/projects/:id/corrections/pages/:page",
      handler: (r) => show(r, r.params.page ?? ""),
    },
    { method: "POST", pattern: "/projects/:id/corrections/about", handler: (r) => start(r, ABOUT) },
    {
      method: "POST",
      pattern: "/projects/:id/corrections/pages/:page",
      handler: (r) => start(r, r.params.page ?? ""),
    },
  ];
}
