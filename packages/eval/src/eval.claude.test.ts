import { mkdtempSync, rmSync } from "node:fs";
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
import { loadQuestions, selectQuestions } from "./questions.ts";
import type { RunInfo } from "./records.ts";
import { createRepoTools } from "./repo-tools.ts";
import { renderReport } from "./report.ts";
import { runEval } from "./run.ts";
import { summarize } from "./summary.ts";
import { SMOKE_QUESTIONS, sampleWiki } from "./test-wiki.ts";

const mode = cassetteMode();
const cassette = (name: string) =>
  fileURLToPath(new URL(`./__cassettes__/${name}.json`, import.meta.url));
/** About twenty live calls, unbatched; a replay is instant. */
const TIMEOUT_MS = mode === "record" ? 600_000 : undefined;
const now = () => new Date("2026-10-04T12:00:00Z");
const TURN_LIMIT = 8;

describe("the smoke set with Claude (cassette)", () => {
  it(
    "asks both agents the fixture's questions and judges every answer, from the recording",
    async () => {
      const sample = sampleWiki();
      const runDir = mkdtempSync(join(tmpdir(), "repowiki-smoke-"));
      try {
        const ledger = createLedger();
        const live = {
          models: DEFAULT_MODELS,
          ledger,
          runId: "smoke",
          apiKey: mode === "record" ? undefined : "cassette-replay",
          fetch: cassetteFetch(cassette("smoke-run"), mode),
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
          models: { evalAgent: DEFAULT_MODELS.evalAgent, evalJudge: DEFAULT_MODELS.evalJudge },
          buildTokens: 50_000,
          questions,
          startedAt: now().toISOString(),
        };
        const result = await runEval({
          runDir,
          info,
          wikiTools: createWikiTools(sample.wiki),
          repoTools: createRepoTools(sample.repo.dir, sample.sha),
          agents: createClaudeToolProvider(live),
          judge: createClaudeProvider(live),
          batchJudge: false,
          maxUsd: 1,
          now,
        });
        // Haiku's answers vary between recordings, so the test pins what must hold for any of
        // them: every question answered by both agents within the limit, using its tools, and
        // every answer judged; one ledger row per turn and per judge call.
        expect(result.stopped).toBeNull();
        expect(result.unjudged).toBe(0);
        const answers = result.records.flatMap((r) => (r.kind === "answer" ? [r] : []));
        expect(answers.map((a) => `${a.questionId}/${a.agent}`).sort()).toEqual(
          questions.flatMap((q) => [`${q.id}/repo`, `${q.id}/wiki`]).sort(),
        );
        for (const answer of answers) {
          expect(answer.turns).toBeLessThanOrEqual(TURN_LIMIT);
          expect(answer.calls.length).toBeGreaterThan(0);
          expect(answer.answer).not.toBe("");
          expect(answer.model?.startsWith("claude-haiku-4-5")).toBe(true);
        }
        expect(result.records.filter((r) => r.kind === "judgment")).toHaveLength(6);
        const entries = ledger.entries();
        const turns = answers.reduce((n, a) => n + a.turns, 0);
        expect(entries.filter((e) => e.purpose === "evalAgent")).toHaveLength(turns);
        expect(entries.filter((e) => e.purpose === "evalJudge").length).toBeGreaterThanOrEqual(6);
        expect(entries.every((e) => !e.batch && e.featureId === null)).toBe(true);
        const summary = summarize(info, result.records);
        expect(summary.complete).toBe(true);
        expect(renderReport(summary, result.records, null)).toContain("This is the smoke set");
      } finally {
        rmSync(runDir, { recursive: true, force: true });
        sample.repo.remove();
      }
    },
    TIMEOUT_MS,
  );
});
