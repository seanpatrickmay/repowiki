import { type AnthropicUsage, actualMicros } from "./cost.ts";

export interface FakeAnthropicOptions {
  /** What `count_tokens` answers for every request. */
  inputTokens?: number;
  /** The usage every message and batch result reports. */
  usage?: AnthropicUsage;
  /** A raw body to answer `/v1/messages` with instead (e.g. one with no usage). */
  messageBody?: string;
  /** `count_tokens` answers 500, so the proxy falls back to the byte count. */
  countFails?: boolean;
  /** `count_tokens` waits this long before answering. */
  countDelayMs?: number;
  /** `/v1/messages` and batch creates throw this instead of answering (a network failure). */
  throws?: Error;
  /** A raw 2xx body to answer a batch create with instead. */
  batchBody?: string;
  /** Each result line's type in turn (default all `succeeded`). */
  resultTypes?: readonly ("succeeded" | "errored" | "canceled" | "expired")[];
}

export interface FakeAnthropic {
  fetch: typeof fetch;
  calls: { url: string; method: string; headers: Headers; body: string }[];
  /** The most `count_tokens` calls that were ever in flight at once. */
  maxCountsInFlight: () => number;
  /** What one message costs at the configured usage, in micro-dollars. */
  costOfMessage: number;
  /** What one succeeded batch result costs. */
  costOfBatchResult: number;
}

const MODEL = "claude-haiku-4-5";
const ORIGIN = "https://api.anthropic.test";

/** Test and demo upstream: count_tokens, messages and batches with fixed usage (spec 2 S18). */
export function fakeAnthropicFetch(options: FakeAnthropicOptions = {}): FakeAnthropic {
  const usage = options.usage ?? { input_tokens: 100, output_tokens: 50 };
  const calls: FakeAnthropic["calls"] = [];
  const batches = new Map<string, string[]>();
  let n = 0;
  let counting = 0;
  let maxCounting = 0;
  const batchReply = (id: string) =>
    Response.json({
      id,
      type: "message_batch",
      processing_status: "ended",
      results_url: `${ORIGIN}/v1/messages/batches/${id}/results`,
    });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url: url.href, method, headers: new Headers(init?.headers), body });
    if (url.pathname === "/v1/messages/count_tokens" && method === "POST") {
      counting++;
      maxCounting = Math.max(maxCounting, counting);
      if (options.countDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.countDelayMs));
      }
      counting--;
      if (options.countFails) return Response.json({ type: "error" }, { status: 500 });
      return Response.json({ input_tokens: options.inputTokens ?? 100 });
    }
    const creates =
      method === "POST" && ["/v1/messages", "/v1/messages/batches"].includes(url.pathname);
    if (creates && options.throws !== undefined) throw options.throws;
    if (url.pathname === "/v1/messages" && method === "POST") {
      if (options.messageBody !== undefined) return new Response(options.messageBody);
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [{ type: "text", text: "{}" }],
        stop_reason: "end_turn",
        usage,
      });
    }
    if (url.pathname === "/v1/messages/batches" && method === "POST") {
      if (options.batchBody !== undefined) return new Response(options.batchBody);
      const id = `msgbatch_${++n}`;
      const parsed = JSON.parse(body) as { requests: { custom_id: string }[] };
      batches.set(
        id,
        parsed.requests.map((r) => r.custom_id),
      );
      return batchReply(id);
    }
    const match = /^\/v1\/messages\/batches\/([^/]+)(\/results|\/cancel)?$/.exec(url.pathname);
    const ids = match ? batches.get(match[1] ?? "") : undefined;
    if (match?.[1] !== undefined && ids !== undefined) {
      if (match[2] !== "/results") return batchReply(match[1]);
      const lines = ids.map((custom_id, i) => {
        const type = options.resultTypes?.[i] ?? "succeeded";
        const result =
          type === "succeeded"
            ? { type, message: { model: MODEL, usage, content: [] } }
            : type === "errored"
              ? { type, error: { type: "error", error: { type: "api_error", message: "x" } } }
              : { type };
        return JSON.stringify({ custom_id, result });
      });
      return new Response(`${lines.join("\n")}\n`, {
        headers: { "content-type": "application/binary" },
      });
    }
    const error = { type: "error", error: { type: "not_found_error", message: "Not found" } };
    return Response.json(error, { status: 404 });
  };
  return {
    fetch: fetchFn,
    calls,
    maxCountsInFlight: () => maxCounting,
    costOfMessage: actualMicros(MODEL, usage, false) ?? 0,
    costOfBatchResult: actualMicros(MODEL, usage, true) ?? 0,
  };
}
