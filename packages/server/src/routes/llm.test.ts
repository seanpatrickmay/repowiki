import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import {
  type FakeAnthropic,
  type FakeAnthropicOptions,
  fakeAnthropicFetch,
} from "../proxy/fake-anthropic.ts";
import { jobById, tokenJob } from "../store/jobs.ts";
import { internalRoutes } from "./internal.ts";
import { llmRoutes } from "./llm.ts";
import { call, startedJob, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let job: { jobId: string; token: string; projectId: string };
let upstream: FakeAnthropic;

const message = (maxTokens = 1000, model = "claude-haiku-4-5", extra: object = {}) => ({
  model,
  max_tokens: maxTokens,
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});
const send = (
  path: string,
  body: unknown,
  token = job.token,
  method: "GET" | "POST" = "POST",
  headers: Record<string, string> = {},
) =>
  call(app, {
    method,
    path,
    headers: {
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const spent = async () => (await jobById(deps.db, job.jobId))?.spentUsdMicros;
const messageCalls = () => upstream.calls.filter((c) => c.url.endsWith("/v1/messages"));

async function setUp(options: FakeAnthropicOptions = {}) {
  upstream = fakeAnthropicFetch(options);
  deps = await testDeps({
    anthropic: { url: "https://api.anthropic.test", key: "sk-real", fetch: upstream.fetch },
  });
  app = createApp(deps, [...internalRoutes(deps), ...llmRoutes(deps)]);
  job = await startedJob(deps);
  await call(app, {
    method: "POST",
    path: "/internal/job/lease",
    headers: { authorization: `Bearer ${job.token}` },
  });
}

async function setCap(usdMicros: number) {
  await deps.db.query(
    `UPDATE jobs SET body = body || jsonb_build_object('capUsdMicros', $2::int, 'estimateUsdMicros', $2::int)
     WHERE id = $1`,
    [job.jobId, usdMicros],
  );
}

beforeEach(async () => setUp());
afterEach(async () => deps.db.close());

describe("the LLM proxy's messages route (spec 2 S11)", () => {
  it("forwards a message with the real key and charges its actual cost", async () => {
    const reply = await send("/llm/v1/messages", message());
    expect(reply.status).toBe(200);
    expect(JSON.parse(String(reply.body))).toMatchObject({ type: "message" });
    const forwarded = messageCalls()[0];
    expect(forwarded?.headers.get("x-api-key")).toBe("sk-real");
    expect(forwarded?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(upstream.calls.some((c) => c.headers.get("x-api-key") === job.token)).toBe(false);
    expect(await spent()).toBe(upstream.costOfMessage);
    expect(await deps.db.query("SELECT * FROM reservations WHERE NOT settled")).toEqual([]);
  });

  it("counts the input with count_tokens, sending the body without max_tokens (A2)", async () => {
    await send("/llm/v1/messages", message());
    const count = upstream.calls.find((c) => c.url.endsWith("/v1/messages/count_tokens"));
    expect(count?.headers.get("x-api-key")).toBe("sk-real");
    expect(JSON.parse(count?.body ?? "{}")).toEqual({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("refuses a forged or old token, an unknown model and absurd max_tokens, calling nothing", async () => {
    expect((await send("/llm/v1/messages", message(), "forged")).status).toBe(401);
    expect((await send("/llm/v1/messages", message(1000, "gpt-4"))).status).toBe(400);
    expect((await send("/llm/v1/messages", message(1_000_000))).status).toBe(400);
    await deps.db.query(
      "UPDATE jobs SET body = jsonb_set(body, '{attempt}', to_jsonb(2)) WHERE id = $1",
      [job.jobId],
    );
    expect((await send("/llm/v1/messages", message())).status).toBe(401);
    expect(upstream.calls).toEqual([]);
  });

  it("checks the token before reading a body (A4)", async () => {
    const reply = await call(app, {
      method: "POST",
      path: "/llm/v1/messages",
      headers: { "content-type": "application/json", "content-length": String(1 << 30) },
      body: "{}",
    });
    expect(reply.status).toBe(401);
  });

  it("refuses what the cap does not price: stream, tools, images, a 1-hour cache, betas (A1)", async () => {
    const image = { type: "image", source: { type: "url", url: "https://x.test/a.png" } };
    const ttl = { type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } };
    const refused = [
      message(1000, "claude-haiku-4-5", { stream: true }),
      message(1000, "claude-haiku-4-5", {
        tools: [{ name: "t", input_schema: { type: "object" } }],
      }),
      message(1000, "claude-haiku-4-5", { messages: [{ role: "user", content: [image] }] }),
      message(1000, "claude-haiku-4-5", { system: [ttl] }),
      message(1000, "claude-haiku-4-5", { service_tier: "auto" }),
    ];
    for (const body of refused) expect((await send("/llm/v1/messages", body)).status).toBe(400);
    const beta = { "anthropic-beta": "web-fetch-2025-09-10" };
    expect((await send("/llm/v1/messages", message(), job.token, "POST", beta)).status).toBe(400);
    expect(upstream.calls).toEqual([]);
  });

  it("refuses a request whose reservation would pass the cap, before forwarding it", async () => {
    await setCap(5000);
    const reply = await send("/llm/v1/messages", message(8000));
    expect(reply.status).toBe(429);
    expect(JSON.parse(String(reply.body))).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "job-cost-cap" },
    });
    expect(messageCalls()).toEqual([]);
  });

  it("reserves by the counted tokens, falling back to bytes when counting fails (A2)", async () => {
    const long = message(1000, "claude-haiku-4-5", {
      messages: [{ role: "user", content: "x".repeat(20_000) }],
    });
    await setCap(13_000);
    // Counted: 100 tokens × 1.25 + 1000 × 0.25 × 5 = 1375 micros, under the cap.
    expect((await send("/llm/v1/messages", long)).status).toBe(200);
    await deps.db.close();
    await setUp({ countFails: true });
    await setCap(13_000);
    // Bytes: over 20,000 × 1.25 micros, past the cap.
    expect((await send("/llm/v1/messages", long)).status).toBe(429);
    await deps.db.close();
    await setUp({ inputTokens: 10_000 });
    await setCap(13_000);
    // Counted: 10,000 × 1.25 + 1250 = 13,750, past the cap.
    expect((await send("/llm/v1/messages", message())).status).toBe(429);
  });

  it("charges usage above the reservation in full (A2)", async () => {
    await deps.db.close();
    await setUp({ usage: { input_tokens: 1000, output_tokens: 2000 } });
    expect((await send("/llm/v1/messages", message())).status).toBe(200);
    expect(await spent()).toBe(11_000);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ status: "running" });
  });

  it("fails the job with job-cost-cap when real spend reaches the cap (A2)", async () => {
    await deps.db.close();
    await setUp({ usage: { input_tokens: 1000, output_tokens: 2000 } });
    await setCap(5000);
    expect((await send("/llm/v1/messages", message())).status).toBe(200);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({
      status: "failed",
      refusal: "job-cost-cap",
      spentUsdMicros: 5000,
    });
    expect(await tokenJob(deps.db, job.token)).toBeNull();
  });

  it("charges an unparseable success the reservation (A2)", async () => {
    await deps.db.close();
    await setUp({ messageBody: "not json" });
    expect((await send("/llm/v1/messages", message())).status).toBe(200);
    expect(await spent()).toBe(1375);
  });

  it("limits each job token to 10 requests a second", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await send("/llm/v1/messages", message())).status).toBe(200);
    }
    const reply = await send("/llm/v1/messages", message());
    expect(reply.status).toBe(429);
    expect(String(reply.body)).not.toContain("job-cost-cap");
  });
});

describe("the LLM proxy's batch routes (spec 2 S11)", () => {
  const batch = (n = 2, maxTokens = 2000) => ({
    requests: Array.from({ length: n }, (_, i) => ({
      custom_id: `r${i}`,
      params: message(maxTokens),
    })),
  });
  const open = async () =>
    (
      await deps.db.query<{ usd_micros: string; batch_id: string }>(
        "SELECT usd_micros, batch_id FROM reservations WHERE NOT settled",
      )
    ).map((r) => ({ usd: Number(r.usd_micros), batchId: r.batch_id }));
  const get = (path: string, token = job.token) => send(path, undefined, token, "GET");

  it("reserves a batch at half price, rewrites its results_url, and settles once", async () => {
    const created = await send("/llm/v1/messages/batches", batch());
    expect(created.status).toBe(200);
    const made = JSON.parse(String(created.body));
    const results = `${deps.config.runner.internalUrl}/llm/v1/messages/batches/${made.id}/results`;
    expect(made.results_url).toBe(results);
    // Per request: (100 × 1.25 + 2000 × 0.25 × 5) / 2 = 1312.5, rounded up.
    expect(await open()).toEqual([{ usd: 2626, batchId: made.id }]);
    expect(
      JSON.parse(String((await get(`/llm/v1/messages/batches/${made.id}`)).body)),
    ).toMatchObject({
      results_url: results,
    });
    const read = await get(`/llm/v1/messages/batches/${made.id}/results`);
    expect(read.status).toBe(200);
    expect(String(read.body).trim().split("\n")).toHaveLength(2);
    expect(await spent()).toBe(2 * upstream.costOfBatchResult);
    // The same results read again are not charged again (Review Focus 2).
    expect((await get(`/llm/v1/messages/batches/${made.id}/results`)).status).toBe(200);
    expect(await spent()).toBe(2 * upstream.costOfBatchResult);
    expect(await open()).toEqual([]);
  });

  it("refuses another job's batch id without calling upstream", async () => {
    expect((await get("/llm/v1/messages/batches/msgbatch_other")).status).toBe(404);
    expect((await get("/llm/v1/messages/batches/msgbatch_other/results")).status).toBe(404);
    const cancel = await send("/llm/v1/messages/batches/msgbatch_other/cancel", undefined);
    expect(cancel.status).toBe(404);
    expect(upstream.calls).toEqual([]);
  });

  it("refuses a batch whose reservation would pass the cap", async () => {
    await setCap(2000);
    expect((await send("/llm/v1/messages/batches", batch())).status).toBe(429);
    expect(upstream.calls.filter((c) => c.url.endsWith("/batches"))).toEqual([]);
  });

  it("refuses a batch holding one request the engine would not send (A1)", async () => {
    const bad = batch();
    bad.requests.push({ custom_id: "x", params: message(1000, "claude-haiku-4-5", { tools: [] }) });
    expect((await send("/llm/v1/messages/batches", bad)).status).toBe(400);
    expect(upstream.calls).toEqual([]);
  });

  it("reads a batch body past the messages limit, up to its own (A3)", async () => {
    const big = { "content-length": String(9 * 1024 * 1024) };
    const declared = (path: string, body: unknown) =>
      call(app, {
        method: "POST",
        path,
        headers: { "x-api-key": job.token, "content-type": "application/json", ...big },
        body: JSON.stringify(body),
      });
    expect((await declared("/llm/v1/messages", message())).status).toBe(413);
    expect((await declared("/llm/v1/messages/batches", batch())).status).toBe(200);
  });

  it("refuses a recovered worker's old token on its batch (Review Focus 1)", async () => {
    const made = JSON.parse(String((await send("/llm/v1/messages/batches", batch())).body));
    await deps.db.query(
      "UPDATE jobs SET body = jsonb_set(body, '{attempt}', to_jsonb(2)) WHERE id = $1",
      [job.jobId],
    );
    expect((await get(`/llm/v1/messages/batches/${made.id}/results`)).status).toBe(401);
  });

  it("charges a batch still unread when the job ends (Review Focus 3)", async () => {
    await send("/llm/v1/messages/batches", batch());
    const fail = await call(app, {
      method: "POST",
      path: "/internal/job/fail",
      headers: { authorization: `Bearer ${job.token}`, "content-type": "application/json" },
      body: JSON.stringify({ code: "job-failed" }),
    });
    expect(fail.status).toBe(204);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ spentUsdMicros: 2626 });
  });
});
