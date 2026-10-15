import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { workerApi } from "./api.ts";
import { runFixture } from "./fixture.ts";
import { type PhaseDeps, phase1, phase2 } from "./run.ts";

/**
 * The worker's environment (spec 2 S9, S16): the server's URL and the job's single-use token,
 * nothing else secret. `REPOWIKI_WORK_DIR` must be set to run the phases one at a time (the Fly
 * entrypoint); `all`, the default, runs both in a fresh temporary directory it removes after.
 */
const Env = z.object({
  REPOWIKI_API_URL: z.string().regex(/^https?:\/\/[^\s/]+(?:\/[^\s]*[^\s/])?$/),
  REPOWIKI_JOB_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  REPOWIKI_WORKER_MODE: z.enum(["engine", "fixture"]).default("engine"),
  REPOWIKI_WORK_DIR: z.string().min(1).optional(),
  REPOWIKI_ENGINE_VERSION: z
    .string()
    .regex(/^[A-Za-z0-9._+-]{1,64}$/)
    .default("dev"),
});
const PHASES = ["phase1", "phase2", "all"] as const;

/** One JSON line on stderr; never a token, an environment value or an error's message. */
const log = (line: object) => process.stderr.write(`${JSON.stringify(line)}\n`);

async function main(): Promise<boolean> {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    log({ worker: "bad environment", fields: parsed.error.issues.map((i) => i.path.join(".")) });
    return false;
  }
  const env = parsed.data;
  const phase = process.argv[2] ?? "all";
  if (!(PHASES as readonly string[]).includes(phase)) {
    log({ worker: "unknown phase", phase: phase.slice(0, 20) });
    return false;
  }
  if (
    phase !== "all" &&
    (env.REPOWIKI_WORK_DIR === undefined || env.REPOWIKI_WORKER_MODE !== "engine")
  ) {
    log({ worker: `${phase} needs REPOWIKI_WORK_DIR and engine mode` });
    return false;
  }
  const api = workerApi(env.REPOWIKI_API_URL, env.REPOWIKI_JOB_TOKEN);
  if (env.REPOWIKI_WORKER_MODE === "fixture") return runFixture(api);
  const temporary = env.REPOWIKI_WORK_DIR === undefined;
  const workDir = env.REPOWIKI_WORK_DIR ?? mkdtempSync(join(tmpdir(), "repowiki-job-"));
  const deps: PhaseDeps = {
    api,
    token: env.REPOWIKI_JOB_TOKEN,
    workDir,
    engineVersion: env.REPOWIKI_ENGINE_VERSION,
    log,
  };
  try {
    if (phase === "phase1") return await phase1(deps);
    if (phase === "phase2") return await phase2(deps);
    return (await phase1(deps)) && (await phase2(deps));
  } finally {
    if (temporary) rmSync(workDir, { recursive: true, force: true });
  }
}

/** Exits once stderr has drained, even if a stray socket would keep the process alive. */
const exit = (code: number) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5_000).unref();
};

main().then(
  (ok) => exit(ok ? 0 : 1),
  (error: unknown) => {
    log({ worker: "crashed", error: error instanceof Error ? error.name : "unknown" });
    exit(1);
  },
);
