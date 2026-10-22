import { type Project, type ProjectState, profileUrl, projectUrl } from "@repowiki/hosted";
import { type Deps, logOf, nameOf } from "../app.ts";
import { type GitHubRepo, githubApi, TokenRevoked } from "../github/api.ts";
import { eligibilityFacts } from "../github/facts.ts";
import { readForm } from "../http/body.ts";
import type { Reply, Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { checkMutation, currentSession, type Session } from "../http/session.ts";
import { escapeHtml, page } from "../pages/layout.ts";
import { pageSession, refusalPage } from "../pages/refusal.ts";
import { activeHandle } from "../store/accounts.ts";
import { readGitHubToken } from "../store/github-tokens.ts";
import { projectsOf } from "../store/projects.ts";
import { startGeneration, startRefresh } from "../store/start.ts";
import { ownedProject } from "./live.ts";

/** A project's state in the words a student uses (the persona review, ADR-0020). */
const STATE_WORDS: Record<ProjectState, string> = {
  draft: "not published yet",
  published: "published",
  withdrawn: "taken down",
  purged: "deleted",
};

/** Links to paste into a resume: there is no script on the page, so each is shown to copy. */
function resumeCard(profile: string, published: { slug: string; url: string }[]): string {
  const shown = new URL(profile);
  const header = `\\href{${profile}}{${shown.host}${shown.pathname}}`;
  const items = published
    .map(
      (p) =>
        `<li><strong>${escapeHtml(p.slug)}</strong>: <code>${escapeHtml(p.url)}</code><br>LaTeX, after the project's name: <code>${escapeHtml(`\\href{${p.url}}{$\\nearrow$}`)}</code></li>`,
    )
    .join("");
  return `<section class="card"><h2>Put it on your resume</h2>
<p>Your entry: <code>${escapeHtml(profile)}</code></p>
<p>LaTeX, in your header: <code>${escapeHtml(header)}</code> (needs only the hyperref package)</p>
<ul class="plain">${items}</ul>
<p>Word or Google Docs: select the project's name, press Ctrl + K (⌘ + K on a Mac) and paste its link.</p>
<p>LinkedIn: add your entry under Featured, as a link.</p></section>`;
}

function dashboard(
  session: Session,
  repos: GitHubRepo[],
  owned: Project[],
  handle: string | null,
  publicOrigin: string,
): string {
  const csrf = escapeHtml(session.csrf);
  const byRepo = new Map(owned.map((p) => [p.githubRepoId, p]));
  const choices = repos
    .map((r) => {
      const project = byRepo.get(r.id);
      // A repository with a project is rebuilt from that project's page, not started again.
      const action =
        project === undefined
          ? `<form method="post" action="/projects"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="githubRepoId" value="${r.id}"><button>Build its wiki</button></form>`
          : `<p><a href="/projects/${escapeHtml(project.id)}">Open its project</a></p>`;
      return `<li class="card"><strong>${escapeHtml(r.full_name)}</strong><p class="muted">${escapeHtml(r.description ?? "")}</p>
${action}</li>`;
    })
    .join("");
  const projects = owned
    .map(
      (p) =>
        `<li><a href="/projects/${escapeHtml(p.id)}">${escapeHtml(p.slug)}</a> <span class="muted">${STATE_WORDS[p.state]}</span></li>`,
    )
    .join("");
  const published = owned.filter((p) => p.state === "published");
  // The biography exists once a project is published (ADR-0013).
  const profile = handle !== null && published.length > 0 ? profileUrl(publicOrigin, handle) : null;
  const link =
    profile === null
      ? `<p class="muted">Your entry appears once you publish a project.</p>`
      : `<p><a href="${escapeHtml(profile)}">View your entry</a></p>`;
  const card =
    profile === null || handle === null
      ? ""
      : resumeCard(
          profile,
          published.map((p) => ({ slug: p.slug, url: projectUrl(publicOrigin, handle, p.slug) })),
        );
  const plan =
    session.account.plan === "pro"
      ? `<p class="muted">Plan: Pro · <a href="/billing">Billing</a></p>`
      : `<p class="muted">Plan: Free · <a href="/billing">See Pro</a></p>`;
  return `<h1>Your projects</h1>${plan}${link}${projects ? `<ul>${projects}</ul>` : `<p class="muted">No projects yet.</p>`}${card}
<h2>Your public repositories</h2><p class="muted">RepoWiki builds a wiki for a public repository you can push to and have commits in.</p><ul class="plain">${choices || "<li>No public repositories found.</li>"}</ul>`;
}

/** The dashboard and starting a project (spec 2 §7). */
export function projectRoutes(deps: Deps): Route[] {
  const api = githubApi(deps.fetch, deps.github);

  /**
   * `POST /projects` (a first generation) or `POST /projects/:id/refresh` (`refreshOf`) once the
   * session and form are checked.
   */
  async function build(
    session: Session,
    githubRepoId: number,
    refreshOf: Project | null = null,
  ): Promise<Reply> {
    const shown = pageSession(session);
    const token = await readGitHubToken(deps.db, deps.config.tokenKey, session.account.id);
    if (token === null) return redirect("/auth/github");
    const now = deps.now();
    const { account } = session;
    const { facts, repo } = await eligibilityFacts(api, token, {
      githubUserId: account.githubUserId,
      login: account.login,
      githubRepoId,
      now,
      indexedFiles: null,
    });
    if (repo === null) {
      return refusalPage(facts.tokenValid ? "repo-private" : "github-token-revoked", shown);
    }
    const commitSha = await api.headSha(token, repo.full_name, repo.default_branch);
    if (commitSha === null) {
      const detail = "The repository has no commits on its default branch.";
      return refusalPage("invalid-input", shown, { detail });
    }
    const commitShas = await api.commitShas(token, repo.full_name, account.login, 100);
    const input = { account, facts, repo, commitSha, commitShas, now, newId: deps.newId };
    const started =
      refreshOf === null
        ? await startGeneration(deps.db, input)
        : await startRefresh(deps.db, { ...input, project: refreshOf });
    const back = refreshOf === null ? "/dashboard" : `/projects/${refreshOf.id}`;
    if (!started.ok) return refusalPage(started.code, shown, { back });
    const { project, job, token: jobToken } = started.value;
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
      pattern: "/dashboard",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        if (session === null) return redirect("/auth/github");
        const token = await readGitHubToken(deps.db, deps.config.tokenKey, session.account.id);
        if (token === null) return redirect("/auth/github");
        let repos: GitHubRepo[];
        try {
          repos = (await api.publicRepos(token)).filter((r) => !r.fork);
        } catch (error) {
          if (error instanceof TokenRevoked) return redirect("/auth/github");
          throw error;
        }
        const owned = await projectsOf(deps.db, session.account.id);
        const handle = await activeHandle(deps.db, session.account.id);
        const body = dashboard(session, repos, owned, handle, deps.config.publicOrigin);
        return html(200, page({ title: "Dashboard", body, session: pageSession(session) }));
      },
    },
    {
      method: "POST",
      pattern: "/projects",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        const body = await readForm(request.raw);
        checkMutation(deps.config, request.headers, session, body.get("csrf"));
        const githubRepoId = Number(body.get("githubRepoId"));
        if (!Number.isSafeInteger(githubRepoId) || githubRepoId < 1) {
          return refusalPage("invalid-input", pageSession(session), { detail: "githubRepoId" });
        }
        try {
          return await build(session, githubRepoId);
        } catch (error) {
          if (error instanceof TokenRevoked) {
            return refusalPage("github-token-revoked", pageSession(session));
          }
          throw error;
        }
      },
    },
    {
      method: "POST",
      pattern: "/projects/:id/refresh",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        const body = await readForm(request.raw);
        checkMutation(deps.config, request.headers, session, body.get("csrf"));
        const project = await ownedProject(deps.db, session, request.params.id ?? "");
        if (project === null) return refusalPage("not-found", pageSession(session));
        try {
          return await build(session, project.githubRepoId, project);
        } catch (error) {
          if (error instanceof TokenRevoked) {
            return refusalPage("github-token-revoked", pageSession(session));
          }
          throw error;
        }
      },
    },
  ];
}
