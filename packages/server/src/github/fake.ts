import type { Route } from "../http/router.ts";
import { redirect, text } from "../http/server.ts";
import type { GitHubEndpoints } from "./endpoints.ts";
import type { LocalProfile } from "./profile.ts";

/** The demo's GitHub (spec 2 S18): one user, one public repository they own, 42 commits. */
export const FAKE_TOKEN = "fake-token";
export const FAKE_CODE = "fake-code";
export const FAKE_COMMITS = 42;
/** The commit the fake repository's default branch points at. */
export const FAKE_HEAD = "d".repeat(40);

export const FAKE_USER = {
  id: 4242,
  login: "demo-dev",
  name: "Demo Developer",
  created_at: "2019-01-01T00:00:00Z",
};

export const FAKE_REPO = {
  id: 9090,
  name: "demo-repo",
  full_name: "demo-dev/demo-repo",
  owner: { login: "demo-dev" },
  private: false,
  fork: false,
  default_branch: "main",
  size: 120,
  description: "A small project the demo documents.",
  html_url: "https://github.com/demo-dev/demo-repo",
  clone_url: "https://github.com/demo-dev/demo-repo.git",
  permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
};

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

const urlOf = (input: string | URL | Request) =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** What a fake GitHub holds: one user and their repositories, each with its commits and head. */
interface FakeWorld {
  user: { id: number; login: string; name: string | null; created_at: string };
  repos: {
    repo: { id: number; full_name: string; default_branch: string };
    commits: number;
    commitShas: string[];
    head: string | null;
  }[];
}

/** A `fetch` that answers the GitHub calls RepoWiki makes, for the demo and the tests. */
export function fakeGitHubFetch(endpoints: GitHubEndpoints): typeof fetch {
  const commitShas = Array.from({ length: FAKE_COMMITS }, (_, i) =>
    (i + 1).toString(16).padStart(40, "0"),
  );
  return worldFetch(endpoints, {
    user: FAKE_USER,
    repos: [{ repo: FAKE_REPO, commits: FAKE_COMMITS, commitShas, head: FAKE_HEAD }],
  });
}

/**
 * The fake GitHub serving a local profile (M14g): the snapshot's user, repositories and commit
 * counts, with each repository's head the mapped export's, so its citations resolve.
 */
export function profileGitHubFetch(
  endpoints: GitHubEndpoints,
  profile: LocalProfile,
): typeof fetch {
  return worldFetch(endpoints, profile);
}

function worldFetch(endpoints: GitHubEndpoints, world: FakeWorld): typeof fetch {
  return async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const href = `${url.origin}${url.pathname}`;
    if (method === "POST" && href === `${endpoints.web}/login/oauth/access_token`) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      return body.get("code") === FAKE_CODE
        ? json({ access_token: FAKE_TOKEN, token_type: "bearer", scope: "" })
        : json({ error: "bad_verification_code" });
    }
    if (!href.startsWith(`${endpoints.api}/`)) return new Response("not found", { status: 404 });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${FAKE_TOKEN}`) {
      return json({ message: "Bad credentials" }, { status: 401 });
    }
    const path = href.slice(endpoints.api.length);
    if (path === "/user") return json(world.user);
    if (path === "/user/repos") {
      return json(
        Number(url.searchParams.get("page") ?? 1) > 1 ? [] : world.repos.map((r) => r.repo),
      );
    }
    const byId = world.repos.find((r) => path === `/repositories/${r.repo.id}`);
    if (byId !== undefined) return json(byId.repo);
    const entry = world.repos.find((r) => path.startsWith(`/repos/${r.repo.full_name}/commits`));
    if (entry === undefined) return json({ message: "Not Found" }, { status: 404 });
    const commitsPath = `/repos/${entry.repo.full_name}/commits`;
    if (path === commitsPath) {
      const author = url.searchParams.get("author") ?? "";
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      if (author.toLowerCase() !== world.user.login.toLowerCase() || entry.commits === 0) {
        return json([]);
      }
      const commits = entry.commitShas.slice(0, perPage).map((sha) => ({ sha }));
      const last = Math.ceil(entry.commits / perPage);
      const page = (n: number) =>
        `<${endpoints.api}${path}?author=${author}&per_page=${perPage}&page=${n}>`;
      const link = last > 1 ? `${page(2)}; rel="next", ${page(last)}; rel="last"` : "";
      return json(commits, { headers: link ? { link } : {} });
    }
    if (path === `${commitsPath}/${entry.repo.default_branch}`) {
      return entry.head === null
        ? json({ message: "Git Repository is empty." }, { status: 409 })
        : json({ sha: entry.head });
    }
    return json({ message: "Not Found" }, { status: 404 });
  };
}

/**
 * The fake authorize page a browser visits in fake mode: it approves at once and sends the
 * browser back to `callback` with the fake code. Any other `redirect_uri` is refused, so the
 * page cannot be used as an open redirect.
 */
export function fakeAuthorizeRoute(callback: string): Route {
  return {
    method: "GET",
    pattern: "/_fake/github/login/oauth/authorize",
    handler: async (request) => {
      if (request.query.get("redirect_uri") !== callback) {
        return text(400, "The fake GitHub only signs in to RepoWiki itself.");
      }
      const back = new URL(callback);
      back.searchParams.set("code", FAKE_CODE);
      back.searchParams.set("state", request.query.get("state") ?? "");
      return redirect(back.href, 302);
    },
  };
}
