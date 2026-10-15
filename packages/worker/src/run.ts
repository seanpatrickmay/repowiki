import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JobStep } from "@repowiki/hosted";
import { ApiError, type FailCode, type WorkerApi, type WorkerSpec } from "./api.ts";
import { type CloneResult, cloneBare } from "./clone.ts";

/** A quarter of the server's 120-second lease. */
export const HEARTBEAT_MS = 30_000;

export interface PhaseDeps {
  api: WorkerApi;
  token: string;
  /** Holds `repo/<name>`, `out/`, `home/` and `people.json`; nothing is written in the clone. */
  workDir: string;
  engineVersion: string;
  log: (line: object) => void;
  heartbeatMs?: number;
  clone?: (input: Parameters<typeof cloneBare>[0]) => Promise<CloneResult>;
}

/** Sends the current step at once on every change, and again every `everyMs` while it lasts. */
export function heartbeater(api: WorkerApi, everyMs: number, log: (line: object) => void) {
  let current: JobStep | null = null;
  const timer = setInterval(() => {
    if (current === null) return;
    api.heartbeat(current).catch((error: unknown) => log({ heartbeat: "failed", ...why(error) }));
  }, everyMs);
  timer.unref();
  return {
    async step(step: JobStep) {
      current = step;
      await api.heartbeat(step);
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/** What a log line may say about an error: its class and an API status, never its message. */
const why = (error: unknown) => ({
  error: error instanceof Error ? error.name : "unknown",
  ...(error instanceof ApiError ? { status: error.status } : {}),
});

const paths = (workDir: string, spec: WorkerSpec) => ({
  repo: join(workDir, "repo", spec.repo.name),
  out: join(workDir, "out"),
  home: join(workDir, "home"),
  people: join(workDir, "people.json"),
});

async function reportFailure(deps: PhaseDeps, code: FailCode): Promise<false> {
  await deps.api
    .fail(code)
    .catch((error: unknown) => deps.log({ fail: "unreported", ...why(error) }));
  return false;
}

/** Phase 1, with the network open (spec 2 S9): lease, then clone under heartbeats (A1). */
export async function phase1(deps: PhaseDeps): Promise<boolean> {
  const spec = await deps.api.lease();
  const where = paths(deps.workDir, spec);
  const beat = heartbeater(deps.api, deps.heartbeatMs ?? HEARTBEAT_MS, deps.log);
  try {
    await beat.step("fetch");
    mkdirSync(where.home, { recursive: true });
    const cloned = await (deps.clone ?? cloneBare)({
      url: spec.repo.cloneUrl,
      sha: spec.commitSha,
      dir: where.repo,
      sizeKb: spec.repo.sizeKb,
      home: where.home,
    });
    if (!cloned.ok) {
      deps.log({ phase: 1, failed: cloned.code, detail: cloned.detail });
      return reportFailure(deps, cloned.code);
    }
    await deps.api.heartbeat("fetch");
    return true;
  } catch (error) {
    deps.log({ phase: 1, failed: "job-failed", ...why(error) });
    return reportFailure(deps, "job-failed");
  } finally {
    beat.stop();
  }
}
