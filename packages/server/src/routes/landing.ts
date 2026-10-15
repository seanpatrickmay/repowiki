import type { Deps } from "../app.ts";
import type { Route } from "../http/router.ts";
import { html } from "../http/server.ts";
import { currentSession } from "../http/session.ts";
import { page } from "../pages/layout.ts";
import { pageSession } from "../pages/refusal.ts";

/** `GET /`: what RepoWiki does and the way in (spec 2 §7); Fly's health check reads it too. */
export function landingRoutes(deps: Deps): Route[] {
  return [
    {
      method: "GET",
      pattern: "/",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        const action =
          session === null
            ? `<p><a href="/auth/github">Sign in with GitHub</a> to build a page for one of your public repositories.</p>`
            : `<p><a href="/dashboard">Go to your projects</a>.</p>`;
        const body = `<h1>RepoWiki</h1><p>A project page for a public repository you worked on, with a cited wiki of the code and an account of your part in it, reviewed by you before anyone sees it.</p>${action}`;
        const shown = session === null ? null : pageSession(session);
        return html(200, page({ title: "Home", body, session: shown }));
      },
    },
  ];
}
