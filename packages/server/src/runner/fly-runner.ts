import type { JobRunner } from "./runner.ts";

export const FLY_API = "https://api.machines.dev/v1";

export interface FlyRunnerOptions {
  /** A Fly token that may create machines in `app`; sent only as the Machines API's bearer. */
  apiToken: string;
  /** The worker app, whose machines share the server's private network. */
  app: string;
  /** The worker image, e.g. `registry.fly.io/repowiki-workers:<label>`. */
  image: string;
  /** The server's worker listener as a worker reaches it, e.g. `http://repowiki.internal:8788`. */
  internalUrl: string;
  engineVersion: string;
  fetch?: typeof fetch;
  /** Where the created machine's id is logged, with the job; never a token. */
  log?: (line: object) => void;
}

/** A Fly machine id as the API returns one; anything else is never echoed into the logs. */
const MACHINE_ID = /^[0-9a-z]{1,32}$/;

/**
 * One auto-destroying Fly Machine per job attempt (spec 2 S16). Its environment is the job's
 * single-use token and the server's private address, nothing else. A refusal throws without
 * echoing either token; the caller leaves the job queued and the sweeper restarts it. A machine
 * is not destroyed when its job is cancelled: its worker exits on its next refused call (S16).
 */
export function flyRunner(options: FlyRunnerOptions): JobRunner {
  const fetchFn = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  return {
    async start({ jobId, attempt, token }) {
      const response = await fetchFn(
        `${FLY_API}/apps/${encodeURIComponent(options.app)}/machines`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            config: {
              image: options.image,
              env: {
                REPOWIKI_API_URL: options.internalUrl,
                REPOWIKI_JOB_TOKEN: token,
                REPOWIKI_WORKER_MODE: "engine",
                REPOWIKI_ENGINE_VERSION: options.engineVersion,
              },
              guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
              auto_destroy: true,
              restart: { policy: "no" },
              metadata: { repowiki_job: jobId, repowiki_attempt: String(attempt) },
            },
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Fly refused the worker machine: HTTP ${response.status}`);
      }
      // The id ties a machine in Fly's dashboard to its job; reading it is best effort.
      const created: unknown = await response.json().catch(() => null);
      const id =
        typeof created === "object" && created !== null ? Reflect.get(created, "id") : null;
      log({
        machine: typeof id === "string" && MACHINE_ID.test(id) ? id : null,
        job: jobId,
        attempt,
      });
    },
  };
}
