import { describe, expect, it } from "vitest";
import { GitHubError, githubApi, lastPage, TokenRevoked } from "./api.ts";
import { fakeEndpoints } from "./endpoints.ts";
import { FAKE_COMMITS, FAKE_REPO, FAKE_TOKEN, FAKE_USER, fakeGitHubFetch } from "./fake.ts";

const endpoints = fakeEndpoints("http://127.0.0.1:8787");
const api = githubApi(fakeGitHubFetch(endpoints), endpoints);
const answering = (status: number, body: unknown = []) =>
  githubApi(async () => Response.json(body, { status }), endpoints);

describe("the GitHub API client (spec 2 S8)", () => {
  it("reads the user and a repository", async () => {
    expect(await api.user(FAKE_TOKEN)).toMatchObject({ id: FAKE_USER.id, login: FAKE_USER.login });
    expect(await api.repository(FAKE_TOKEN, FAKE_REPO.id)).toMatchObject({
      id: FAKE_REPO.id,
      full_name: FAKE_REPO.full_name,
      permissions: { push: true },
    });
    expect(await api.repository(FAKE_TOKEN, 1)).toBeNull();
  });

  it("counts commits from the Link header and caps at 1000", async () => {
    expect(await api.countCommits(FAKE_TOKEN, FAKE_REPO.full_name, FAKE_USER.login)).toBe(
      FAKE_COMMITS,
    );
    expect(await api.countCommits(FAKE_TOKEN, FAKE_REPO.full_name, "someone-else")).toBe(0);
    const many = githubApi(
      async () =>
        Response.json([{ sha: "a".repeat(40) }], {
          headers: { link: '<https://x/?per_page=1&page=5000>; rel="last"' },
        }),
      endpoints,
    );
    expect(await many.countCommits(FAKE_TOKEN, FAKE_REPO.full_name, FAKE_USER.login)).toBe(1000);
    expect(
      lastPage('<https://x?page=2>; rel="next", <https://x?per_page=1&page=5000>; rel="last"'),
    ).toBe(5000);
    expect(lastPage('<https://x?page=2>; rel="next"')).toBeNull();
    expect(lastPage(null)).toBeNull();
  });

  it("count no commits in an empty repository (GitHub answers 409)", async () => {
    const empty = answering(409, { message: "Git Repository is empty." });
    expect(await empty.countCommits(FAKE_TOKEN, FAKE_REPO.full_name, FAKE_USER.login)).toBe(0);
    expect(await empty.commitShas(FAKE_TOKEN, FAKE_REPO.full_name, FAKE_USER.login, 5)).toEqual([]);
  });

  it("lists commit shas up to the asked number", async () => {
    const shas = await api.commitShas(FAKE_TOKEN, FAKE_REPO.full_name, FAKE_USER.login, 10);
    expect(shas).toHaveLength(10);
    expect(shas[0]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("raises TokenRevoked on a 401 and GitHubError on anything else unexpected", async () => {
    await expect(api.user("revoked")).rejects.toBeInstanceOf(TokenRevoked);
    await expect(answering(500).user(FAKE_TOKEN)).rejects.toBeInstanceOf(GitHubError);
    await expect(answering(200, { id: "nope" }).user(FAKE_TOKEN)).rejects.toBeInstanceOf(
      GitHubError,
    );
    await expect(answering(404).user(FAKE_TOKEN)).rejects.toBeInstanceOf(GitHubError);
  });

  it("refuses a repository name that could leave its URL path", async () => {
    const odd = { ...FAKE_REPO, full_name: "demo-dev/../../user" };
    await expect(answering(200, odd).repository(FAKE_TOKEN, 1)).rejects.toBeInstanceOf(GitHubError);
    await expect(
      api.countCommits(FAKE_TOKEN, "demo-dev/x?author=y", FAKE_USER.login),
    ).rejects.toBeInstanceOf(GitHubError);
  });

  it("lists every page of repositories and keeps only public ones", async () => {
    const pages: Record<string, unknown[]> = {
      "1": Array.from({ length: 100 }, (_, i) => ({
        ...FAKE_REPO,
        id: i + 1,
        private: i % 2 === 1,
      })),
      "2": [{ ...FAKE_REPO, id: 500 }],
    };
    const asked: string[] = [];
    const paged = githubApi(async (input) => {
      const url = new URL(String(input));
      asked.push(`${url.pathname}?${url.searchParams}`);
      return Response.json(pages[url.searchParams.get("page") ?? "1"] ?? []);
    }, endpoints);
    const repos = await paged.publicRepos(FAKE_TOKEN);
    expect(repos).toHaveLength(51);
    expect(repos.every((r) => !r.private)).toBe(true);
    expect(repos.at(-1)?.id).toBe(500);
    expect(asked[0]).toBe("/_fake/github/api/user/repos?type=all&sort=pushed&per_page=100&page=1");
    expect(asked).toHaveLength(2);
  });
});

describe("headSha (spec 2 S8)", () => {
  it("reads the commit a branch points at", async () => {
    expect(await api.headSha(FAKE_TOKEN, FAKE_REPO.full_name, "main")).toMatch(/^[0-9a-f]{40}$/);
    expect(await api.headSha(FAKE_TOKEN, FAKE_REPO.full_name, "nope")).toBeNull();
  });

  it("gives null for an empty repository (409) and a missing ref (422)", async () => {
    expect(await answering(409).headSha(FAKE_TOKEN, FAKE_REPO.full_name, "main")).toBeNull();
    expect(await answering(422).headSha(FAKE_TOKEN, FAKE_REPO.full_name, "main")).toBeNull();
    await expect(
      answering(500).headSha(FAKE_TOKEN, FAKE_REPO.full_name, "main"),
    ).rejects.toBeInstanceOf(GitHubError);
  });
});
