import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "@repowiki/llm";

/** The repository root, where the engine's CLIs live. */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const CLI = {
  manifest: "scripts/manifest-build.ts",
  wiki: "scripts/wiki-build.ts",
  people: "scripts/wiki-people.ts",
} as const;

/**
 * The proxy's cost refusal as an engine CLI prints it: the Anthropic SDK puts the error body,
 * `{"type":"rate_limit_error","message":"job-cost-cap"}`, in its message, and the engine keeps it.
 */
export const COST_CAP_MARK = '"message":"job-cost-cap"';
const TAIL_BYTES = 4096;

export interface CliRun {
  status: number | null;
  /** The last 4 KB of stderr. */
  stderrTail: string;
  timedOut: boolean;
  /** Whether stderr, anywhere, shows the proxy refusing a call on the job's cost cap. */
  costCapped: boolean;
}

/**
 * Run one engine CLI with exactly `env`, in its own process group so a timeout kills the git
 * children too; stdout is dropped and the last 4 KB of stderr kept.
 */
export function runCli(input: {
  script: string;
  args: readonly string[];
  env: Record<string, string>;
  timeoutMs: number;
  cwd?: string;
}): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [input.script, ...input.args], {
      env: input.env,
      cwd: input.cwd ?? ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    let tail = "";
    let costCapped = false;
    let timedOut = false;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const joined = `${tail}${chunk}`;
      if (joined.includes(COST_CAP_MARK)) costCapped = true;
      tail = joined.slice(-TAIL_BYTES);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, input.timeoutMs);
    const done = (status: number | null) => {
      clearTimeout(timer);
      resolve({ status, stderrTail: tail, timedOut, costCapped });
    };
    child.on("error", () => done(null));
    child.on("close", (status) => done(status));
  });
}

/** What an engine CLI may see (spec 2 S9, §10): the proxy as Anthropic, the job token as its key. */
export function engineEnv(input: {
  home: string;
  llmUrl: string;
  token: string;
}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: input.home,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ANTHROPIC_BASE_URL: input.llmUrl,
    ANTHROPIC_API_KEY: input.token,
  };
}

const ANTHROPIC = /^https:\/\/api\.anthropic\.com(?=\/|$)/;

/** A fetch that sends Anthropic API calls to the proxy, for the worker's own suggestions call. */
export function rebasedFetch(llmUrl: string, fetchFn: FetchLike = fetch): FetchLike {
  return (input, init) => {
    if (input instanceof Request) {
      return fetchFn(new Request(input.url.replace(ANTHROPIC, llmUrl), input), init);
    }
    return fetchFn(String(input).replace(ANTHROPIC, llmUrl), init);
  };
}
