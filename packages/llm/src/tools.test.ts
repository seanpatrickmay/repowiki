import { describe, expect, it } from "vitest";
import { cannedMessageBody } from "./canned.ts";
import type { FetchLike } from "./cassette.ts";
import { createLedger } from "./ledger.ts";
import { DEFAULT_MODELS, LlmError } from "./provider.ts";
import { createClaudeToolProvider, type ToolDefinition, type TurnRequest } from "./tools.ts";

/** Answers every Messages API call with `content` and keeps each request body. */
function cannedTurns(content: unknown[], stopReason = "tool_use") {
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const body = { ...cannedMessageBody("", stopReason), content };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { bodies, fetch };
}

function setup(fetch: FetchLike) {
  const ledger = createLedger();
  const provider = createClaudeToolProvider({
    models: { ...DEFAULT_MODELS, evalAgent: "claude-haiku-4-5" },
    ledger,
    runId: "eval-run",
    apiKey: "canned",
    fetch,
    now: () => new Date("2026-10-04T12:00:00Z"),
  });
  return { ledger, provider };
}

const search: ToolDefinition = {
  name: "search",
  description: "Finds pages.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const request: TurnRequest = {
  purpose: "evalAgent",
  system: "Answer the question.",
  tools: [search],
  messages: [
    { role: "user", content: [{ type: "text", text: "Where are signals made?" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "tool_use", id: "tu_1", name: "search", input: { query: "signals" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "tu_1", content: "signals: …", isError: false }],
    },
  ],
  maxTokens: 1024,
  toolChoice: "auto",
  cache: true,
  temperature: 0,
};

describe("createClaudeToolProvider", () => {
  it("sends every text well formed: a lone surrogate becomes U+FFFD", async () => {
    const { bodies, fetch } = cannedTurns([{ type: "text", text: "ok" }], "end_turn");
    const { provider } = setup(fetch);
    const lone = "cut \uD83D";
    await provider.turn({
      ...request,
      system: lone,
      tools: [{ ...search, description: lone }],
      messages: [
        { role: "user", content: [{ type: "text", text: lone }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: lone },
            { type: "tool_use", id: "tu_1", name: "search", input: { query: "q" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "tu_1", content: lone, isError: false }],
        },
      ],
    });
    // JSON.stringify writes a lone surrogate as a \uD8xx escape, which the API refuses.
    const body = JSON.stringify(bodies[0]);
    expect(body).not.toMatch(/\\ud[89ab]/i);
    expect(body.split("cut \uFFFD")).toHaveLength(6);
  });

  it("sends the tools, one tool call per turn and a cache breakpoint on the last block", async () => {
    const { bodies, fetch } = cannedTurns([
      { type: "text", text: "Reading the page." },
      { type: "tool_use", id: "tu_2", name: "read_page", input: { id: "signals" } },
    ]);
    const { ledger, provider } = setup(fetch);
    const result = await provider.turn(request);
    expect(bodies[0]).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: [{ type: "text", text: "Answer the question." }],
      tools: [
        {
          name: "search",
          description: "Finds pages.",
          input_schema: search.inputSchema,
        },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [
        { role: "user", content: [{ type: "text", text: "Where are signals made?" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "search", input: { query: "signals" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "signals: …",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
      temperature: 0,
    });
    expect(result).toEqual({
      content: [
        { type: "text", text: "Reading the page." },
        { type: "tool_use", id: "tu_2", name: "read_page", input: { id: "signals" } },
      ],
      stopReason: "tool_use",
      usage: { in: 12, out: 5, cacheRead: 0, cacheWrite: 0 },
      model: "claude-haiku-4-5-20251001",
    });
    expect(ledger.entries()).toEqual([
      {
        runId: "eval-run",
        at: "2026-10-04T12:00:00.000Z",
        purpose: "evalAgent",
        model: "claude-haiku-4-5-20251001",
        featureId: null,
        batch: false,
        cacheKey: null,
        tokens: { in: 12, out: 5, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it("forbids tools on a final turn, marks an error result, and caches nothing unasked", async () => {
    const { bodies, fetch } = cannedTurns(
      [{ type: "text", text: "It is in ingest.py." }],
      "end_turn",
    );
    const { provider } = setup(fetch);
    const failed = request.messages.slice(0, 2).concat({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "tu_1", content: "bad input", isError: true }],
    });
    const result = await provider.turn({
      ...request,
      messages: failed,
      toolChoice: "none",
      cache: false,
      temperature: undefined,
    });
    expect(result.content).toEqual([{ type: "text", text: "It is in ingest.py." }]);
    expect(result.stopReason).toBe("end_turn");
    expect(bodies[0]?.tool_choice).toEqual({ type: "none" });
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
    expect(bodies[0]?.messages).toMatchObject([{}, {}, {}]);
    expect((bodies[0]?.messages as { content: unknown[] }[] | undefined)?.[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "bad input", is_error: true },
    ]);
  });

  it("forces one named tool, with one call, and refuses a tool the turn does not have", async () => {
    const answer: ToolDefinition = {
      name: "answer",
      description: "Answers.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    };
    const { bodies, fetch } = cannedTurns([
      { type: "tool_use", id: "tu_3", name: "answer", input: { text: "In ingest.py." } },
    ]);
    const { provider } = setup(fetch);
    const result = await provider.turn({
      ...request,
      tools: [search, answer],
      toolChoice: { tool: "answer" },
      cache: false,
    });
    expect(bodies[0]?.tool_choice).toEqual({
      type: "tool",
      name: "answer",
      disable_parallel_tool_use: true,
    });
    expect(result.content).toEqual([
      { type: "tool_use", id: "tu_3", name: "answer", input: { text: "In ingest.py." } },
    ]);
    await expect(provider.turn({ ...request, toolChoice: { tool: "answer" } })).rejects.toThrow(
      new LlmError("the turn forces tool answer, which is not one of its tools"),
    );
    expect(bodies).toHaveLength(1);
  });

  it("never sends an empty or whitespace-only text block, which the API refuses", async () => {
    const { bodies, fetch } = cannedTurns([{ type: "text", text: "ok" }], "end_turn");
    const { provider } = setup(fetch);
    await provider.turn({
      ...request,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Where are signals made?" },
            { type: "text", text: " \n\t" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "\n\n" },
            { type: "tool_use", id: "tu_1", name: "search", input: { query: "signals" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "tu_1", content: "x", isError: false }],
        },
      ],
    });
    const messages = bodies[0]?.messages as { content: { type: string }[] }[];
    expect(messages.map((m) => m.content.map((b) => b.type))).toEqual([
      ["text"],
      ["tool_use"],
      ["tool_result"],
    ]);
    const { bodies: none, fetch: noFetch } = cannedTurns([]);
    await expect(
      setup(noFetch).provider.turn({
        ...request,
        messages: [{ role: "user", content: [{ type: "text", text: "  \n" }] }],
      }),
    ).rejects.toThrow(new LlmError("message 0 has no content"));
    expect(none).toEqual([]);
  });

  it("passes a max_tokens or refusal stop through, and drops a block it does not know", async () => {
    for (const reason of ["max_tokens", "refusal"]) {
      const { fetch } = cannedTurns([], reason);
      const result = await setup(fetch).provider.turn(request);
      expect(result).toMatchObject({ content: [], stopReason: reason });
    }
    const { fetch } = cannedTurns([
      { type: "thinking", thinking: "hmm", signature: "s" },
      { type: "text", text: "Answer." },
      { type: "server_tool_use", id: "x", name: "web_search", input: {} },
    ]);
    expect((await setup(fetch).provider.turn(request)).content).toEqual([
      { type: "text", text: "Answer." },
    ]);
  });

  it("refuses a message left with no content, no messages, and a missing key, before any request", async () => {
    const { bodies, fetch } = cannedTurns([]);
    const { provider } = setup(fetch);
    const emptied = provider.turn({
      ...request,
      messages: [{ role: "user", content: [{ type: "text", text: "" }] }],
    });
    await expect(emptied).rejects.toBeInstanceOf(LlmError);
    await expect(emptied).rejects.toThrow("message 0 has no content");
    const none = provider.turn({ ...request, messages: [] });
    await expect(none).rejects.toBeInstanceOf(LlmError);
    await expect(none).rejects.toThrow("a turn needs at least one message");
    expect(bodies).toEqual([]);
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() =>
        createClaudeToolProvider({ models: DEFAULT_MODELS, ledger: createLedger(), runId: "r" }),
      ).toThrow(LlmError);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("ends a turn that outlasts its timeout with an LlmError, retrying nothing and recording no row", async () => {
    let calls = 0;
    const hung: FetchLike = (_input, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const ledger = createLedger();
    const provider = createClaudeToolProvider({
      models: DEFAULT_MODELS,
      ledger,
      runId: "ask-run",
      apiKey: "canned",
      fetch: hung,
      timeoutMs: 50,
    });
    const started = Date.now();
    const turn = provider.turn(request);
    await expect(turn).rejects.toBeInstanceOf(LlmError);
    await expect(turn).rejects.toThrow("the API did not answer within 0.05 s");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toBe(1);
    expect(ledger.entries()).toEqual([]);
  });
});
