import type { Facts, JobStep, Suggestions } from "@repowiki/hosted";
import { z } from "zod";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

/** The lease reply (spec 2 §6; the server's `WorkerSpec`). */
export const WorkerSpec = z.object({
  jobId: z.string().min(1),
  attempt: z.int().positive(),
  kind: z.enum(["generate", "refresh"]),
  commitSha: Sha,
  repo: z.object({
    fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    /** The bare clone's directory name, which names the wiki (amendment A2). */
    name: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .refine((name) => name !== "." && name !== "..", "not a directory name"),
    cloneUrl: z.string().regex(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\.git$/),
    sizeKb: z.number().nonnegative(),
  }),
  author: z.object({
    login: z.string().min(1),
    githubUserId: z.int().positive(),
    commitShas: z.array(Sha).max(100),
  }),
  limits: z.object({ maxIndexedFiles: z.int().positive() }),
  llmUrl: z.string().regex(/^https?:\/\/[^\s]+$/),
});
export type WorkerSpec = z.infer<typeof WorkerSpec>;

/** The codes a worker may fail its job with (the server's `/internal/job/fail`). */
export type FailCode = "job-failed" | "job-cost-cap" | "repo-too-large";

/** A refusal from the internal API; the message names the route and status, never the token. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface Succeeded {
  suggestions: Suggestions;
  facts: Facts;
  engineVersion: string;
  models: string[];
}

/** The server's internal API as the worker sees it (spec 2 §6). */
export interface WorkerApi {
  lease(): Promise<WorkerSpec>;
  heartbeat(step: JobStep): Promise<void>;
  /** "too-large" when the server failed the job for the plan's file limit. */
  indexed(indexedFiles: number): Promise<"ok" | "too-large">;
  putExport(bytes: Uint8Array): Promise<void>;
  succeed(body: Succeeded): Promise<void>;
  fail(code: FailCode): Promise<void>;
}

const CALL_TIMEOUT_MS = 120_000;

export function workerApi(
  baseUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): WorkerApi {
  async function call(
    method: string,
    path: string,
    body?: { json: unknown } | { bytes: Uint8Array },
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let payload: BodyInit | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = "json" in body ? JSON.stringify(body.json) : new Blob([new Uint8Array(body.bytes)]);
    }
    return fetchFn(`${baseUrl}/internal/job/${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  }
  async function expectOk(response: Response, what: string): Promise<void> {
    await response.body?.cancel();
    if (!response.ok) throw new ApiError(response.status, `${what}: HTTP ${response.status}`);
  }
  return {
    async lease() {
      const response = await call("POST", "lease");
      if (!response.ok) await expectOk(response, "lease");
      return WorkerSpec.parse(await response.json());
    },
    async heartbeat(step) {
      await expectOk(await call("POST", "heartbeat", { json: { step } }), "heartbeat");
    },
    async indexed(indexedFiles) {
      const response = await call("POST", "indexed", { json: { indexedFiles } });
      if (response.status === 422) {
        await response.body?.cancel();
        return "too-large";
      }
      await expectOk(response, "indexed");
      return "ok";
    },
    async putExport(bytes) {
      await expectOk(await call("PUT", "export", { bytes }), "export");
    },
    async succeed(body) {
      await expectOk(await call("POST", "succeed", { json: body }), "succeed");
    },
    async fail(code) {
      await expectOk(await call("POST", "fail", { json: { code } }), "fail");
    },
  };
}
