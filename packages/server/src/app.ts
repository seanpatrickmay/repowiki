import type { Config } from "./config.ts";
import type { Db } from "./db/db.ts";
import type { GitHubEndpoints } from "./github/endpoints.ts";
import { fakeAuthorizeRoute } from "./github/fake.ts";
import { createRouter, type Route } from "./http/router.ts";
import { type App, html, text } from "./http/server.ts";
import { escapeHtml, page, STYLE, STYLE_PATH } from "./pages/layout.ts";

/** Everything a route needs from outside (spec 2 §4); tests pass fakes. */
export interface Deps {
  config: Config;
  db: Db;
  /** Every call to GitHub goes through this `fetch` (the fake in the demo and in tests). */
  fetch: typeof fetch;
  github: GitHubEndpoints;
  now: () => string;
  newId: () => string;
}

export const callbackUrl = (config: Config) => `${config.origin}/auth/github/callback`;

const styleRoute: Route = {
  method: "GET",
  pattern: STYLE_PATH,
  handler: async () => ({
    status: 200,
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" },
    body: STYLE,
  }),
};

/** The routes, the style sheet, and in fake mode the fake GitHub's authorize page. */
export function createApp(deps: Deps, routes: readonly Route[]): App {
  const fake =
    deps.config.github.kind === "fake" ? [fakeAuthorizeRoute(callbackUrl(deps.config))] : [];
  const route = createRouter([styleRoute, ...fake, ...routes]);
  return async (request) => {
    const found = route(request.method, request.path);
    if ("handler" in found) return found.handler({ ...request, params: found.params });
    if (found.status === 405) return text(405, "Method not allowed.");
    const body = `<h1>Not found</h1><p class="muted">${escapeHtml(request.path)} is not a page on RepoWiki.</p>`;
    return html(404, page({ title: "Not found", body, session: null }));
  };
}
