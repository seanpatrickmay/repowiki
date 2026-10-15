import { failJob, type Job, type Result, recordSpend } from "@repowiki/hosted";
import { priceFor } from "@repowiki/llm";
import type { z } from "zod";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { HttpError, readBody } from "../http/body.ts";
import type { Handler, Reply, Route, RouteRequest } from "../http/router.ts";
import { json } from "../http/server.ts";
import { AnthropicUsage, actualMicros, reserveMicros } from "../proxy/cost.ts";
import { MessageParams, refusedBeta } from "../proxy/request.ts";
import { jobById, openReservations, revokeTokens, saveJob } from "../store/jobs.ts";
import { heldJob, tokenFrom } from "./job-token.ts";

export const MESSAGE_LIMIT = 8 * 1024 * 1024;
export const PER_SECOND = 10;
const COUNT_CONCURRENCY = 4;

/** Errors in Anthropic's shape, so the worker's SDK reports them as the API's own. */
const KINDS: Readonly<Record<number, string>> = {
  400: "invalid_request_error",
  401: "authentication_error",
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
    const { job } = await heldJob(q, token, lock);
    if (job.status !== "running") throw new HttpError(401, "This job is not running.");
    return job;
  }

  /** A valid token, checked before any body is read (A4); only valid tokens are rate limited. */
  async function authenticate(request: RouteRequest): Promise<string> {
    const token = tokenFrom(request.headers["x-api-key"]);
    await runningJob(deps.db, token, false);
    if (token === null || limited(token)) throw new HttpError(429, "Too many requests.");
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
      const response = await upstream(
        request,
        "/v1/messages/count_tokens",
        "POST",
        JSON.stringify(countable),
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

  /** Reserve `usd` against the token's job, or null when spent plus open would pass the cap. */
  async function reserve(token: string, usd: number): Promise<string | null> {
    return deps.db.transaction(async (tx) => {
      const job = await runningJob(tx, token, true);
      const open = await openReservations(tx, job.id);
      if (job.spentUsdMicros + open + usd > job.capUsdMicros) return null;
      const id = deps.newId();
      await tx.query(
        "INSERT INTO reservations (id, job_id, attempt, usd_micros) VALUES ($1, $2, $3, $4)",
        [id, job.id, job.attempt, usd],
      );
      return id;
    });
  }

  /**
   * Settle a reservation once, charging `actual` in full (A2). Spend never passes the cap, which
   * the Job schema forbids: a charge that reaches it fails the job with job-cost-cap in the same
   * transaction. A job that already ended had its open reservations charged then, so it is skipped.
   */
  async function settle(reservationId: string, actual: number): Promise<void> {
    await deps.db.transaction(async (tx) => {
      const owner = await tx.query<{ job_id: string }>(
        "SELECT job_id FROM reservations WHERE id = $1",
        [reservationId],
      );
      if (owner[0] === undefined) return;
      // Job row first, then the reservation: the order every other job transaction locks in.
      const job = await jobById(tx, owner[0].job_id, true);
      const rows = await tx.query<{ settled: boolean }>(
        "SELECT settled FROM reservations WHERE id = $1 FOR UPDATE",
        [reservationId],
      );
      if (rows[0] === undefined || rows[0].settled) return;
      await tx.query("UPDATE reservations SET settled = true WHERE id = $1", [reservationId]);
      if (job === null || job.status !== "running") return;
      const charge = Math.min(actual, job.capUsdMicros - job.spentUsdMicros);
      let next = contract(recordSpend(job, job.attempt, charge));
      if (next.spentUsdMicros >= next.capUsdMicros) {
        next = contract(failJob(next, next.attempt, "job-cost-cap", deps.now()));
        await revokeTokens(tx, job.id);
      }
      await saveJob(tx, next);
    });
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
    passThrough,
    messageCost,
    capRefusal,
    runningJob,
  };
}

/** The worker's Anthropic endpoint: the job's cap made hard, the real key never in the sandbox. */
export function llmRoutes(deps: Deps): Route[] {
  const core = proxyCore(deps);
  return [
    {
      method: "POST",
      pattern: "/llm/v1/messages",
      handler: anthropicShaped(async (request) => {
        const token = await core.authenticate(request);
        const params = await core.readParams(request, MESSAGE_LIMIT, MessageParams);
        const reserved = await core.reservationFor(request, [params], false);
        const id = await core.reserve(token, reserved);
        if (id === null) return core.capRefusal();
        let response: Response;
        let text: string;
        try {
          response = await core.upstream(request, "/v1/messages", "POST", JSON.stringify(params));
          text = await response.text();
        } catch {
          // The request may have been billed: charge what was reserved, never less.
          await core.settle(id, reserved);
          throw new HttpError(502, "The model provider did not answer.");
        }
        await core.settle(id, core.messageCost(response.ok, text, params.model, reserved));
        return core.passThrough(response.status, text);
      }),
    },
  ];
}
