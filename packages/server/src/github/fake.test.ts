import { describe, expect, it } from "vitest";
import { githubApi } from "./api.ts";
import { fakeEndpoints } from "./endpoints.ts";
import { FAKE_TOKEN, profileGitHubFetch } from "./fake.ts";
import { ADA_HEAD, adaProfile } from "./test-profile.ts";

const endpoints = fakeEndpoints("http://127.0.0.1:8787");
const profile = adaProfile();
const api = githubApi(profileGitHubFetch(endpoints, profile), endpoints);

describe("the fake GitHub serving a local profile (M14g)", () => {
  it("answers the profile's user and repositories through the real client", async () => {
    expect(await api.user(FAKE_TOKEN)).toEqual(profile.user);
    expect((await api.publicRepos(FAKE_TOKEN)).map((r) => r.full_name)).toEqual([
      "ada/engine",
      "ada/empty",
    ]);
    expect(await api.repository(FAKE_TOKEN, 8001)).toMatchObject({
      full_name: "ada/engine",
      permissions: { admin: true },
    });
    expect(await api.repository(FAKE_TOKEN, 4242)).toBeNull();
  });

  it("counts the author's commits and serves the export's head", async () => {
    expect(await api.countCommits(FAKE_TOKEN, "ada/engine", "Ada")).toBe(30);
    expect(await api.countCommits(FAKE_TOKEN, "ada/engine", "someone-else")).toBe(0);
    expect(await api.commitShas(FAKE_TOKEN, "ada/engine", "ada", 5)).toEqual(
      profile.repos[0]?.commitShas.slice(0, 5),
    );
    expect(await api.headSha(FAKE_TOKEN, "ada/engine", "main")).toBe(ADA_HEAD);
    expect(await api.headSha(FAKE_TOKEN, "ada/engine", "other")).toBeNull();
    expect(await api.countCommits(FAKE_TOKEN, "ada/empty", "ada")).toBe(0);
    expect(await api.headSha(FAKE_TOKEN, "ada/empty", "main")).toBeNull();
  });

  it("is a 404 for a repository the profile does not hold, and 401 without the token", async () => {
    expect(await api.countCommits(FAKE_TOKEN, "demo-dev/demo-repo", "ada")).toBe(0);
    await expect(api.user("other")).rejects.toThrow(/refused/);
  });
});
