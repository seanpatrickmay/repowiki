import { spawn } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_REPO_BYTES = 512 * 1024 * 1024;
export const CLONE_TIMEOUT_MS = 5 * 60_000;
const CHECK_TIMEOUT_MS = 60_000;
const CLONE_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;

export type CloneResult =
  | { ok: true }
  | { ok: false; code: "repo-too-large" | "job-failed"; detail: string };

/** Git with no user or system configuration and no prompts. */
export function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LC_ALL: "C",
  };
}

export function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
  }
  return total;
}

/**
 * Runs git in its own process group with no output, resolving to its exit status; past
 * `timeoutMs` the whole group (git and the helpers it started) is killed and "timeout" returned.
 * Never rejects: a git that cannot start is status null.
 */
function runGit(
  git: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<number | null | "timeout"> {
  return new Promise((resolve) => {
    const child = spawn(git, args, { env, stdio: "ignore", detached: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve(timedOut ? "timeout" : status);
    });
  });
}

/**
 * Phase 1's only use of the network (spec 2 S9): a bare, tagless clone of a public GitHub
 * repository over HTTPS, refused when GitHub's size or the clone's passes the limit. Async, so
 * the worker's heartbeats keep the lease while it runs (amendment A1).
 */
export async function cloneBare(input: {
  url: string;
  sha: string;
  dir: string;
  sizeKb: number;
  home: string;
  git?: string;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<CloneResult> {
  const maxBytes = input.maxBytes ?? MAX_REPO_BYTES;
  const git = input.git ?? "git";
  const env = gitEnv(input.home);
  if (!CLONE_URL.test(input.url)) {
    return { ok: false, code: "job-failed", detail: "not a GitHub clone URL" };
  }
  if (input.sizeKb * 1024 > maxBytes) {
    return {
      ok: false,
      code: "repo-too-large",
      detail: "GitHub reports the repository over the size limit",
    };
  }
  const cloned = await runGit(
    git,
    [
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "clone",
      "--bare",
      "--no-tags",
      "--quiet",
      "--",
      input.url,
      input.dir,
    ],
    env,
    input.timeoutMs ?? CLONE_TIMEOUT_MS,
  );
  if (cloned !== 0) {
    rmSync(input.dir, { recursive: true, force: true });
    return {
      ok: false,
      code: "job-failed",
      detail: cloned === "timeout" ? "clone timed out" : "clone failed",
    };
  }
  if (dirBytes(input.dir) > maxBytes) {
    rmSync(input.dir, { recursive: true, force: true });
    return { ok: false, code: "repo-too-large", detail: "the clone is over the size limit" };
  }
  const has = await runGit(
    git,
    ["-C", input.dir, "cat-file", "-e", `${input.sha}^{commit}`],
    env,
    CHECK_TIMEOUT_MS,
  );
  if (has !== 0) return { ok: false, code: "job-failed", detail: "the commit is not in the clone" };
  return { ok: true };
}
