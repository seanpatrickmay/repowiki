// Re-record (live, costs money; review the diff, then run packages/llm/src/cassette-secrets.test.ts):
// REPOWIKI_CASSETTE=record node --env-file=<RepoWiki checkout>/.env node_modules/vitest/vitest.mjs run packages/eval/src/history-eval.claude.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cassetteFetch,
  cassetteMode,
  createClaudeProvider,
  createClaudeToolProvider,
  createLedger,
  DEFAULT_MODELS,
} from "@repowiki/llm";
import { createWikiTools } from "@repowiki/query";
import { describe, expect, it } from "vitest";
import { type McpAgentTools, openMcpTools } from "./mcp-tools.ts";
import { loadQuestions, selectQuestions } from "./questions.ts";
import type { RunInfo } from "./records.ts";
import { renderReport } from "./report.ts";
import { runEval } from "./run.ts";
import { summarize } from "./summary.ts";
import { HISTORY_SMOKE_QUESTIONS, historyWiki } from "./test-wiki.ts";

const mode = cassetteMode();
const cassette = fileURLToPath(new URL("./__cassettes__/smoke-history.json", import.meta.url));
/** About twenty live calls, unbatched; a replay spawns the server and takes a few seconds. */
const TIMEOUT_MS = mode === "record" ? 600_000 : 60_000;
const now = () => new Date("2026-10-04T12:00:00Z");
const TURN_LIMIT = 8;

describe("the history smoke questions through the MCP server with Claude (cassette)", () => {
  it(
    "asks the wiki and mcp agents about historyWiki()'s past, and judges them",
    async () => {
      const sample = historyWiki();
      const out = mkdtempSync(join(tmpdir(), "repowiki-smoke-history-out-"));
      const runDir = mkdtempSync(join(tmpdir(), "repowiki-smoke-history-"));
      // Everything made above is removed in finally, even when the server fails to start.
      let opened: McpAgentTools | undefined;
      try {
        writeFileSync(join(out, "export.json"), JSON.stringify(sample.wiki));
        opened = await openMcpTools({ repo: sample.repo.dir, out, compareTo: sample.wiki.head });
        const mcp = opened;
        const ledger = createLedger();
        const live = {
          models: DEFAULT_MODELS,
          ledger,
          runId: "smoke-history",
          apiKey: mode === "record" ? undefined : "cassette-replay",
          fetch: cassetteFetch(cassette, mode),
          now,
        };
        const questions = selectQuestions(loadQuestions(HISTORY_SMOKE_QUESTIONS).file, "smoke");
        const info: RunInfo = {
          set: "smoke",
          repo: sample.wiki.repo,
          head: sample.wiki.head,
          exportHash: "0".repeat(64),
          questionsHash: "0".repeat(64),
          writtenOn: null,
          turnLimit: TURN_LIMIT,
          agents: ["wiki", "mcp"],
          models: { evalAgent: DEFAULT_MODELS.evalAgent, evalJudge: DEFAULT_MODELS.evalJudge },
          buildTokens: 50_000,
          questions,
          startedAt: now().toISOString(),
        };
        const result = await runEval({
          runDir,
          info,
          tools: {
            wiki: createWikiTools(sample.wiki),
            mcp: mcp.tools,
          },
          agents: createClaudeToolProvider(live),
          judge: createClaudeProvider(live),
          batchJudge: false,
          maxUsd: 1,
          now,
        });
        // Haiku's answers vary between recordings, so the test pins what must hold for any of
        // them, as the M7 smoke test does: every question answered by both agents within the
        // limit, each using a tool, the mcp agent reading the past at least once, every answer judged, one ledger row per turn.
        expect(result.stopped).toBeNull();
        expect(result.unjudged).toBe(0);
        const answers = result.records.flatMap((r) => (r.kind === "answer" ? [r] : []));
        expect(answers.map((a) => `${a.questionId}/${a.agent}`).sort()).toEqual(
          questions.flatMap((q) => [`${q.id}/mcp`, `${q.id}/wiki`]).sort(),
        );
        for (const answer of answers) {
          expect(answer.turns).toBeLessThanOrEqual(TURN_LIMIT);
          expect(answer.calls.length).toBeGreaterThan(0);
          expect(answer.answer).not.toBe("");
        }
        // The history questions are what as_of and page_changes are for.
        expect(
          answers.some(
            (a) =>
              a.agent === "mcp" &&
              a.calls.some(
                (c) => c.name === "page_changes" || JSON.stringify(c.input).includes("as_of"),
              ),
          ),
        ).toBe(true);
        expect(result.records.filter((r) => r.kind === "judgment")).toHaveLength(6);
        const turns = answers.reduce((n, a) => n + a.turns, 0);
        expect(ledger.entries().filter((e) => e.purpose === "evalAgent")).toHaveLength(turns);
        const summary = summarize(info, result.records);
        expect(summary.complete).toBe(true);
        expect(renderReport(summary, result.records, null)).toContain("## The agent interface");
      } finally {
        await opened?.close();
        rmSync(runDir, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
        sample.repo.remove();
      }
    },
    TIMEOUT_MS,
  );
});
