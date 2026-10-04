import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJournal, openStore } from "@repowiki/engine";
import {
  createRepoTools,
  createWikiTools,
  type EvalRunOptions,
  judgeAnswer,
  loadQuestions,
  type RunInfo,
  readRecords,
  selectQuestions,
} from "@repowiki/eval";
import { type SampleWiki, SMOKE_QUESTIONS, sampleWiki } from "@repowiki/eval/test-wiki";
import {
  createLedger,
  DEFAULT_MODELS,
  type FetchLike,
  type Provider,
  requestKey,
  type ToolProvider,
} from "@repowiki/llm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createJudgeProvider, logLine, runEvalJournaled } from "./eval-cli.ts";
import { exitWithError } from "./wiki-cli.ts";

let sample: SampleWiki;
let dir: string;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "repowiki-eval-journal-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** Shaped like an Anthropic key; no real key looks like this. */
const FAKE_KEY = `sk-ant-api03-${"Q".repeat(24)}`;

const questions = selectQuestions(loadQuestions(SMOKE_QUESTIONS).file, "smoke");

function info(): RunInfo {
  return {
    set: "smoke",
    repo: "sample",
    head: sample.sha,
    exportHash: "e".repeat(64),
    questionsHash: "f".repeat(64),
    writtenOn: null,
    turnLimit: 4,
    models: { evalAgent: "claude-haiku-4-5", evalJudge: "claude-haiku-4-5" },
    buildTokens: null,
    questions,
    startedAt: "2026-10-04T12:00:00.000Z",
  };
}

/** Answers every question at once, so the wiki store's journal is the only state a rerun has. */
const answeringAgents = (calls: { n: number }): ToolProvider => ({
  async turn() {
    calls.n++;
    return {
      content: [{ type: "text", text: "an answer" }],
      stopReason: "end_turn",
      usage: { in: 100, out: 10, cacheRead: 0, cacheWrite: 0 },
      model: "claude-haiku-4-5-20251001",
    };
  },
});

function options(overrides: Partial<EvalRunOptions>): EvalRunOptions {
  return {
    runDir: join(dir, "run"),
    info: info(),
    wikiTools: createWikiTools(sample.wiki),
    repoTools: createRepoTools(sample.repo.dir, sample.sha),
    agents: answeringAgents({ n: 0 }),
    judge: { generate: () => Promise.reject(new Error("no judge")) },
    batchJudge: true,
    maxUsd: 5,
    ...overrides,
  };
}

const VERDICT = {
  facts: [{ fact: "the answer", essential: true, present: true }],
  contradicts: false,
  reason: "States it.",
};

const batchBody = (status: "in_progress" | "ended") => ({
  id: "msgbatch_judge",
  type: "message_batch",
  processing_status: status,
  request_counts: {
    processing: status === "ended" ? 0 : 6,
    succeeded: 0,
    errored: 0,
    canceled: 0,
    expired: 0,
  },
  results_url:
    status === "ended"
      ? "https://api.anthropic.com/v1/messages/batches/msgbatch_judge/results"
      : null,
  created_at: new Date().toISOString(),
  ended_at: null,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  archived_at: null,
  cancel_initiated_at: null,
});

const reply = (status: number, body: unknown, type = "application/json") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": type },
  });

/**
 * A Batches API that takes a batch and then fails every later call as a revoked key would: the
 * run is as good as killed with its batch in flight. Keeps the posted batches.
 */
function killedApi() {
  const posts: { requests: { custom_id: string; params: unknown }[] }[] = [];
  const fetch: FetchLike = async (_input, init) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return reply(200, batchBody("in_progress"));
    }
    return reply(401, {
      type: "error",
      error: { type: "authentication_error", message: "killed" },
    });
  };
  return { fetch, posts };
}

/** The same API after the batch ended: serves its results, and counts any new batch. */
function endedApi(customIds: string[]) {
  const calls: string[] = [];
  const results = customIds
    .map((custom_id) =>
      JSON.stringify({
        custom_id,
        result: {
          type: "succeeded",
          message: {
            id: "msg_judge",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5-20251001",
            content: [{ type: "text", text: JSON.stringify(VERDICT) }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 500, output_tokens: 100 },
          },
        },
      }),
    )
    .join("\n");
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/results")) return reply(200, results, "application/x-jsonl");
    return reply(200, batchBody("ended"));
  };
  return { fetch, calls };
}

/**
 * A Batches API that ends every batch at once: batch n answers each of its requests with
 * `answers[n - 1]` (500 in, 100 out). Keeps the posted batches and the calls.
 */
function sequentialApi(answers: string[]) {
  const posts: { requests: { custom_id: string; params: { messages: unknown[] } }[] }[] = [];
  const calls: string[] = [];
  const ended = (n: number) => ({
    ...batchBody("ended"),
    id: `msgbatch_${n}`,
    results_url: `https://api.anthropic.com/v1/messages/batches/msgbatch_${n}/results`,
  });
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return reply(200, ended(posts.length));
    }
    const n = Number(/msgbatch_(\d+)/.exec(path)?.[1]);
    if (!path.endsWith("/results")) return reply(200, ended(n));
    const lines = (posts[n - 1]?.requests ?? []).map(({ custom_id }) =>
      JSON.stringify({
        custom_id,
        result: {
          type: "succeeded",
          message: {
            id: `msg_${n}`,
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5-20251001",
            content: [{ type: "text", text: answers[n - 1] }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 500, output_tokens: 100 },
          },
        },
      }),
    );
    return reply(200, lines.join("\n"), "application/x-jsonl");
  };
  return { fetch, posts, calls };
}

describe("the judge's retry with the batch journal", () => {
  it("asks again with a new request after an unusable verdict, and counts each call once", async () => {
    const store = openStore(join(dir, "wiki.db"));
    try {
      const journal = buildJournal(store);
      const tooMany = { ...VERDICT, facts: Array.from({ length: 13 }, () => VERDICT.facts[0]) };
      const api = sequentialApi([JSON.stringify(tooMany), JSON.stringify(VERDICT)]);
      const judge = createJudgeProvider({
        models: DEFAULT_MODELS,
        ledger: createLedger(),
        runId: "eval-smoke-test",
        journal,
        log: () => {},
        client: { apiKey: "canned", fetch: api.fetch, pollIntervalMs: 0 },
      });
      const question = questions[0];
      if (question === undefined) throw new Error("the smoke file has questions");
      const judgment = await judgeAnswer(judge, question, "an answer", true);
      expect(judgment).toMatchObject({ score: 1, usage: { in: 1000, out: 200 } });
      expect(api.calls.filter((c) => c === "POST /v1/messages/batches")).toHaveLength(2);
      const [first, second] = api.posts.map((p) => p.requests[0]?.params);
      expect(first?.messages).toHaveLength(1);
      expect(second?.messages).toHaveLength(2);
      expect(JSON.stringify(second?.messages[1])).toContain("not a usable verdict");
      expect(requestKey(second as never)).not.toBe(requestKey(first as never));
      journal.flush();
    } finally {
      store.close();
    }
  });
});

describe("the judge batch journal", () => {
  it("collects a judge batch a killed run left in flight instead of submitting another", async () => {
    const storePath = join(dir, "wiki.db");
    const make = (fetch: FetchLike, store: ReturnType<typeof openStore>) => {
      const journal = buildJournal(store);
      const judge = createJudgeProvider({
        models: DEFAULT_MODELS,
        ledger: createLedger(),
        runId: "eval-smoke-test",
        journal,
        log: () => {},
        client: { apiKey: "canned", fetch, pollIntervalMs: 0 },
      });
      return { journal, judge };
    };

    const first = openStore(storePath);
    const killed = killedApi();
    const run1 = make(killed.fetch, first);
    await expect(runEvalJournaled(run1.journal, options({ judge: run1.judge }))).rejects.toThrow();
    expect(killed.posts).toHaveLength(1);
    const sent = killed.posts[0]?.requests ?? [];
    expect(sent).toHaveLength(6);
    const keys = sent.map((r) => requestKey(r.params as never));
    // The batch is journaled and still held: the run died before reading it.
    for (const key of keys) expect(first.findBatchRequest(key)?.batchId).toBe("msgbatch_judge");
    first.close();

    // A new process: the store is reopened, the answers are already recorded.
    const second = openStore(storePath);
    const ended = endedApi(sent.map((r) => r.custom_id));
    const agents = { n: 0 };
    const run2 = make(ended.fetch, second);
    const result = await runEvalJournaled(
      run2.journal,
      options({ judge: run2.judge, agents: answeringAgents(agents) }),
    );
    expect(ended.calls.filter((c) => c === "POST /v1/messages/batches")).toEqual([]);
    expect(ended.calls).toContain("GET /v1/messages/batches/msgbatch_judge");
    expect(agents.n).toBe(0);
    expect(result.unjudged).toBe(0);
    expect(readRecords(join(dir, "run")).filter((r) => r.kind === "judgment")).toHaveLength(6);
    // Collected and recorded: the rows are forgotten, so a later run is not tied to this batch.
    for (const key of keys) expect(second.findBatchRequest(key)).toBeNull();
    second.close();
  });
});

describe("errors that reach the terminal", () => {
  const exitSpy = () =>
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

  it("prints an agent's error, key in message and cause, as one redacted line, exit 1", async () => {
    const agents: ToolProvider = {
      turn: () =>
        Promise.reject(
          new Error(`401 invalid x-api-key ${FAKE_KEY}\nat Object.fetch (node:internal)`, {
            cause: new Error(`header ${FAKE_KEY}`),
          }),
        ),
    };
    const err = await runEvalJournaled(
      { flush: () => {} },
      options({ agents, runDir: join(dir, "agent-run") }),
    ).catch((e: unknown) => e);
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = exitSpy();
    expect(() => exitWithError(err)).toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(printed).toHaveBeenCalledTimes(1);
    const text = String(printed.mock.calls[0]?.[0]);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toMatch(/[\n\r]/);
  });

  it("prints a judge's error the same way, and redacts what runEval logs about a judgment", async () => {
    const lines: string[] = [];
    const judge: Provider = {
      generate: () => Promise.reject(new Error(`judge rejected the key ${FAKE_KEY}`)),
    };
    const err = await runEvalJournaled(
      { flush: () => {} },
      options({ judge, runDir: join(dir, "judge-run"), log: (l) => lines.push(l) }),
    ).catch((e: unknown) => e);
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy();
    expect(() => exitWithError(err)).toThrow("exit 1");
    expect(printed).toHaveBeenCalledTimes(1);
    expect(String(printed.mock.calls[0]?.[0])).toBe("judge rejected the key [redacted]");
    // eval-run.ts hands runEval `logLine`, so a message a judge or an id carries is cleaned too.
    printed.mockClear();
    logLine(`q1 (wiki): unusable output ${FAKE_KEY}\u202E\nsecond line`);
    expect(printed).toHaveBeenCalledWith("q1 (wiki): unusable output [redacted]? second line");
  });

  it("never lets the store or git errors through raw", () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy();
    expect(() =>
      exitWithError(new Error(`fatal: bad object ${FAKE_KEY}\n  at stack frame`)),
    ).toThrow("exit 1");
    expect(printed.mock.calls[0]?.[0]).toBe("fatal: bad object [redacted] at stack frame");
  });
});

/** No network: no key but the one a test sets, and a base URL nothing listens on. */
function run(env: Record<string, string>, ...args: string[]) {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      !/^(ANTHROPIC_.*|(HTTP|HTTPS|ALL|NO)_PROXY|NODE_USE_ENV_PROXY|REPOWIKI_CASSETTE)$/i.test(name)
    )
      clean[name] = value;
  }
  return spawnSync(process.execPath, ["scripts/eval-run.ts", sample.repo.dir, ...args], {
    encoding: "utf8",
    env: { ...clean, HOME: dir, ...env },
  });
}

describe("eval-run.ts as a process: store and error output", () => {
  it("prints a key in an error as one redacted line, exit 1", () => {
    const out = join(dir, `wiki-${FAKE_KEY}`);
    const result = run({}, "--out", out, "--questions", SMOKE_QUESTIONS, "--set", "smoke");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(FAKE_KEY);
    expect(result.stderr).toMatch(
      /^no export at .*wiki-\[redacted\]\/export\.json; run pnpm wiki:build first\n$/,
    );
  });

  it("needs the wiki store for the batch journal, and says so before any call", () => {
    const out = join(dir, "wiki");
    mkdirSync(out);
    writeFileSync(join(out, "export.json"), JSON.stringify(sample.wiki));
    const result = run(
      { ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: "http://127.0.0.1:1" },
      "--out",
      out,
      "--questions",
      SMOKE_QUESTIONS,
      "--set",
      "smoke",
    );
    expect(result.status).toBe(1);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(
      /^run directory: .*\/wiki\/eval\/smoke-[0-9TZ-]+ \(rerun with --run-dir .*\/wiki\/eval\/smoke-[0-9TZ-]+ to resume\)$/,
    );
    expect(lines[2]).toBe(
      `no wiki store at ${join(out, "wiki.db")}; run pnpm wiki:build first (eval:run keeps its batch journal there)`,
    );
    expect(result.stderr).not.toContain(FAKE_KEY);
    expect(existsSync(join(out, "eval"))).toBe(false);
    expect(existsSync(join(out, "wiki.db"))).toBe(false);
  });
});
