import { z } from "zod";
import type { GitHubEndpoints } from "./endpoints.ts";

export class GitHubError extends Error {}
/** GitHub answered 401: the user revoked RepoWiki or the token expired. */
export class TokenRevoked extends Error {}

export const GitHubUser = z.object({
  id: z.int().positive(),
  login: z.string().min(1).max(39),
  name: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
});
export type GitHubUser = z.infer<typeof GitHubUser>;

/** `owner/name` in GitHub's own character set, so it can sit in a URL path as is. */
const FULL_NAME = /^[A-Za-z0-9-]{1,39}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

export const GitHubRepo = z.object({
  id: z.int().positive(),
  name: z.string().min(1),
  full_name: z.string().regex(FULL_NAME),
  owner: z.object({ login: z.string().min(1) }),
  private: z.boolean(),
  fork: z.boolean(),
  default_branch: z.string().min(1),
  size: z.number().nonnegative(),
  description: z.string().nullable(),
  html_url: z.string(),
  clone_url: z.string(),
  permissions: z
    .object({
      admin: z.boolean(),
      maintain: z.boolean().optional(),
      push: z.boolean(),
      triage: z.boolean().optional(),
      pull: z.boolean(),
    })
    .optional(),
});
export type GitHubRepo = z.infer<typeof GitHubRepo>;

const GitSha = z.string().regex(/^[0-9a-f]{40}$/);
const Commits = z.array(z.object({ sha: GitSha }));
const MAX_COUNT = 1000;
const MAX_REPO_PAGES = 10;

/** The `page` of a Link header's rel="last" URL. */
export function lastPage(link: string | null): number | null {
  if (link === null) return null;
  const last = link.split(",").find((part) => /rel="last"/.test(part));
  const url = last?.match(/<([^>]+)>/)?.[1];
  if (url === undefined) return null;
  const page = Number(URL.parse(url)?.searchParams.get("page"));
  return Number.isInteger(page) && page > 0 ? page : null;
}

export interface GitHubApi {
  user(token: string): Promise<GitHubUser>;
  /** Every public repository the user can see (owned, collaborator, organization member). */
  publicRepos(token: string): Promise<GitHubRepo[]>;
  repository(token: string, id: number): Promise<GitHubRepo | null>;
  /** Commits authored by `login`, capped at 1000; 0 when there are none or the repo is empty. */
  countCommits(token: string, fullName: string, login: string): Promise<number>;
  /** Up to `max` (at most 100) of `login`'s most recent commit shas. */
  commitShas(token: string, fullName: string, login: string, max: number): Promise<string[]>;
  /** The commit `branch` points at; null when the repository is empty or has no such branch. */
  headSha(token: string, fullName: string, branch: string): Promise<string | null>;
}

/** GitHub's REST API as the signed-in user, through `fetchFn` (spec 2 S8). */
export function githubApi(fetchFn: typeof fetch, endpoints: GitHubEndpoints): GitHubApi {
  /**
   * The response, or null for 404 (not there, or hidden), 409 (an empty repository) and any
   * status in `missing`.
   */
  async function get(
    token: string,
    path: string,
    missing: readonly number[] = [],
  ): Promise<Response | null> {
    const response = await fetchFn(`${endpoints.api}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "RepoWiki",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) throw new TokenRevoked("GitHub refused the token");
    if (response.status === 404 || response.status === 409) return null;
    if (missing.includes(response.status)) return null;
    if (!response.ok) {
      throw new GitHubError(`GitHub answered ${response.status} for ${path.split("?")[0]}`);
    }
    return response;
  }

  async function parse<T>(
    response: Response | null,
    schema: z.ZodType<T>,
    what: string,
  ): Promise<T | null> {
    if (response === null) return null;
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new GitHubError(`GitHub sent an unexpected ${what}`);
    return parsed.data;
  }

  const commitsPath = (fullName: string, login: string, perPage: number) => {
    if (!FULL_NAME.test(fullName)) throw new GitHubError("not a repository name");
    return `/repos/${fullName}/commits?author=${encodeURIComponent(login)}&per_page=${perPage}`;
  };

  return {
    async user(token) {
      const user = await parse(await get(token, "/user"), GitHubUser, "user");
      if (user === null) throw new GitHubError("GitHub has no user for this token");
      return user;
    },
    async publicRepos(token) {
      const all: GitHubRepo[] = [];
      for (let page = 1; page <= MAX_REPO_PAGES; page++) {
        const batch = await parse(
          await get(token, `/user/repos?type=all&sort=pushed&per_page=100&page=${page}`),
          z.array(GitHubRepo),
          "repository list",
        );
        if (batch === null) break;
        all.push(...batch.filter((repo) => !repo.private));
        if (batch.length < 100) break;
      }
      return all;
    },
    async repository(token, id) {
      return parse(await get(token, `/repositories/${id}`), GitHubRepo, "repository");
    },
    async countCommits(token, fullName, login) {
      const response = await get(token, commitsPath(fullName, login, 1));
      if (response === null) return 0;
      const pages = lastPage(response.headers.get("link"));
      const first = await parse(response, Commits, "commit list");
      return Math.min(pages ?? first?.length ?? 0, MAX_COUNT);
    },
    async commitShas(token, fullName, login, max) {
      const perPage = Math.min(Math.max(Math.floor(max), 1), 100);
      const response = await get(token, commitsPath(fullName, login, perPage));
      const commits = await parse(response, Commits, "commit list");
      return (commits ?? []).slice(0, max).map((c) => c.sha);
    },
    async headSha(token, fullName, branch) {
      if (!FULL_NAME.test(fullName)) throw new GitHubError("not a repository name");
      // 422: GitHub has no commit for that ref.
      const response = await get(
        token,
        `/repos/${fullName}/commits/${encodeURIComponent(branch)}`,
        [422],
      );
      const commit = await parse(response, z.object({ sha: GitSha }), "commit");
      return commit?.sha ?? null;
    },
  };
}
