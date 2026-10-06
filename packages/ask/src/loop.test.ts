import { AskResponse, NOT_FOUND_SENTENCE } from "@repowiki/core";
import { callCostUsd, LlmTimeoutError } from "@repowiki/llm";
import { WikiView } from "@repowiki/query";
import { extendedWiki, type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASK_MAX_TOKENS,
  AskError,
  askQuestion,
  CALL_ANSWER_NOW,
  TOOL_USE_PROMPT_TOKENS,
  turnBound,
} from "./loop.ts";
import { askIndexes, turnOnePack } from "./pack.ts";
import { answerTool, MAX_TURNS } from "./prompt.ts";
import {
  answerTurn,
  SCRIPTED_MODEL,
  type ScriptedTurn,
  scriptedProvider,
  TURN_USAGE,
} from "./test-provider.ts";

let sample: SampleWiki;
let view: WikiView;
beforeAll(() => {
  sample = sampleWiki();
  view = new WikiView(extendedWiki(sample));
});
afterAll(() => sample.repo.remove());

const QUESTION = "Where are signals made?";
const TURN_USD = callCostUsd(SCRIPTED_MODEL, TURN_USAGE, false) ?? 0;

async function ask(
  script: readonly ScriptedTurn[],
  overrides: { questionUsd?: number; page?: string } = {},
) {
  const { provider, requests } = scriptedProvider(script);
  const progress: unknown[] = [];
  const result = await askQuestion({
    provider,
    view,
    indexes: askIndexes(view),
    question: QUESTION,
    page: overrides.page ?? null,
    model: "claude-haiku-4-5",
    questionUsd: overrides.questionUsd ?? 0.05,
    onStatus: (p) => progress.push(p),
    now: () => new Date("2026-10-05T12:00:00Z"),
  });
  expect(AskResponse.parse(result.response)).toEqual(result.response);
  return { ...result, requests, progress };
}

/** The text of the last user message of a request. */
const lastUser = (request: { messages: readonly { content: readonly unknown[] }[] }) =>
  JSON.stringify(request.messages.at(-1)?.content);

describe("askQuestion", () => {
  it("answers from the pack in one turn, with the ask's turn settings", async () => {
    const { response, requests, tokens } = await ask([
      answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]),
    ]);
    expect(response).toMatchObject({
      status: "answered",
      sentences: [{ text: "Signals are made by `ingest_chunk`.", sources: [1] }],
      cost: { turns: 1, usd: TURN_USD, model: SCRIPTED_MODEL },
      answeredAt: "2026-10-05T12:00:00.000Z",
    });
    expect(tokens).toEqual(TURN_USAGE);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      purpose: "ask",
      maxTokens: ASK_MAX_TOKENS,
      toolChoice: "auto",
      cache: false,
      temperature: 0,
    });
    expect(requests[0]?.tools.map((t) => t.name)).toEqual(["search", "read_page", "answer"]);
    expect(requests[0]?.system).toContain('repository "sample"');
    expect(lastUser(requests[0] as never)).toContain(`Question: ${QUESTION}`);
  });

  it("reads a page and cites a claim only that page showed, reporting each step", async () => {
    const { response, progress } = await ask([
      { tool: "search", input: { query: "deliverable records" } },
      { tool: "read_page", input: { id: "deliverables" } },
      answerTurn([["Deliverables come from `create_deliverable`.", ["deliverables#d-1"]]]),
    ]);
    expect(response.status).toBe("answered");
    expect(response.sources[0]?.href).toBe("/wiki/deliverables/#claim-d-1");
    expect(progress).toEqual([
      { step: "search", query: "deliverable records" },
      { step: "read", pageId: "deliverables", title: "Deliverables" },
    ]);
  });

  it("refuses a handle the conversation never showed, then asks once more with the reasons", async () => {
    const { response, requests } = await ask([
      answerTurn([["Deliverables hold titles.", ["deliverables#d-h"]]]),
      answerTurn([["Still unshown.", ["deliverables#d-h"]]]),
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.toolChoice).toEqual({ tool: "answer" });
    const retry = lastUser(requests[1] as never);
    expect(retry).toContain("sentence 1: it cites no handle of a claim you were shown");
    expect(retry).not.toContain("Deliverables hold titles");
    expect(response).toMatchObject({
      status: "not-found",
      sentences: [{ text: NOT_FOUND_SENTENCE, sources: [] }],
      refused: 1,
      cost: { turns: 2 },
    });
  });

  it("does not ask again when at most half the sentences were refused", async () => {
    const { response, requests } = await ask([
      answerTurn([
        ["Signals are made by `ingest_chunk`.", ["signals#s-1"]],
        ["They live in src/signals/parse.py.", ["signals#s-1"]],
      ]),
    ]);
    expect(requests).toHaveLength(1);
    expect(response).toMatchObject({ status: "answered", refused: 1 });
  });

  it("forces answer on the fourth turn", async () => {
    const search = { tool: "search", input: { query: "signals" } };
    const { response, requests } = await ask([
      search,
      search,
      search,
      answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]),
    ]);
    expect(requests.map((r) => r.toolChoice)).toEqual(["auto", "auto", "auto", { tool: "answer" }]);
    expect(response.cost.turns).toBe(4);
  });

  it("asks for the answer after a turn of prose, and forces it", async () => {
    const { response, requests } = await ask([
      { text: "Signals are made in ingest.py." },
      answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]),
    ]);
    expect(requests[1]?.toolChoice).toEqual({ tool: "answer" });
    expect(lastUser(requests[1] as never)).toContain(CALL_ANSWER_NOW);
    expect(response.status).toBe("answered");
    expect(response.sentences.map((s) => s.text)).not.toContain("Signals are made in ingest.py.");
  });

  it("runs one tool a turn and tells the model the rest did not run", async () => {
    const { requests } = await ask([
      {
        tool: "read_page",
        input: { id: "signals" },
        also: { tool: "read_page", input: { id: "deliverables" } },
      },
      answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]),
    ]);
    const results = requests[1]?.messages.at(-1)?.content ?? [];
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({
      content: "Not run: call one tool per turn.",
      isError: true,
    });
  });

  it("is not-found when a forced turn gives no answer", async () => {
    const { response } = await ask([{ text: "Hmm." }, { text: "Still prose." }]);
    expect(response).toMatchObject({ status: "not-found", refused: 1, cost: { turns: 2 } });
  });

  it("returns every handle it rendered into the conversation: the pack's and the pages read", async () => {
    const { shown } = await ask([
      { tool: "read_page", input: { id: "deliverables" } },
      answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]),
    ]);
    const pack = turnOnePack(view, askIndexes(view), QUESTION, null).shown;
    expect(shown.slice(0, pack.length)).toEqual(pack);
    expect(shown).toContain("deliverables#d-1");
    expect(new Set(shown).size).toBe(shown.length);
  });

  it("stops with status budget, making no call, when the first turn could cross the cap", async () => {
    const { response, requests } = await ask([], { questionUsd: 0.001 });
    expect(requests).toEqual([]);
    expect(response).toMatchObject({ status: "budget", sentences: [], cost: { turns: 0, usd: 0 } });
    expect(response.readNext.length).toBeGreaterThan(0);
  });

  it("forces answer on a turn whose bound leaves no room for another", async () => {
    const answer = answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]);
    const free = await ask([answer]);
    const bound = turnBound("claude-haiku-4-5", free.requests[0] as never);
    expect(free.requests[0]?.toolChoice).toBe("auto");
    const tight = await ask([answer], { questionUsd: bound * 1.5 });
    expect(tight.requests[0]?.toolChoice).toEqual({ tool: "answer" });
    expect(tight.response.status).toBe("answered");
  });

  it("answers status error, with Read next and the turns it paid for, when the provider fails", async () => {
    const { response, error } = await ask([
      { tool: "search", input: { query: "signals" } },
      { error: new Error("overloaded\nretry later") },
    ]);
    expect(response).toMatchObject({
      status: "error",
      sentences: [],
      cost: { turns: 1, usd: TURN_USD },
    });
    expect(response.readNext.length).toBeGreaterThan(0);
    expect(error).toBe("overloaded retry later");
  });

  it("counts a turn that timed out after it was sent at its bound, as it may have been billed", async () => {
    const spends: number[] = [];
    const { provider, requests } = scriptedProvider([
      { tool: "search", input: { query: "signals" } },
      { error: new LlmTimeoutError(60_000) },
    ]);
    const { response, error } = await askQuestion({
      provider,
      view,
      indexes: askIndexes(view),
      question: QUESTION,
      page: null,
      model: "claude-haiku-4-5",
      questionUsd: 0.05,
      onSpend: (usd) => spends.push(usd),
      now: () => new Date("2026-10-05T12:00:00Z"),
    });
    const bound = turnBound("claude-haiku-4-5", requests[1] as never);
    expect(error).toBe("the API did not answer within 60 s");
    expect(response.status).toBe("error");
    expect(response.cost.turns).toBe(2);
    expect(response.cost.usd).toBeCloseTo(TURN_USD + bound, 12);
    expect(spends).toEqual([TURN_USD, bound]);
  });

  it("refuses a model with no price before any call", async () => {
    const { provider, requests } = scriptedProvider([]);
    await expect(
      askQuestion({
        provider,
        view,
        indexes: askIndexes(view),
        question: QUESTION,
        page: null,
        model: "claude-unknown-9",
        questionUsd: 0.05,
      }),
    ).rejects.toThrow(AskError);
    expect(requests).toEqual([]);
  });

  it("sums tokens and dollars over every turn", async () => {
    const { response, tokens } = await ask([
      { tool: "read_page", input: { id: "signals" } },
      answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]),
    ]);
    expect(tokens).toEqual({ in: 4000, out: 400, cacheRead: 0, cacheWrite: 0 });
    expect(response.cost.usd).toBeCloseTo(2 * TURN_USD, 10);
  });

  it("bounds a turn by its whole request at 2.5 characters a token, the API's tool-use prompt and the output cap", () => {
    const request = {
      purpose: "ask" as const,
      system: "x".repeat(250),
      tools: [answerTool],
      messages: [],
      maxTokens: 1000,
      toolChoice: "auto" as const,
      cache: false,
    };
    const chars = 250 + JSON.stringify([answerTool]).length + 2;
    expect(TOOL_USE_PROMPT_TOKENS).toBeGreaterThanOrEqual(346);
    expect(turnBound("claude-haiku-4-5", request)).toBeCloseTo(
      ((Math.ceil(chars / 2.5) + TOOL_USE_PROMPT_TOKENS) * 1 + 1000 * 5) / 1_000_000,
      12,
    );
  });

  it("stops after its last allowed turn when the provider ignores the forced answer", async () => {
    const search: ScriptedTurn = { tool: "search", input: { query: "signals" } };
    const { response, requests } = await ask(Array(12).fill(search), { questionUsd: 1 });
    expect(requests).toHaveLength(MAX_TURNS);
    expect(requests.at(-1)?.toolChoice).toEqual({ tool: "answer" });
    expect(response).toMatchObject({ status: "not-found", refused: 1, cost: { turns: MAX_TURNS } });
  });

  it("takes at most one turn more than MAX_TURNS for a retry the provider does not answer", async () => {
    const search: ScriptedTurn = { tool: "search", input: { query: "signals" } };
    const refused = answerTurn([["It is in `nowhere_at_all`.", ["signals#s-1"]]]);
    const { response, requests } = await ask([search, search, search, refused, search, search], {
      questionUsd: 1,
    });
    expect(requests).toHaveLength(MAX_TURNS + 1);
    expect(response).toMatchObject({ status: "not-found", cost: { turns: MAX_TURNS + 1 } });
  });
});
