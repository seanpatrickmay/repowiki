import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerApi } from "./api.ts";
import { takeEnv } from "./env.ts";
import { runFixture } from "./fixture.ts";
import { type PhaseDeps, phase1, phase2 } from "./run.ts";

const PHASES = ["phase1", "phase2", "all"] as const;

/** One JSON line on stderr; never a token, an environment value or an error's message. */
const log = (line: object) => process.stderr.write(`${JSON.stringify(line)}\n`);

async function main(): Promise<boolean> {
  // The token and the server's URL leave process.env here: nothing spawned inherits them.
  const parsed = takeEnv(process.env);
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
