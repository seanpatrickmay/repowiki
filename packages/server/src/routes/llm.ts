import { failJob, type Job, type Result, recordSpend } from "@repowiki/hosted";
import { priceFor } from "@repowiki/llm";
import type { z } from "zod";
import { type Deps, logOf } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { HttpError, readBody } from "../http/body.ts";
import type { Handler, Reply, Route, RouteRequest } from "../http/router.ts";
import { json } from "../http/server.ts";
import { cancelBatches } from "../proxy/cancel.ts";
import { AnthropicUsage, actualMicros, reserveMicros } from "../proxy/cost.ts";
import { BatchCreate, MessageParams, refusedBeta } from "../proxy/request.ts";
import {
  jobById,
  openBatchIds,
  openReservations,
  revokeTokens,
  saveJob,
  settleOpen,
} from "../store/jobs.ts";
import { heldJob, tokenFrom } from "./job-token.ts";

export const MESSAGE_LIMIT = 8 * 1024 * 1024;
/** A batch carries many requests, so it gets its own, larger body limit (M14c A3). */
export const BATCH_LIMIT = 64 * 1024 * 1024;
export const PER_SECOND = 10;
const COUNT_CONCURRENCY = 4;
/** Batch creates one job may have open at once (S11). */
export const MAX_BATCHES_IN_FLIGHT = 2;

/** Failures where fetch never opened a connection, so nothing reached the provider (M1). */
const UNSENT_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
function neverSent(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && UNSENT_CODES.has(code);
}

/** At most `limit` calls of `run` at once; the others wait their turn. */
export function semaphore(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (run) => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active--;
      else next();
    }
  };
}

/** Token counts in flight across every job in this process (S11): one batch cannot starve others. */
const counting = semaphore(COUNT_CONCURRENCY);

/** Errors in Anthropic's shape, so the worker's SDK reports them as the API's own. */
const KINDS: Readonly<Record<number, string>> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  409: "invalid_request_error",
  413: "request_too_large",
  415: "invalid_request_error",
  429: "rate_limit_error",
};
export const anthropicError = (status: number, message: string, headers = {}) =>
  json(status, { type: "error", error: { type: KINDS[status] ?? "api_error", message } }, headers);
const capRefusal = () => anthropicError(429, "job-cost-cap");

/** A handler whose HttpErrors answer in Anthropic's error shape. */
export const anthropicShaped =
  (handler: Handler): Handler =>
  async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return anthropicError(error.status, error.message, error.headers);
    }
  };

function contract<T>(result: Result<T>): T {
  if (!result.ok) throw new HttpError(409, result.code);
  return result.value;
}

/** At most `perSecond` calls per key in any second; every call forgets keys idle for a second. */
export function rateLimiter(perSecond: number, now: () => number): (key: string) => boolean {
  const seen = new Map<string, number[]>();
  return (key) => {
    const at = now();
    for (const [k, times] of seen) {
      const recent = times.filter((t) => at - t < 1000);
      if (recent.length === 0) seen.delete(k);
      else seen.set(k, recent);
    }
    const mine = seen.get(key) ?? [];
    if (mine.length >= perSecond) return true;
    seen.set(key, [...mine, at]);
    return false;
  };
}

/** The proxy's moving parts, shared by the messages and batch routes (spec 2 S11). */
export function proxyCore(deps: Deps) {
  const limited = rateLimiter(PER_SECOND, () => Date.parse(deps.now()));

  /** The job a running worker's token speaks for, with the row locked when `tx` is a transaction. */
  async function runningJob(q: Queryable, token: string | null, lock: boolean): Promise<Job> {
    let job: Job;
    try {
      ({ job } = await heldJob(q, token, lock));
    } catch (error) {
      // The SDK retries a 409; a second worker must stop, so it gets a 403 here (M3).
      if (error instanceof HttpError && error.status === 409) {
        throw new HttpError(403, error.message);
      }
      throw error;
    }
    if (job.status !== "running") throw new HttpError(401, "This job is not running.");
    // A lease that ran out is over, even before the sweeper recovers the job (M4).
    if (job.leaseExpiresAt === null || Date.parse(job.leaseExpiresAt) <= Date.parse(deps.now())) {
      throw new HttpError(401, "This job's lease has expired.");
    }
    return job;
  }

  /** A valid token, checked before any body is read (A4); only valid tokens are rate limited. */
  async function authenticate(request: RouteRequest): Promise<string> {
    const token = tokenFrom(request.headers["x-api-key"]);
    await runningJob(deps.db, token, false);
    if (token === null || limited(token)) throw new HttpError(429, "Too many requests.");
    // Before any reservation: a request that cannot be forwarded must not be charged.
    if (deps.anthropic.key === null) throw new HttpError(503, "No model provider is configured.");
    const beta = refusedBeta(request.headers["anthropic-beta"]);
    if (beta !== null) throw new HttpError(400, `The ${beta} beta is not allowed.`);
    return token;
  }

  async function readParams<T>(request: RouteRequest, limit: number, schema: z.ZodType<T>) {
    const text = (await readBody(request.raw, limit)).toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Malformed JSON.");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(
        400,
        `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
      );
    }
    return parsed.data;
  }

  function upstream(request: RouteRequest, path: string, method: string, body?: string) {
    if (deps.anthropic.key === null) throw new HttpError(503, "No model provider is configured.");
    const version = request.headers["anthropic-version"];
    const beta = request.headers["anthropic-beta"];
    const headers: Record<string, string> = {
      "x-api-key": deps.anthropic.key,
      "anthropic-version": typeof version === "string" ? version : "2023-06-01",
      "content-type": "application/json",
      ...(typeof beta === "string" && beta.trim() !== "" ? { "anthropic-beta": beta } : {}),
    };
    return deps.anthropic.fetch(`${deps.anthropic.url}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(600_000),
    });
  }

  /** Input tokens by Anthropic's free count; the UTF-8 byte count, a true bound, if that fails. */
  async function inputTokens(request: RouteRequest, params: MessageParams): Promise<number> {
    const { max_tokens: _max, temperature: _t, metadata: _m, ...countable } = params;
    try {
      const response = await counting(() =>
        upstream(request, "/v1/messages/count_tokens", "POST", JSON.stringify(countable)),
      );
      const counted = (await response.json().catch(() => null)) as { input_tokens?: unknown };
      if (response.ok && Number.isSafeInteger(counted?.input_tokens)) {
        return Number(counted.input_tokens);
      }
    } catch {
      // Fall through to the bound.
    }
    return Buffer.byteLength(JSON.stringify(params));
  }

  /** What `requests` reserve together (A2); 400 for a model with no price, before any count. */
  async function reservationFor(
    request: RouteRequest,
    requests: readonly MessageParams[],
    batch: boolean,
  ): Promise<number> {
    const unknown = requests.find((p) => priceFor(p.model) === null);
    if (unknown !== undefined)
      throw new HttpError(400, `The model ${unknown.model} is not allowed.`);
    const counts: number[] = new Array(requests.length).fill(0);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < requests.length; i = next++) {
        const params = requests[i] as MessageParams;
        counts[i] = await inputTokens(request, params);
      }
    };
    await Promise.all(Array.from({ length: COUNT_CONCURRENCY }, worker));
    return requests.reduce(
      (sum, p, i) => sum + (reserveMicros(p.model, counts[i] ?? 0, p.max_tokens, batch) ?? 0),
      0,
    );
  }

  /**
   * Reserve `usd` against the token's job; null when spent plus open would pass the cap. A batch
   * create is refused with 429 while the job already has MAX_BATCHES_IN_FLIGHT open (S11).
   */
  async function reserve(token: string, usd: number, batch: boolean): Promise<string | null> {
    return deps.db.transaction(async (tx) => {
      const job = await runningJob(tx, token, true);
      if (batch) {
        const rows = await tx.query<{ n: string | number }>(
          "SELECT count(*) AS n FROM reservations WHERE job_id = $1 AND batch AND NOT settled",
          [job.id],
        );
        if (Number(rows[0]?.n ?? 0) >= MAX_BATCHES_IN_FLIGHT) {
          throw new HttpError(429, "Too many batches in flight for this job.");
        }
      }
      const open = await openReservations(tx, job.id);
      if (job.spentUsdMicros + open + usd > job.capUsdMicros) return null;
      const id = deps.newId();
      await tx.query(
        "INSERT INTO reservations (id, job_id, attempt, usd_micros, batch) VALUES ($1, $2, $3, $4, $5)",
        [id, job.id, job.attempt, usd, batch],
      );
      return id;
    });
  }

  /**
   * Settle a reservation once, recording `actual` uncapped (budgets count real spend) and charging
   * it to the job (A2). The job's spend never passes the cap, which the Job schema forbids: a
   * charge that reaches it fails the job with job-cost-cap in the same transaction, settling its
   * other open reservations. A job that already ended had its open reservations settled then.
   */
  async function settle(reservationId: string, actual: number): Promise<void> {
    const ended = await deps.db.transaction(async (tx): Promise<string[]> => {
      const owner = await tx.query<{ job_id: string }>(
        "SELECT job_id FROM reservations WHERE id = $1",
        [reservationId],
      );
      if (owner[0] === undefined) return [];
      // Job row first, then the reservation: the order every other job transaction locks in.
      const job = await jobById(tx, owner[0].job_id, true);
      const rows = await tx.query<{ settled: boolean; batch: boolean }>(
        "SELECT settled, batch FROM reservations WHERE id = $1 FOR UPDATE",
        [reservationId],
      );
      if (rows[0] === undefined) return [];
      const now = deps.now();
      if (rows[0].settled) {
        // The job ended first and was charged the reservation; its spend is final, but the
        // budgets count real spend (fresh review I3). A message's cost is known exactly, so it
        // replaces the reservation; a batch, which the job's end may have cancelled part-way,
        // never records less than it reserved.
        await tx.query(
          rows[0].batch
            ? `UPDATE reservations SET actual_usd_micros = $2, settled_at = $3
               WHERE id = $1 AND COALESCE(actual_usd_micros, 0) < $2`
            : "UPDATE reservations SET actual_usd_micros = $2, settled_at = $3 WHERE id = $1",
          [reservationId, actual, now],
        );
        return [];
      }
      await tx.query(
        "UPDATE reservations SET settled = true, actual_usd_micros = $2, settled_at = $3 WHERE id = $1",
        [reservationId, actual, now],
      );
      if (job === null || job.status !== "running") return [];
      const charge = Math.min(actual, job.capUsdMicros - job.spentUsdMicros);
      let next = contract(recordSpend(job, job.attempt, charge));
      let batches: string[] = [];
      if (next.spentUsdMicros >= next.capUsdMicros) {
        batches = await openBatchIds(tx, job.id);
        next = await settleOpen(tx, next, now);
        next = contract(failJob(next, next.attempt, "job-cost-cap", now));
        await revokeTokens(tx, job.id);
      }
      await saveJob(tx, next);
      return batches;
    });
    await cancelBatches(deps.anthropic, ended, logOf(deps));
  }

  /**
   * POST `body` upstream. A connection that never opened is charged 0 (M1); a failure after the
   * request may have reached the provider is charged the reservation, never less.
   */
  async function forward(
    request: RouteRequest,
    reservationId: string,
    reserved: number,
    path: string,
    body: unknown,
  ): Promise<{ response: Response; text: string }> {
    let response: Response;
    try {
      response = await upstream(request, path, "POST", JSON.stringify(body));
    } catch (error) {
      await settle(reservationId, neverSent(error) ? 0 : reserved);
      throw new HttpError(502, "The model provider did not answer.");
    }
    try {
      return { response, text: await response.text() };
    } catch {
      await settle(reservationId, reserved);
      throw new HttpError(502, "The model provider did not answer.");
    }
  }

  /** The upstream reply as the worker sees it. */
  const passThrough = (status: number, body: string): Reply => ({
    status,
    headers: { "content-type": "application/json" },
    body,
  });

  /** What a message reply cost: its usage, the reservation when that is unreadable, 0 on error. */
  function messageCost(ok: boolean, text: string, model: string, reserved: number): number {
    if (!ok) return 0;
    let reply: { model?: unknown; usage?: unknown } | null = null;
    try {
      reply = JSON.parse(text) as { model?: unknown; usage?: unknown };
    } catch {
      return reserved;
    }
    const usage = AnthropicUsage.safeParse(reply?.usage);
    if (!usage.success) return reserved;
    const priced = typeof reply?.model === "string" ? reply.model : model;
    return actualMicros(priced, usage.data, false) ?? reserved;
  }

  return {
    authenticate,
    readParams,
    upstream,
    reservationFor,
    reserve,
    settle,
    forward,
    passThrough,
    messageCost,
    capRefusal,
    runningJob,
  };
}

/** Anthropic's batch ids, safe to put in a path. */
const BATCH_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A batch-create reply's id, or null when the reply is not JSON or has no usable id. */
function batchIdOf(text: string): string | null {
  try {
    const id = (JSON.parse(text) as { id?: unknown } | null)?.id;
    return typeof id === "string" && BATCH_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** What a batch's results cost: the sum over succeeded lines, the reservation if one is unreadable. */
function resultsCost(text: string, reserved: number): number {
  let sum = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: { result?: { type?: unknown; message?: { model?: unknown; usage?: unknown } } };
    try {
      parsed = JSON.parse(line);
    } catch {
      return Math.max(sum, reserved);
    }
    if (parsed.result?.type !== "succeeded") continue;
    const { model, usage } = parsed.result.message ?? {};
    const read = AnthropicUsage.safeParse(usage);
    const cost =
      read.success && typeof model === "string" ? actualMicros(model, read.data, true) : null;
    if (cost === null) return Math.max(sum, reserved);
    sum += cost;
  }
  return sum;
}

/** The worker's Anthropic endpoint: the job's cap made hard, the real key never in the sandbox. */
export function llmRoutes(deps: Deps): Route[] {
  const core = proxyCore(deps);

  /** The job's reservation for `batchId`; 404 for a batch this job did not create. */
  async function ownBatch(token: string, batchId: string): Promise<{ id: string; usd: number }> {
    const job = await core.runningJob(deps.db, token, false);
    const rows = BATCH_ID.test(batchId)
      ? await deps.db.query<{ id: string; usd_micros: string | number }>(
          "SELECT id, usd_micros FROM reservations WHERE job_id = $1 AND batch_id = $2",
          [job.id, batchId],
        )
      : [];
    if (rows[0] === undefined) throw new HttpError(404, "No such batch for this job.");
    return { id: rows[0].id, usd: Number(rows[0].usd_micros) };
  }

  /** The SDK reads results from `results_url` as given: point it back through the proxy. */
  function rewrite(text: string): string {
    let batch: Record<string, unknown>;
    try {
      batch = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return text;
    }
    if (typeof batch?.id !== "string" || typeof batch.results_url !== "string") return text;
    const id = encodeURIComponent(batch.id);
    const resultsUrl = `${deps.config.runner.internalUrl}/llm/v1/messages/batches/${id}/results`;
    return JSON.stringify({ ...batch, results_url: resultsUrl });
  }

  /** Retrieve or cancel one of the job's batches. */
  const batchCall = (suffix: string, method: "GET" | "POST"): Handler =>
    anthropicShaped(async (request) => {
      const token = await core.authenticate(request);
      const batchId = request.params.id ?? "";
      await ownBatch(token, batchId);
      const path = `/v1/messages/batches/${encodeURIComponent(batchId)}${suffix}`;
      const response = await core.upstream(request, path, method);
      return core.passThrough(response.status, rewrite(await response.text()));
    });

  return [
    {
      method: "POST",
      pattern: "/llm/v1/messages",
      handler: anthropicShaped(async (request) => {
        const token = await core.authenticate(request);
        const params = await core.readParams(request, MESSAGE_LIMIT, MessageParams);
        const reserved = await core.reservationFor(request, [params], false);
        const id = await core.reserve(token, reserved, false);
        if (id === null) return core.capRefusal();
        const path = "/v1/messages";
        const { response, text } = await core.forward(request, id, reserved, path, params);
        await core.settle(id, core.messageCost(response.ok, text, params.model, reserved));
        return core.passThrough(response.status, text);
      }),
    },
    {
      method: "POST",
      pattern: "/llm/v1/messages/batches",
      handler: anthropicShaped(async (request) => {
        const token = await core.authenticate(request);
        const body = await core.readParams(request, BATCH_LIMIT, BatchCreate);
        const requests = body.requests.map((r) => r.params);
        const reserved = await core.reservationFor(request, requests, true);
        const id = await core.reserve(token, reserved, true);
        if (id === null) return core.capRefusal();
        const path = "/v1/messages/batches";
        const { response, text } = await core.forward(request, id, reserved, path, body);
        if (!response.ok) {
          await core.settle(id, 0);
          return core.passThrough(response.status, text);
        }
        const batchId = batchIdOf(text);
        if (batchId === null) {
          // The batch may exist upstream with no id we can read: charge the reservation (M2).
          await core.settle(id, reserved);
          throw new HttpError(502, "The model provider's reply could not be read.");
        }
        await deps.db.query("UPDATE reservations SET batch_id = $2 WHERE id = $1", [id, batchId]);
        return core.passThrough(response.status, rewrite(text));
      }),
    },
    { method: "GET", pattern: "/llm/v1/messages/batches/:id", handler: batchCall("", "GET") },
    {
      method: "POST",
      pattern: "/llm/v1/messages/batches/:id/cancel",
      handler: batchCall("/cancel", "POST"),
    },
    {
      method: "GET",
      pattern: "/llm/v1/messages/batches/:id/results",
      handler: anthropicShaped(async (request) => {
        const token = await core.authenticate(request);
        const batchId = request.params.id ?? "";
        const reservation = await ownBatch(token, batchId);
        const path = `/v1/messages/batches/${encodeURIComponent(batchId)}/results`;
        const response = await core.upstream(request, path, "GET");
        const text = await response.text();
        if (!response.ok) return core.passThrough(response.status, text);
        // Settled once: a second read of the same results charges nothing (settle is idempotent).
        await core.settle(reservation.id, resultsCost(text, reservation.usd));
        return { status: 200, headers: { "content-type": "application/x-jsonl" }, body: text };
      }),
    },
  ];
}
