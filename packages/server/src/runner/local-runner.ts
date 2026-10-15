import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRunner } from "./runner.ts";

export interface LocalRunnerOptions {
  /** The worker's entry script, run with this Node. */
  workerEntry: string;
  /** The server's URL as the worker reaches it. */
  internalUrl: string;
  mode: "fixture" | "engine";
  log: (line: object) => void;
}

/**
 * The worker as a child process with a scrubbed environment: development and the demo only. It
 * has no firewall; production uses the Fly runner (spec 2 S16). The token is never logged.
 */
export function localRunner(options: LocalRunnerOptions): JobRunner {
  return {
    async start({ jobId, attempt, token }) {
      const home = mkdtempSync(join(tmpdir(), "repowiki-worker-"));
      const child = spawn(process.execPath, [options.workerEntry], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          REPOWIKI_API_URL: options.internalUrl,
          REPOWIKI_JOB_TOKEN: token,
          REPOWIKI_WORKER_MODE: options.mode,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000);
      });
      child.on("error", (error) => options.log({ worker: jobId, attempt, error: error.name }));
      child.on("exit", (code) =>
        options.log({ worker: jobId, attempt, exit: code, ...(code === 0 ? {} : { stderr }) }),
      );
    },
  };
}
