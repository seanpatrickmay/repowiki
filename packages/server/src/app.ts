import type { Config } from "./config.ts";
import type { Db } from "./db/db.ts";
import type { GitHubEndpoints } from "./github/endpoints.ts";
import { fakeAuthorizeRoute } from "./github/fake.ts";
import { HttpError } from "./http/body.ts";
import { createRouter, type Reply, type Route } from "./http/router.ts";
import { type App, html, text } from "./http/server.ts";
import { renewalCookie } from "./http/session.ts";
import type { ObjectStore } from "./objects/store.ts";
import {
  BIOGRAPHY_STYLE,
  BIOGRAPHY_STYLE_PATH,
  SILHOUETTE_PATH,
  SILHOUETTE_SVG,
} from "./pages/biography-style.ts";
import { escapeHtml, page, STYLE, STYLE_PATH } from "./pages/layout.ts";
import type { JobRunner } from "./runner/runner.ts";

/** Everything a route needs from outside (spec 2 §4); tests pass fakes. */
export interface Deps {
  config: Config;
  db: Db;
  /** Every call to GitHub goes through this `fetch` (the fake in the demo and in tests). */
  fetch: typeof fetch;
  github: GitHubEndpoints;
  now: () => string;
  newId: () => string;
  /** Starts job attempts: a child process locally, a Fly Machine in production (spec 2 S16). */
  runner: JobRunner;
  /** Exports, previews and published sites (spec 2 S12). */
  objects: ObjectStore;
  /** Where the LLM proxy forwards model calls; `key` null means no provider is configured. */
  anthropic: { url: string; key: string | null; fetch: typeof fetch };
  /** One JSON line per event; never given a secret. Defaults to stderr. */
  log?: (line: object) => void;
}

/** The deps' log, or one JSON line on stderr. */
export const logOf = (deps: Pick<Deps, "log">) =>
  deps.log ?? ((line: object) => process.stderr.write(`${JSON.stringify(line)}\n`));

/** An error's name for a log line: never its message, which may carry a secret. */
export const nameOf = (error: unknown) => (error instanceof Error ? error.name : "unknown");

export const callbackUrl = (config: Config) => `${config.appOrigin}/auth/github/callback`;

const fileRoute = (pattern: string, body: string, type = "text/css; charset=utf-8"): Route => ({
  method: "GET",
  pattern,
  handler: async () => ({
    status: 200,
    headers: { "content-type": type, "cache-control": "public, max-age=300" },
    body,
  }),
});
/** The app's style sheet; the biography uses its own and the silhouette, on the pages host. */
const appStyle = fileRoute(STYLE_PATH, STYLE);
const pagesFiles = [
  fileRoute(BIOGRAPHY_STYLE_PATH, BIOGRAPHY_STYLE),
  fileRoute(SILHOUETTE_PATH, SILHOUETTE_SVG, "image/svg+xml"),
];

/**
 * The reply plus a slid session's cookie, unless the reply already sets or clears that cookie. A
 * reply carrying a session cookie is never cached.
 */
function withRenewal(reply: Reply, cookie: string | undefined): Reply {
  if (cookie === undefined) return reply;
  const name = `${cookie.slice(0, cookie.indexOf("="))}=`;
  const set = [reply.headers?.["set-cookie"] ?? []].flat();
  if (set.some((c) => c.startsWith(name))) return reply;
  const headers = { ...reply.headers, "set-cookie": [...set, cookie] };
  return { ...reply, headers: { ...headers, "cache-control": "private, no-store" } };
}

/** An HttpError as the reply `listen` would send for it. */
function errorReply(error: HttpError): Reply {
  const base = text(error.status, error.message);
  return { ...base, headers: { ...base.headers, ...error.headers } };
}

/**
 * The routes, the style sheets, and in fake mode the fake GitHub's authorize page. The pages host
 * (ADR-0012) gets only the biography's style sheet and silhouette, and answers an unknown path in
 * plain text.
 */
export function createApp(
  deps: Deps,
  routes: readonly Route[],
  options: { host: "app" | "pages" } = { host: "app" },
): App {
  const pages = options.host === "pages";
  const fake =
    deps.config.github.kind === "fake" && !pages
      ? [fakeAuthorizeRoute(callbackUrl(deps.config))]
      : [];
  const route = createRouter([...(pages ? pagesFiles : [appStyle]), ...fake, ...routes]);
  return async (request) => {
    const found = route(request.method, request.path);
    if ("handler" in found) {
      let reply: Reply;
      try {
        reply = await found.handler({ ...request, params: found.params });
      } catch (error) {
        // A refusal after the session slid still renews it; anything else is listen's to hide.
        if (!(error instanceof HttpError)) throw error;
        reply = errorReply(error);
      }
      return withRenewal(reply, renewalCookie(request));
    }
    if (found.status === 405) return text(405, "Method not allowed.");
    if (pages) return text(404, "Not found.");
    const body = `<h1>Not found</h1><p class="muted">${escapeHtml(request.path)} is not a page on RepoWiki.</p>`;
    return html(404, page({ title: "Not found", body, session: null }));
  };
}
