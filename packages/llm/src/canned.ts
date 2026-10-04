import type { FetchLike } from "./cassette.ts";

/** A Messages API response body with one text block. Test-only. */
export function cannedMessageBody(text: string, stopReason = "end_turn") {
  return {
    id: "msg_canned",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Answers every Messages API call with one canned message and keeps each request body. */
export function cannedMessagesApi(text: string, stopReason = "end_turn") {
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json(cannedMessageBody(text, stopReason));
  };
  return { bodies, fetch };
}

/**
 * The Batches API as canned routes: the create call answers "in_progress", every later status
 * call "ended", and the results URL serves `results` as JSONL. POST bodies are kept. Test-only.
 */
export function cannedBatchApi(results: unknown[]) {
  const posts: Record<string, unknown>[] = [];
  const batch = (status: "in_progress" | "ended") => ({
    id: "msgbatch_canned",
    type: "message_batch",
    processing_status: status,
    request_counts: {
      processing: status === "ended" ? 0 : 2,
      succeeded: 0,
      errored: 0,
      canceled: 0,
      expired: 0,
    },
    results_url:
      status === "ended"
        ? "https://api.anthropic.com/v1/messages/batches/msgbatch_canned/results"
        : null,
    created_at: "2026-10-01T12:00:00Z",
    ended_at: null,
    expires_at: "2026-10-02T12:00:00Z",
    archived_at: null,
    cancel_initiated_at: null,
  });
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path.endsWith("/results")) {
      return new Response(results.map((line) => JSON.stringify(line)).join("\n"), {
        status: 200,
        headers: { "content-type": "application/x-jsonl" },
      });
    }
    if (init?.method !== "POST") return json(batch("ended"));
    posts.push(JSON.parse(String(init.body)));
    return json(batch("in_progress"));
  };
  return { fetch, posts };
}

/** One line of a batch results file for a request that succeeded. */
export const succeededLine = (customId: string, text: string) => ({
  custom_id: customId,
  result: { type: "succeeded", message: cannedMessageBody(text) },
});
