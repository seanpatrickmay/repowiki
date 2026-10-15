import type { Deps } from "../app.ts";
import { type GitHubRepo, githubApi, TokenRevoked } from "../github/api.ts";
import { eligibilityFacts } from "../github/facts.ts";
import { readForm } from "../http/body.ts";
import type { Reply, Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { checkMutation, currentSession, type Session } from "../http/session.ts";
import { escapeHtml, type PageSession, page } from "../pages/layout.ts";
import { refusalPage } from "../pages/refusal.ts";
import { readGitHubToken } from "../store/github-tokens.ts";
import { issueToken } from "../store/jobs.ts";
import { projectsOf } from "../store/projects.ts";
import { startGeneration } from "../store/start.ts";

export const pageSession = (s: Session): PageSession => ({ csrf: s.csrf, login: s.account.login });

function dashboard(session: Session, repos: GitHubRepo[], projects: string): string {
  const csrf = escapeHtml(session.csrf);
  const choices = repos
    .map(
      (
        r,
      ) => `<li class="card"><strong>${escapeHtml(r.full_name)}</strong><p class="muted">${escapeHtml(r.description ?? "")}</p>
<form method="post" action="/projects"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="githubRepoId" value="${r.id}"><button>Build project page</button></form></li>`,
    )
    .join("");
  return `<h1>Your projects</h1>${projects || `<p class="muted">No projects yet.</p>`}
<h2>Your public repositories</h2><p class="muted">RepoWiki builds a page for a public repository you can push to and have commits in.</p><ul class="plain">${choices || "<li>No public repositories found.</li>"}</ul>`;
}

/** The dashboard and starting a project (spec 2 §7). */
export function projectRoutes(deps: Deps): Route[] {
  const api = githubApi(deps.fetch, deps.github);

  /** `POST /projects` once the session and form are checked. */
  async function build(session: Session, githubRepoId: number): Promise<Reply> {
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
    const started = await startGeneration(deps.db, {
      account,
      facts,
      repo,
      commitSha,
      commitShas,
      now,
      newId: deps.newId,
    });
    if (!started.ok) return refusalPage(started.code, shown);
    const { project, job, created } = started.value;
    if (created) {
      const jobToken = await issueToken(deps.db, job.id, job.attempt, now);
      // A failed start leaves the job queued with its token; the sweeper restarts it (S16).
      await deps.runner
        .start({ jobId: job.id, attempt: job.attempt, token: jobToken })
        .catch(() => undefined);
    }
    return redirect(`/projects/${project.id}`);
  }

  return [
    {
      method: "GET",
      pattern: "/dashboard",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request.headers, deps.now());
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
        const projects = (await projectsOf(deps.db, session.account.id))
          .map(
            (p) =>
              `<li><a href="/projects/${escapeHtml(p.id)}">${escapeHtml(p.slug)}</a> <span class="muted">${escapeHtml(p.state)}</span></li>`,
          )
          .join("");
        const body = dashboard(session, repos, projects && `<ul>${projects}</ul>`);
        return html(200, page({ title: "Dashboard", body, session: pageSession(session) }));
      },
    },
    {
      method: "POST",
      pattern: "/projects",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request.headers, deps.now());
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
  ];
}
