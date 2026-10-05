import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskRequest } from "@repowiki/core";
import { callCostUsd } from "@repowiki/llm";
import { extendedWiki, type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportHash, openAnswerCache } from "./cache.ts";
import { BusyError, createAskSession } from "./session.ts";
import {
  answerTurn,
  SCRIPTED_MODEL,
  type ScriptedTurn,
  scriptedProvider,
  TURN_USAGE,
} from "./test-provider.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "repowiki-ask-session-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TURN_USD = callCostUsd(SCRIPTED_MODEL, TURN_USAGE, false) ?? 0;
const ANSWER = answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]);

function session(script: ScriptedTurn[], caps: { questionUsd?: number; maxUsd?: number } = {}) {
  const wiki = extendedWiki(sample);
  const { provider, requests } = scriptedProvider(script);
  const lines: string[] = [];
  const s = createAskSession({
    wiki,
    provider,
    model: "claude-haiku-4-5",
    questionUsd: caps.questionUsd ?? 0.05,
    maxUsd: caps.maxUsd ?? 1,
    cache: openAnswerCache(join(dir, "ask"), exportHash(wiki)),
    log: (line) => lines.push(line),
    now: () => new Date("2026-10-05T12:00:00Z"),
  });
  return { session: s, requests, lines };
}

const ask = (question: string, extra: Partial<AskRequest> = {}) =>
  AskRequest.parse({ question, ...extra });

describe("createAskSession", () => {
  it("answers a question, logs one line, and serves it again from the cache at no cost", async () => {
    const { session: s, requests, lines } = session([ANSWER]);
    const first = await s.ask(ask("Where are signals made?"));
    expect(first).toMatchObject({ status: "answered", cached: false });
    const again = await s.ask(ask("where are  SIGNALS made"));
    expect(again).toMatchObject({
      status: "answered",
      cached: true,
      question: "where are  SIGNALS made",
    });
    expect(requests).toHaveLength(1);
    expect(s.totals()).toEqual({ questions: 2, cached: 1, usd: TURN_USD });
    expect(lines).toEqual([
      `ask "Where are signals made?" \u2192 answered, 1 turn, $${TURN_USD.toFixed(4)} (session $${TURN_USD.toFixed(4)} of $1.00)`,
      'ask "where are SIGNALS made" \u2192 answered (cached)',
    ]);
  });

  it("asks again past the cache when fresh, and keeps the new answer", async () => {
    const { session: s, requests } = session([ANSWER, ANSWER]);
    await s.ask(ask("Where are signals made?"));
    expect((await s.ask(ask("Where are signals made?", { fresh: true }))).cached).toBe(false);
    expect(requests).toHaveLength(2);
    expect((await s.ask(ask("Where are signals made?"))).cached).toBe(true);
  });

  it("keys the cache by the page the hint resolves to", async () => {
    const { session: s, requests } = session([ANSWER, ANSWER]);
    await s.ask(ask("Where are signals made?", { page: "signals" }));
    expect((await s.ask(ask("Where are signals made?", { page: "legacy-signals" }))).cached).toBe(
      true,
    );
    expect((await s.ask(ask("Where are signals made?", { page: "nowhere" }))).cached).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("answers one question at a time", async () => {
    const { session: s } = session([ANSWER]);
    const first = s.ask(ask("Where are signals made?"));
    await expect(s.ask(ask("What are deliverables?"))).rejects.toBeInstanceOf(BusyError);
    await first;
    await s.idle();
  });

  it("starts a question only if the session cap still covers its cap, and says so", async () => {
    const {
      session: s,
      requests,
      lines,
    } = session([ANSWER, ANSWER], {
      questionUsd: 0.05,
      maxUsd: 0.052,
    });
    expect(s.status()).toMatchObject({ mode: "answer", questionUsd: 0.05, sessionLeftUsd: 0.052 });
    await s.ask(ask("Where are signals made?"));
    expect(s.status()).toEqual({ mode: "routing", head: sample.sha, reason: "budget" });
    const over = await s.ask(ask("What are deliverables?"));
    expect(over).toMatchObject({ status: "budget", sentences: [], cost: { turns: 0 } });
    expect(over.readNext.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
    expect(lines[1]).toMatch(/^ask "What are deliverables\?" \u2192 budget, 0 turns, \$0\.0000/);
    expect((await s.ask(ask("Where are signals made?"))).cached).toBe(true);
    expect(s.totals()).toEqual({ questions: 3, cached: 1, usd: TURN_USD });
  });

  it("caches neither a budget nor an error answer", async () => {
    const { session: s, requests, lines } = session([{ error: new Error("overloaded") }, ANSWER]);
    expect((await s.ask(ask("Where are signals made?"))).status).toBe("error");
    expect(lines[0]).toMatch(/\u2192 error \(overloaded\), 0 turns/);
    expect(s.totals()).toEqual({ questions: 1, cached: 0, usd: 0 });
    expect((await s.ask(ask("Where are signals made?"))).status).toBe("answered");
    expect(requests).toHaveLength(2);
  });

  it("logs a question that throws after a paid turn, and counts what it spent", async () => {
    const broken = {
      content: null,
      stopReason: "tool_use",
      usage: TURN_USAGE,
      model: SCRIPTED_MODEL,
    } as unknown as ScriptedTurn;
    const { session: s, lines } = session(
      [{ tool: "search", input: { query: "signals" } }, broken],
      {
        questionUsd: 0.05,
        maxUsd: 0.055,
      },
    );
    await expect(s.ask(ask("Where are signals made?"))).rejects.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^ask "Where are signals made\?" \u2192 failed \(.+\), \$0\.0060 \(session \$0\.0060 of \$0\.0\d\)$/,
    );
    expect(s.totals()).toEqual({ questions: 1, cached: 0, usd: 2 * TURN_USD });
    expect(s.status()).toEqual({ mode: "routing", head: sample.sha, reason: "budget" });
  });

  it("keeps a hostile question on one short line in the log", async () => {
    const { session: s, lines } = session([ANSWER]);
    await s.ask(ask(`evil\n\u001b[31m${"x".repeat(100)}`));
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]).not.toContain("\u001b");
    expect(lines[0]).toContain(`"evil \uFFFD[31m${"x".repeat(49)}\u2026"`);
  });
});
