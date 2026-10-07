import { spawnSync } from "node:child_process";

/**
 * One `gh` run: its exit status and output, or why it never finished. `failure` null with a
 * status means gh ran (0, or its own error code); null with a null status means a signal stopped
 * it. Check `failure` before parsing: an overflow still holds the output read so far.
 */
export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /**
   * missing: no gh on PATH; timeout: past the time limit; overflow: past the output cap; failed:
   * any other spawn error.
   */
  failure: "missing" | "timeout" | "overflow" | "failed" | null;
}

/** Runs `gh` with an argv (never a shell). Tests pass a fake. */
export type GhRunner = (args: readonly string[]) => GhResult;

export const GH_TIMEOUT_MS = 60_000;
export const GH_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** What would point gh at another host or repository, print its traffic, or open a program. */
export const REDIRECTING_GH_ENV: readonly string[] = [
  "GH_HOST",
  "GH_REPO",
  "GH_DEBUG",
  "GH_PAGER",
  "GH_BROWSER",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/**
 * The environment `gh` runs with (R25): the caller's, keeping what picks the owner's own account
 * (GH_TOKEN, GITHUB_TOKEN, GH_CONFIG_DIR), without any ANTHROPIC_* or GIT_* variable or one that
 * redirects gh (REDIRECTING_GH_ENV), and with prompts, the update notifier and colour off. Every
 * call also names its host (`--hostname github.com`).
 */
export function ghEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ANTHROPIC_") || name.startsWith("GIT_")) delete env[name];
    if (REDIRECTING_GH_ENV.includes(name)) delete env[name];
  }
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  env.NO_COLOR = "1";
  return env;
}

/** A runner of `gh` from PATH, argv only, stopped after `timeoutMs` and `maxBytes` of output. */
export function ghRunner(limits: { timeoutMs?: number; maxBytes?: number } = {}): GhRunner {
  return (args) =>
    runGh(args, limits.timeoutMs ?? GH_TIMEOUT_MS, limits.maxBytes ?? GH_MAX_OUTPUT_BYTES);
}

/** The real runner: `gh` from PATH, argv only, 60 s and 32 MiB at most. */
export const spawnGh: GhRunner = ghRunner();

function runGh(args: readonly string[], timeoutMs: number, maxBytes: number): GhResult {
  const out = spawnSync("gh", args, {
    env: ghEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: maxBytes,
  });
  const code = (out.error as NodeJS.ErrnoException | undefined)?.code;
  const failure =
    out.error === undefined
      ? null
      : code === "ENOENT"
        ? "missing"
        : code === "ETIMEDOUT"
          ? "timeout"
          : code === "ENOBUFS"
            ? "overflow"
            : "failed";
  return { status: out.status, stdout: out.stdout ?? "", stderr: out.stderr ?? "", failure };
}
