import { createHash } from "node:crypto";
import { WikiExport } from "@repowiki/core";
import {
  Facts,
  failJob,
  firstRevision,
  type Generation,
  generatedContent,
  heartbeatJob,
  type Job,
  JobStep,
  leaseJob,
  PLANS,
  type Result,
  refreshRevision,
  Suggestions,
  succeedJob,
} from "@repowiki/hosted";
import { z } from "zod";
import { type Deps, logOf } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { HttpError, readBody, readJson } from "../http/body.ts";
import type { Reply, Route, RouteRequest } from "../http/router.ts";
import { json } from "../http/server.ts";
import { cancelBatches } from "../proxy/cancel.ts";
import { accountById } from "../store/accounts.ts";
import { latestRevision, saveGeneration, saveRevision } from "../store/drafts.ts";
import {
  jobSpec,
  markLeased,
  openBatchIds,
  revokeTokens,
  saveJob,
  saveJobSpec,
  settleOpen,
} from "../store/jobs.ts";
import { projectById, saveProject } from "../store/projects.ts";
import { type Held, heldJob, tokenFrom } from "./job-token.ts";

export const EXPORT_LIMIT = 32 * 1024 * 1024;
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
const Succeed = z.strictObject({
  suggestions: Suggestions,
  facts: Facts,
  engineVersion: z.string().min(1).max(64),
  models: z.array(z.string().min(1).max(128)).min(1).max(8),
});
const WorkerCode = z.enum(["job-failed", "job-cost-cap", "repo-too-large"]);
const Fail = z.strictObject({ code: WorkerCode });
type WorkerCode = z.infer<typeof WorkerCode>;

/** Where an attempt's export is stored until its generation exists (spec 2 §6). */
export const exportKey = (job: Job) => `exports/${job.id}-${job.attempt}.json`;

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
    act: (tx: Queryable, held: Held, body: T, ended: string[]) => Promise<Reply>,
  ): Route {
    return {
      method,
      pattern: `/internal/job/${path}`,
      handler: async (request) => {
        const token = tokenOf(request);
        await heldJob(deps.db, token, false);
        const body = await read(request);
        // The batches of a job this request ended, cancelled once the ending has committed.
        const ended: string[] = [];
        const reply = await deps.db.transaction(async (tx) =>
          act(tx, await heldJob(tx, token, true), body, ended),
        );
        await cancelBatches(deps.anthropic, ended, logOf(deps));
        return reply;
      },
    };
  }

  const none = async () => undefined;

  /** The job ends: open reservations become spend, then every token dies. */
  const fail = async (tx: Queryable, job: Job, code: WorkerCode, ended: string[]) => {
    ended.push(...(await openBatchIds(tx, job.id)));
    const now = deps.now();
    const settled = await settleOpen(tx, job, now);
    await saveJob(tx, contract(failJob(settled, settled.attempt, code, now)));
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
    async (tx, { job }, { indexedFiles }, ended) => {
      if (job.status !== "running") throw new HttpError(409, "invalid-transition");
      const spec = await jobSpec(tx, job.id);
      if (spec === null) throw new Error("job has no spec");
      if (indexedFiles <= PLANS[spec.plan].maxIndexedFiles) return noContent;
      await fail(tx, job, "repo-too-large", ended);
      return json(422, { code: "repo-too-large" });
    },
  );

  const upload = route(
    "PUT",
    "export",
    async (r) => {
      if (!String(r.headers["content-type"] ?? "").startsWith("application/json")) {
        throw new HttpError(415, "Expected application/json.");
      }
      const bytes = await readBody(r.raw, EXPORT_LIMIT);
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new HttpError(400, "Malformed JSON.");
      }
      if (!WikiExport.safeParse(value).success) {
        throw new HttpError(400, "The export is not a valid RepoWiki export.");
      }
      return bytes;
    },
    async (tx, { job }, bytes) => {
      if (job.status !== "running") throw new HttpError(409, "invalid-transition");
      const spec = await jobSpec(tx, job.id);
      if (spec === null) throw new Error("job has no spec");
      const key = exportKey(job);
      await deps.objects.put(key, bytes, "application/json");
      const hash = createHash("sha256").update(bytes).digest("hex");
      await saveJobSpec(tx, job.id, { ...spec, export: { key, hash } });
      return noContent;
    },
  );

  const succeed = route(
    "POST",
    "succeed",
    (r) => readJson(r.raw, Succeed),
    async (tx, { job }, body) => {
      const spec = await jobSpec(tx, job.id);
      // The export must be this attempt's own.
      if (spec?.export?.key !== exportKey(job)) {
        throw new HttpError(409, "Upload the export before succeeding.");
      }
      const project = await projectById(tx, job.projectId, true);
      if (project === null) throw new Error("job has no project");
      const now = deps.now();
      const settled = await settleOpen(tx, job, now);
      const done = contract(succeedJob(settled, settled.attempt, now));
      const generation: Generation = {
        id: deps.newId(),
        jobId: job.id,
        projectId: project.id,
        commitSha: job.commitSha,
        exportKey: spec.export.key,
        exportHash: spec.export.hash,
        suggestions: body.suggestions,
        facts: body.facts,
        engineVersion: body.engineVersion,
        models: body.models,
        spentUsdMicros: done.spentUsdMicros,
        createdAt: now,
      };
      // The revision's content is generated here, once (ADR-0012): the export was validated
      // when it was uploaded, and the author's name is the account's.
      const stored = await deps.objects.get(spec.export.key);
      const account = await accountById(tx, project.accountId);
      if (stored === null || account === null)
        throw new Error("succeed lost its export or account");
      const content = generatedContent({
        suggestions: body.suggestions,
        facts: body.facts,
        exp: WikiExport.parse(JSON.parse(new TextDecoder().decode(stored.body))),
        authorName: account.displayName || account.login,
      });
      const latest = project.latestRevision === 0 ? null : await latestRevision(tx, project.id);
      const revised =
        latest === null
          ? contract(firstRevision(project, generation, content, now))
          : contract(refreshRevision(project, latest, generation, content, now));
      await saveGeneration(tx, generation);
      await saveRevision(tx, revised.revision);
      await saveProject(tx, revised.project);
      await saveJob(tx, done);
      await revokeTokens(tx, job.id);
      return noContent;
    },
  );

  const failed = route(
    "POST",
    "fail",
    (r) => readJson(r.raw, Fail),
    async (tx, { job }, { code }, ended) => {
      if (job.status !== "running") throw new HttpError(409, "invalid-transition");
      await fail(tx, job, code, ended);
      return noContent;
    },
  );

  return [lease, heartbeat, indexed, upload, succeed, failed];
}
