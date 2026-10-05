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
import { combineToolSets } from "@repowiki/query";
import { describe, expect, it } from "vitest";
import { openMcpTools } from "./mcp-tools.ts";
import { loadQuestions, selectQuestions } from "./questions.ts";
import type { RunInfo } from "./records.ts";
import { createRepoTools } from "./repo-tools.ts";
import { renderReport } from "./report.ts";
import { runEval } from "./run.ts";
import { summarize } from "./summary.ts";
import { SMOKE_QUESTIONS, sampleWiki } from "./test-wiki.ts";

const mode = cassetteMode();
const cassette = fileURLToPath(new URL("./__cassettes__/smoke-mcp.json", import.meta.url));
/** About thirty live calls, unbatched; a replay spawns the server and takes a few seconds. */
const TIMEOUT_MS = mode === "record" ? 600_000 : 60_000;
const now = () => new Date("2026-10-04T12:00:00Z");
const TURN_LIMIT = 8;

describe("the smoke set through the MCP server with Claude (cassette)", () => {
  it(
    "asks the mcp and repo+mcp agents the fixture's questions through a spawned server, and judges them",
    async () => {
      const sample = sampleWiki();
      const out = mkdtempSync(join(tmpdir(), "repowiki-smoke-mcp-out-"));
      const runDir = mkdtempSync(join(tmpdir(), "repowiki-smoke-mcp-"));
      writeFileSync(join(out, "export.json"), JSON.stringify(sample.wiki));
      const mcp = await openMcpTools({ repo: sample.repo.dir, out, compareTo: sample.sha });
      try {
        const ledger = createLedger();
        const live = {
          models: DEFAULT_MODELS,
          ledger,
          runId: "smoke-mcp",
          apiKey: mode === "record" ? undefined : "cassette-replay",
          fetch: cassetteFetch(cassette, mode),
          now,
        };
        const questions = selectQuestions(loadQuestions(SMOKE_QUESTIONS).file, "smoke");
        const info: RunInfo = {
          set: "smoke",
          repo: sample.wiki.repo,
          head: sample.sha,
          exportHash: "0".repeat(64),
          questionsHash: "0".repeat(64),
          writtenOn: null,
          turnLimit: TURN_LIMIT,
          agents: ["mcp", "repo+mcp"],
          models: { evalAgent: DEFAULT_MODELS.evalAgent, evalJudge: DEFAULT_MODELS.evalJudge },
          buildTokens: 50_000,
          questions,
          startedAt: now().toISOString(),
        };
        const result = await runEval({
          runDir,
          info,
          tools: {
            mcp: mcp.tools,
            "repo+mcp": combineToolSets(createRepoTools(sample.repo.dir, sample.sha), mcp.tools),
          },
          agents: createClaudeToolProvider(live),
          judge: createClaudeProvider(live),
          batchJudge: false,
          maxUsd: 1,
          now,
        });
        // Haiku's answers vary between recordings, so the test pins what must hold for any of
        // them, as the M7 smoke test does: every question answered by both agents within the
        // limit, each using a tool, every answer judged, one ledger row per turn.
        expect(result.stopped).toBeNull();
        expect(result.unjudged).toBe(0);
        const answers = result.records.flatMap((r) => (r.kind === "answer" ? [r] : []));
        expect(answers.map((a) => `${a.questionId}/${a.agent}`).sort()).toEqual(
          questions.flatMap((q) => [`${q.id}/mcp`, `${q.id}/repo+mcp`]).sort(),
        );
        for (const answer of answers) {
          expect(answer.turns).toBeLessThanOrEqual(TURN_LIMIT);
          expect(answer.calls.length).toBeGreaterThan(0);
          expect(answer.answer).not.toBe("");
        }
        const mcpNames = new Set(mcp.tools.definitions.map((d) => d.name));
        expect(answers.some((a) => a.calls.some((c) => mcpNames.has(c.name)))).toBe(true);
        expect(result.records.filter((r) => r.kind === "judgment")).toHaveLength(6);
        const turns = answers.reduce((n, a) => n + a.turns, 0);
        expect(ledger.entries().filter((e) => e.purpose === "evalAgent")).toHaveLength(turns);
        const summary = summarize(info, result.records);
        expect(summary.complete).toBe(true);
        expect(renderReport(summary, result.records, null)).toContain("| mcp | ");
      } finally {
        await mcp.close();
        rmSync(runDir, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
        sample.repo.remove();
      }
    },
    TIMEOUT_MS,
  );
});
