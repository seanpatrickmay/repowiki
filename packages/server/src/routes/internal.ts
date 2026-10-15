import {
  failJob,
  heartbeatJob,
  type Job,
  JobStep,
  leaseJob,
  PLANS,
  type Result,
} from "@repowiki/hosted";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { HttpError, readJson } from "../http/body.ts";
import type { Reply, Route, RouteRequest } from "../http/router.ts";
import { json } from "../http/server.ts";
import { jobSpec, markLeased, revokeTokens, saveJob, settleOpen } from "../store/jobs.ts";
import { type Held, heldJob, tokenFrom } from "./job-token.ts";

export const LEASE_MS = 120_000;
const noContent: Reply = { status: 204 };

/** The lease reply: everything a worker needs to run one attempt (spec 2 §6). */
export interface WorkerSpec {
  jobId: string;
  attempt: number;
  kind: Job["kind"];
  commitSha: string;
  /** `name` is the bare clone's directory name, so the wiki is named after the repository. */
  repo: { fullName: string; name: string; cloneUrl: string; sizeKb: number };
  author: { login: string; githubUserId: number; commitShas: string[] };
  limits: { maxIndexedFiles: number };
  /** The LLM proxy's base URL; the worker's `ANTHROPIC_BASE_URL`. */
  llmUrl: string;
}

/** A Contract refusal ends the request with 409 and its code. */
function contract<T>(result: Result<T>): T {
  if (!result.ok) throw new HttpError(409, result.code);
  return result.value;
}

const Heartbeat = z.strictObject({ step: JobStep });
const Indexed = z.strictObject({ indexedFiles: z.int().nonnegative() });
const WorkerCode = z.enum(["job-failed", "job-cost-cap", "repo-too-large"]);
const Fail = z.strictObject({ code: WorkerCode });
type WorkerCode = z.infer<typeof WorkerCode>;

/** The worker's routes, authenticated by its job token (spec 2 §6). */
export function internalRoutes(deps: Deps): Route[] {
  const tokenOf = (request: RouteRequest) => tokenFrom(request.headers.authorization, "Bearer ");

  /**
   * Check the token, then read the body, then act in one transaction that locks the job and
   * checks the token again (A4: an unauthenticated request never makes the server read a body).
   */
  function route<T>(
    method: "POST" | "PUT",
    path: string,
    read: (request: RouteRequest) => Promise<T>,
    act: (tx: Queryable, held: Held, body: T) => Promise<Reply>,
  ): Route {
    return {
      method,
      pattern: `/internal/job/${path}`,
      handler: async (request) => {
        const token = tokenOf(request);
        await heldJob(deps.db, token, false);
        const body = await read(request);
        return deps.db.transaction(async (tx) => act(tx, await heldJob(tx, token, true), body));
      },
    };
  }

  const none = async () => undefined;

  /** The job ends: open reservations become spend, then every token dies. */
  const fail = async (tx: Queryable, job: Job, code: WorkerCode) => {
    const settled = await settleOpen(tx, job);
    await saveJob(tx, contract(failJob(settled, settled.attempt, code, deps.now())));
    await revokeTokens(tx, job.id);
  };

  const lease = route("POST", "lease", none, async (tx, { job, token }) => {
    let leased = job;
    if (job.status === "queued") {
      leased = contract(leaseJob(job, deps.now(), LEASE_MS));
      await saveJob(tx, leased);
      await markLeased(tx, token);
    }
    const spec = await jobSpec(tx, job.id);
    if (spec === null) throw new Error("job has no spec");
    const reply: WorkerSpec = {
      jobId: leased.id,
      attempt: leased.attempt,
      kind: leased.kind,
      commitSha: leased.commitSha,
      repo: {
        fullName: spec.repo.fullName,
        name: spec.repo.name,
        cloneUrl: spec.repo.cloneUrl,
        sizeKb: spec.repo.sizeKb,
      },
      author: spec.author,
      limits: { maxIndexedFiles: PLANS[spec.plan].maxIndexedFiles },
      llmUrl: `${deps.config.runner.internalUrl}/llm`,
    };
    return json(200, reply);
  });

  const heartbeat = route(
    "POST",
    "heartbeat",
    (r) => readJson(r.raw, Heartbeat),
    async (tx, { job }, { step }) => {
      await saveJob(tx, contract(heartbeatJob(job, job.attempt, step, deps.now(), LEASE_MS)));
      return noContent;
    },
  );

  const indexed = route(
    "POST",
    "indexed",
    (r) => readJson(r.raw, Indexed),
    async (tx, { job }, { indexedFiles }) => {
      if (job.status !== "running") throw new HttpError(409, "invalid-transition");
      const spec = await jobSpec(tx, job.id);
      if (spec === null) throw new Error("job has no spec");
      if (indexedFiles <= PLANS[spec.plan].maxIndexedFiles) return noContent;
      await fail(tx, job, "repo-too-large");
      return json(422, { code: "repo-too-large" });
    },
  );

  const failed = route(
    "POST",
    "fail",
    (r) => readJson(r.raw, Fail),
    async (tx, { job }, { code }) => {
      if (job.status !== "running") throw new HttpError(409, "invalid-transition");
      await fail(tx, job, code);
      return noContent;
    },
  );

  return [lease, heartbeat, indexed, failed];
}
