import { spawnSync } from "node:child_process";

/** One `gh` run: its exit status and output, or why it never finished. */
export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** missing: no gh on PATH; timeout: past GH_TIMEOUT_MS; overflow: past GH_MAX_OUTPUT_BYTES. */
  failure: "missing" | "timeout" | "overflow" | "failed" | null;
}

/** Runs `gh` with an argv (never a shell). Tests pass a fake. */
export type GhRunner = (args: readonly string[]) => GhResult;

export const GH_TIMEOUT_MS = 60_000;
export const GH_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * The environment `gh` runs with (R25): the caller's, without any ANTHROPIC_* variable, and with
 * prompts, the update notifier and colour off.
 */
export function ghEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of Object.keys(env)) if (name.startsWith("ANTHROPIC_")) delete env[name];
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  env.NO_COLOR = "1";
  return env;
}

/** The real runner: `gh` from PATH, argv only, 60 s and 32 MiB at most. */
export const spawnGh: GhRunner = (args) => {
  const out = spawnSync("gh", args, {
    env: ghEnv(),
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_MAX_OUTPUT_BYTES,
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
};
