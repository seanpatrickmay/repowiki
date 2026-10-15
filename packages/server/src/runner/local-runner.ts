import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
  /** The Node binary that runs the worker; this process's by default. */
  execPath?: string;
}

/**
 * The worker as a child process with a scrubbed environment: development and the demo only. It
 * has no firewall; production uses the Fly runner (spec 2 S16). The token is never logged.
 */
export function localRunner(options: LocalRunnerOptions): JobRunner {
  return {
    start({ jobId, attempt, token }) {
      const home = mkdtempSync(join(tmpdir(), "repowiki-worker-"));
      const cleanUp = () => rmSync(home, { recursive: true, force: true });
      const child = spawn(options.execPath ?? process.execPath, [options.workerEntry], {
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
      child.on("exit", (code) => {
        cleanUp();
        options.log({ worker: jobId, attempt, exit: code, ...(code === 0 ? {} : { stderr }) });
      });
      // Started means spawned: a child that could not be spawned rejects, so the caller knows.
      return new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (error) => {
          cleanUp();
          options.log({ worker: jobId, attempt, error: error.name });
          reject(error);
        });
      });
    },
  };
}
