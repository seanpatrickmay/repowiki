import { callbackUrl, type Deps } from "../app.ts";
import { safeEqual } from "../crypto.ts";
import { GitHubError, type GitHubUser, githubApi, TokenRevoked } from "../github/api.ts";
import {
  authorizeUrl,
  displayNameFor,
  exchangeCode,
  STATE_SECONDS,
  signedState,
  stateKey,
  stateValid,
} from "../github/oauth.ts";
import { readForm } from "../http/body.ts";
import { parseCookies, serializeCookie } from "../http/cookies.ts";
import type { Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { checkMutation, currentSession, secureCookies, sessionSetCookie } from "../http/session.ts";
import { escapeHtml, page } from "../pages/layout.ts";
import { signIn } from "../store/accounts.ts";
import { saveGitHubToken } from "../store/github-tokens.ts";
import { createSession, endSession, SESSION_DAYS } from "../store/sessions.ts";

/** A sign-in that went wrong, as a page; `headers` clears the state cookie. */
const failurePage = (
  status: number,
  title: string,
  message: string,
  headers: Record<string, string> = {},
) =>
  html(
    status,
    page({
      title,
      body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to RepoWiki</a></p>`,
      session: null,
    }),
    headers,
  );

/** GitHub could not be reached or answered nonsense: a network failure, a timeout, a bad reply. */
const unreachable = (error: unknown) =>
  error instanceof GitHubError ||
  error instanceof TokenRevoked ||
  error instanceof TypeError ||
  (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name));

/** Sign-in with GitHub and sign-out (spec 2 S6, S7). */
export function authRoutes(deps: Deps): Route[] {
  const redirectUri = callbackUrl(deps.config);
  const secure = secureCookies(deps.config);
  const stateName = secure ? "__Host-oauth_state" : "oauth_state";
  const key = stateKey(deps.config.tokenKey);
  const stateCookie = (value: string, maxAgeSeconds: number) =>
    serializeCookie(stateName, value, { maxAgeSeconds, secure, httpOnly: true });
  const client =
    deps.config.github.kind === "oauth"
      ? deps.config.github
      : { clientId: "fake-client", clientSecret: "fake-secret" };
  const nowMs = () => Date.parse(deps.now());
  /** Every failed callback clears the state cookie, so a stale one never lingers. */
  const failure = (status: number, title: string, message: string) =>
    failurePage(status, title, message, { "set-cookie": stateCookie("", 0) });
  const api = githubApi(deps.fetch, deps.github);

  return [
    {
      method: "GET",
      pattern: "/auth/github",
      handler: async () => {
        const state = signedState(key, nowMs());
        const reply = redirect(authorizeUrl(deps.github, client.clientId, redirectUri, state));
        return {
          ...reply,
          headers: { ...reply.headers, "set-cookie": stateCookie(state, STATE_SECONDS) },
        };
      },
    },
    {
      method: "GET",
      pattern: "/auth/github/callback",
      handler: async (request) => {
        const cookieHeader = request.headers.cookie;
        const expected = parseCookies(Array.isArray(cookieHeader) ? undefined : cookieHeader).get(
          stateName,
        );
        const state = request.query.get("state");
        const code = request.query.get("code");
        if (request.query.get("error") === "access_denied") {
          return failure(400, "Sign-in cancelled", "You cancelled the sign-in on GitHub.");
        }
        if (
          !expected ||
          !state ||
          !code ||
          !safeEqual(state, expected) ||
          !stateValid(key, state, nowMs())
        ) {
          return failure(
            400,
            "Sign-in failed",
            "The sign-in link expired or was not started here. Try again.",
          );
        }
        const unanswered = () =>
          failure(502, "Sign-in failed", "GitHub could not be reached. Try again.");
        let token: string | null;
        try {
          token = await exchangeCode(deps.fetch, deps.github, { ...client, code, redirectUri });
        } catch (error) {
          if (!unreachable(error)) throw error;
          return unanswered();
        }
        if (token === null) {
          return failure(400, "Sign-in failed", "GitHub did not confirm the sign-in. Try again.");
        }
        let user: GitHubUser;
        try {
          user = await api.user(token);
        } catch (error) {
          if (!unreachable(error)) throw error;
          return failure(502, "Sign-in failed", "GitHub did not return your profile. Try again.");
        }
        const allowlist = new Set(deps.config.signupAllowlist);
        const signedIn = await signIn(
          deps.db,
          {
            githubUserId: user.id,
            login: user.login,
            displayName: displayNameFor(user.name, user.login),
            githubCreatedAt: new Date(user.created_at).toISOString(),
          },
          {
            newAccountId: deps.newId(),
            allowNew: (login) => deps.config.mode === "demo" || allowlist.has(login),
            now: deps.now(),
            plan: deps.config.localPlan,
          },
        );
        if (signedIn === null) {
          return failure(
            403,
            "Not yet",
            "RepoWiki is invite-only for now. Ask for an invitation and sign in again once you have one.",
          );
        }
        await deps.db.transaction((tx) =>
          saveGitHubToken(tx, deps.config.tokenKey, signedIn.account.id, token),
        );
        const session = await createSession(deps.db, signedIn.account.id, deps.now());
        return {
          status: 303,
          headers: {
            location: "/dashboard",
            "set-cookie": [
              sessionSetCookie(deps.config, session.token, SESSION_DAYS * 86_400),
              stateCookie("", 0),
            ],
          },
        };
      },
    },
    {
      method: "POST",
      pattern: "/auth/signout",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        const form = await readForm(request.raw);
        checkMutation(deps.config, request.headers, session, form.get("csrf"));
        await endSession(deps.db, session.token);
        return {
          status: 303,
          headers: { location: "/", "set-cookie": sessionSetCookie(deps.config, "", 0) },
        };
      },
    },
  ];
}
