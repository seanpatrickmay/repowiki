import { spawn } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_REPO_BYTES = 512 * 1024 * 1024;
export const CLONE_TIMEOUT_MS = 5 * 60_000;
/** How often a running clone's size is checked against the limit. */
export const CLONE_POLL_MS = 2_000;
const NO_SPACE = /No space left on device|ENOSPC/i;
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

/** The bytes under `dir`, or 0 while it does not exist yet (a clone that has not started). */
function bytesSoFar(dir: string): number {
  try {
    return dirBytes(dir);
  } catch {
    return 0;
  }
}

interface GitRun {
  /** Git's exit status; null when it could not start or was killed. */
  status: number | null;
  timedOut: boolean;
  /** Killed because `watch.over()` said so. */
  stopped: boolean;
  /** The last 4 KB of stderr, only ever matched, never logged. */
  stderr: string;
}

/**
 * Runs git in its own process group with no stdout, keeping the end of stderr; past `timeoutMs`,
 * or when `watch.over()` turns true on one of its checks every `watch.everyMs`, the whole group
 * (git and the helpers it started) is killed. Never rejects.
 */
function runGit(
  git: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
  watch?: { everyMs: number; over: () => boolean },
  signal?: AbortSignal,
): Promise<GitRun> {
  return new Promise((resolve) => {
    const child = spawn(git, args, { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
    let timedOut = false;
    let stopped = false;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const poll =
      watch === undefined
        ? undefined
        : setInterval(() => {
            if (!stopped && watch.over()) {
              stopped = true;
              kill();
            }
          }, watch.everyMs);
    signal?.addEventListener("abort", kill);
    if (signal?.aborted) kill();
    let settled = false;
    const done = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", kill);
      resolve({ status, timedOut, stopped, stderr });
    };
    child.on("error", () => done(null));
    child.on("close", (status) => done(status));
  });
}

/**
 * Phase 1's only use of the network (spec 2 S9): a bare, tagless clone of a public GitHub
 * repository over HTTPS, refused when GitHub's size passes the limit, when the clone grows past
 * it (checked every `pollMs` while git runs, and once after), or when the disk fills. Async, so
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
  pollMs?: number;
  /** Aborting it kills the clone's process group (the lease was lost). */
  signal?: AbortSignal;
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
    { everyMs: input.pollMs ?? CLONE_POLL_MS, over: () => bytesSoFar(input.dir) > maxBytes },
    input.signal,
  );
  if (cloned.stopped || (cloned.status !== 0 && NO_SPACE.test(cloned.stderr))) {
    rmSync(input.dir, { recursive: true, force: true });
    return { ok: false, code: "repo-too-large", detail: "the clone passed the size limit" };
  }
  if (cloned.status !== 0) {
    rmSync(input.dir, { recursive: true, force: true });
    return {
      ok: false,
      code: "job-failed",
      detail: cloned.timedOut ? "clone timed out" : "clone failed",
    };
  }
  if (bytesSoFar(input.dir) > maxBytes) {
    rmSync(input.dir, { recursive: true, force: true });
    return { ok: false, code: "repo-too-large", detail: "the clone is over the size limit" };
  }
  const has = await runGit(
    git,
    ["-C", input.dir, "cat-file", "-e", `${input.sha}^{commit}`],
    env,
    CHECK_TIMEOUT_MS,
  );
  if (has.status !== 0) {
    return { ok: false, code: "job-failed", detail: "the commit is not in the clone" };
  }
  return { ok: true };
}
