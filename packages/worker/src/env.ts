import { z } from "zod";

/**
 * The worker's environment (spec 2 S9, S16): the server's URL and the job's single-use token,
 * nothing else secret. `REPOWIKI_WORK_DIR` must be set to run the phases one at a time (the Fly
 * entrypoint); `all`, the default, runs both in a fresh temporary directory it removes after.
 */
export const WorkerEnv = z.object({
  REPOWIKI_API_URL: z.string().regex(/^https?:\/\/[^\s/]+(?:\/[^\s]*[^\s/])?$/),
  REPOWIKI_JOB_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  REPOWIKI_WORKER_MODE: z.enum(["engine", "fixture"]).default("engine"),
  REPOWIKI_WORK_DIR: z.string().min(1).optional(),
  REPOWIKI_ENGINE_VERSION: z
    .string()
    .regex(/^[A-Za-z0-9._+-]{1,64}$/)
    .default("dev"),
});
export type WorkerEnv = z.infer<typeof WorkerEnv>;

/**
 * Parses the worker's environment out of `env` and deletes the token and the server's URL from
 * it, parsed or not, so nothing the worker runs in-process or spawns inherits them; the engine
 * CLIs get the token only as engineEnv's ANTHROPIC_API_KEY.
 */
export function takeEnv(env: NodeJS.ProcessEnv): ReturnType<typeof WorkerEnv.safeParse> {
  const parsed = WorkerEnv.safeParse(env);
  delete env.REPOWIKI_JOB_TOKEN;
  delete env.REPOWIKI_API_URL;
  return parsed;
}
