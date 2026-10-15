import { EligibilityFacts } from "@repowiki/hosted";
import { describe, expect, it } from "vitest";
import { GitHubError, type GitHubRepo, githubApi } from "./api.ts";
import { fakeEndpoints } from "./endpoints.ts";
import { eligibilityFacts, permissionOf } from "./facts.ts";
import { FAKE_REPO, FAKE_TOKEN, FAKE_USER, fakeGitHubFetch } from "./fake.ts";

const endpoints = fakeEndpoints("http://127.0.0.1:8787");
const api = githubApi(fakeGitHubFetch(endpoints), endpoints);
const NOW = "2026-10-14T12:00:00.000Z";
const input = {
  githubUserId: FAKE_USER.id,
  login: FAKE_USER.login,
  githubRepoId: FAKE_REPO.id,
  now: NOW,
  indexedFiles: null,
};

describe("eligibility facts (spec 2 S8, Contract §7.2)", () => {
  it("come from the repository and the commit count", async () => {
    const { facts, repo } = await eligibilityFacts(api, FAKE_TOKEN, input);
    expect(repo?.id).toBe(FAKE_REPO.id);
    expect(facts).toEqual({
      checkedAt: NOW,
      githubUserId: FAKE_USER.id,
      githubRepoId: FAKE_REPO.id,
      fullName: FAKE_REPO.full_name,
      visibility: "public",
      isFork: false,
      permission: "admin",
      authoredCommits: 42,
      indexedFiles: null,
      tokenValid: true,
    });
    expect(EligibilityFacts.safeParse(facts).success).toBe(true);
  });

  it("report a revoked token, and a repository GitHub hides, as ineligible", async () => {
    const revoked = await eligibilityFacts(api, "revoked", { ...input, indexedFiles: 7 });
    expect(revoked.repo).toBeNull();
    expect(revoked.facts).toMatchObject({
      tokenValid: false,
      visibility: "private",
      authoredCommits: 0,
      indexedFiles: 7,
    });
    expect(EligibilityFacts.safeParse(revoked.facts).success).toBe(true);
    const gone = await eligibilityFacts(api, FAKE_TOKEN, { ...input, githubRepoId: 1 });
    expect(gone.repo).toBeNull();
    expect(gone.facts).toMatchObject({
      tokenValid: true,
      visibility: "private",
      permission: "none",
    });
    expect(EligibilityFacts.safeParse(gone.facts).success).toBe(true);
  });

  it("report a fork and a private repository as such", async () => {
    const as = (patch: Partial<GitHubRepo>) =>
      githubApi(async (url) => {
        const path = new URL(String(url)).pathname;
        return path.endsWith("/commits")
          ? Response.json([{ sha: "a".repeat(40) }])
          : Response.json({ ...FAKE_REPO, ...patch });
      }, endpoints);
    expect((await eligibilityFacts(as({ fork: true }), FAKE_TOKEN, input)).facts).toMatchObject({
      isFork: true,
      authoredCommits: 1,
    });
    const hidden = await eligibilityFacts(as({ private: true }), FAKE_TOKEN, input);
    expect(hidden.facts.visibility).toBe("private");
  });

  it("let any other GitHub failure through", async () => {
    const down = githubApi(async () => new Response("", { status: 503 }), endpoints);
    await expect(eligibilityFacts(down, FAKE_TOKEN, input)).rejects.toBeInstanceOf(GitHubError);
  });

  it("read the strongest permission GitHub reports, or none", () => {
    const repo = (permissions?: GitHubRepo["permissions"]) =>
      ({ ...FAKE_REPO, permissions }) as GitHubRepo;
    expect(
      permissionOf(repo({ admin: false, maintain: true, push: true, triage: true, pull: true })),
    ).toBe("maintain");
    expect(permissionOf(repo({ admin: false, push: true, pull: true }))).toBe("push");
    expect(permissionOf(repo({ admin: false, push: false, triage: true, pull: true }))).toBe(
      "triage",
    );
    expect(permissionOf(repo({ admin: false, push: false, pull: true }))).toBe("pull");
    expect(permissionOf(repo({ admin: false, push: false, pull: false }))).toBe("none");
    expect(permissionOf(repo(undefined))).toBe("none");
  });
});
