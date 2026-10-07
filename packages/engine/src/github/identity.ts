import { spawnSync } from "node:child_process";
import { GITHUB_LOGIN, GITHUB_NAME } from "@repowiki/core";
import { gitFailureCause, scrubbedGitEnv } from "../index/index.ts";

/** A repository on github.com, by its validated owner and name (R24). */
export interface GitHubIdentity {
  owner: string;
  name: string;
}

/** The validated identity, or null: owner ^[A-Za-z0-9-]{1,39}$, name ^[A-Za-z0-9._-]{1,100}$. */
function identity(owner: string, name: string): GitHubIdentity | null {
  if (!GITHUB_LOGIN.test(owner) || !GITHUB_NAME.test(name) || name === "." || name === "..")
    return null;
  return { owner, name };
}

/** `--github owner/name`, or null when it is not one owner and one repository name. */
export function parseGitHubFlag(value: string): GitHubIdentity | null {
  const match = /^([^/]+)\/([^/]+)$/.exec(value);
  return match === null ? null : identity(match[1] ?? "", match[2] ?? "");
}

/**
 * The github.com repository a remote URL names, for the three forms git writes it in (R24):
 * `https://github.com/o/n(.git)`, `git@github.com:o/n(.git)` and `ssh://git@github.com/o/n(.git)`,
 * with an optional trailing slash. Anything else, another host or an SSH host alias included, is
 * null. The URL is only parsed: nothing ever fetches from it (R6).
 */
export function parseGitHubRemote(url: string): GitHubIdentity | null {
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url) ??
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  return match === null ? null : identity(match[1] ?? "", match[2] ?? "");
}

/**
 * The documented repository's `origin` URL as git itself would fetch from it (`git remote get-url
 * origin`: the first of several, after any insteadOf), never run or fetched here, or null when it
 * has none or git cannot say.
 */
export function readOriginUrl(repo: string): string | null {
  const origin = readOrigin(repo);
  return "url" in origin ? origin.url : null;
}

/** origin's URL, or why git gave none: a cause of RepoWiki's own environment, else null. */
function readOrigin(repo: string): { url: string } | { cause: string | null } {
  const out = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], {
    env: scrubbedGitEnv(),
    encoding: "utf8",
    timeout: 10_000,
  });
  if (out.error !== undefined) return { cause: null };
  if (out.status !== 0) return { cause: gitFailureCause(repo, out.stderr ?? "") ?? null };
  const url = out.stdout.trim();
  return url === "" ? { cause: null } : { url };
}

/**
 * Which GitHub repository documents `repo` (R24): `--github owner/name` when given, else the
 * origin remote's URL. A skip says why there is none, with the hint to pass --github.
 */
export function resolveGitHubIdentity(
  repo: string,
  flag: string | null,
): { identity: GitHubIdentity } | { skip: string } {
  if (flag !== null) {
    const parsed = parseGitHubFlag(flag);
    return parsed === null
      ? { skip: "--github must be owner/name, as GitHub spells them" }
      : { identity: parsed };
  }
  const origin = readOrigin(repo);
  if (!("url" in origin))
    return {
      skip: origin.cause ?? "the repository has no origin remote; pass --github owner/name",
    };
  const parsed = parseGitHubRemote(origin.url);
  return parsed === null
    ? { skip: "the origin remote is not a github.com repository; pass --github owner/name" }
    : { identity: parsed };
}
