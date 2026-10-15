/** Where GitHub's web (OAuth) and API hosts are; the fake GitHub lives under our own origin. */
export interface GitHubEndpoints {
  web: string;
  api: string;
}

export const GITHUB: GitHubEndpoints = { web: "https://github.com", api: "https://api.github.com" };

export function fakeEndpoints(origin: string): GitHubEndpoints {
  return { web: `${origin}/_fake/github`, api: `${origin}/_fake/github/api` };
}
