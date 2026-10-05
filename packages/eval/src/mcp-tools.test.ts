import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Provider } from "@repowiki/llm";
import { combineToolSets } from "@repowiki/query";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type McpAgentTools, openMcpTools } from "./mcp-tools.ts";
import { agentSystemPrompt } from "./prompts.ts";
import { loadQuestions, selectQuestions } from "./questions.ts";
import type { RunInfo } from "./records.ts";
import { createRepoTools } from "./repo-tools.ts";
import { runEval } from "./run.ts";
import { summarize } from "./summary.ts";
import { scriptedToolProvider } from "./test-provider.ts";
import { type SampleWiki, SMOKE_QUESTIONS, sampleWiki } from "./test-wiki.ts";

/** Spawning the server and loading the engine takes a few seconds on a loaded machine. */
const PROCESS_TIMEOUT_MS = 30_000;

let sample: SampleWiki;
let out: string;
let mcp: McpAgentTools;
beforeAll(async () => {
  sample = sampleWiki();
  out = mkdtempSync(join(tmpdir(), "repowiki-mcp-eval-"));
  writeFileSync(join(out, "export.json"), JSON.stringify(sample.wiki));
  mcp = await openMcpTools({ repo: sample.repo.dir, out, compareTo: sample.sha });
}, PROCESS_TIMEOUT_MS);
afterAll(async () => {
  await mcp.close();
  sample.repo.remove();
  rmSync(out, { recursive: true, force: true });
});

describe("the mcp and repo+mcp agents", () => {
  it("get the server's six tools, and the repository's three beside them", () => {
    expect(mcp.tools.definitions.map((d) => d.name)).toEqual([
      "search",
      "list_pages",
      "read_page",
      "pages_for_file",
      "cited_code",
      "page_changes",
    ]);
    const both = combineToolSets(createRepoTools(sample.repo.dir, sample.sha), mcp.tools);
    expect(both.definitions).toHaveLength(9);
  });

  it(
    "answer the smoke set through a spawned server, each call recorded",
    async () => {
      const runDir = mkdtempSync(join(tmpdir(), "repowiki-mcp-run-"));
      try {
        const questions = selectQuestions(loadQuestions(SMOKE_QUESTIONS).file, "smoke");
        const info: RunInfo = {
          set: "smoke",
          repo: "sample",
          head: sample.sha,
          exportHash: "e".repeat(64),
          questionsHash: "f".repeat(64),
          writtenOn: null,
          turnLimit: 4,
          agents: ["mcp", "repo+mcp"],
          models: { evalAgent: "claude-haiku-4-5", evalJudge: "claude-haiku-4-5" },
          buildTokens: null,
          questions,
          startedAt: "2026-10-04T12:00:00.000Z",
        };
        // Every agent reads the signals page once, then answers with what it read.
        const { provider, requests } = scriptedToolProvider([], (_q, request) => {
          const last = request.messages.at(-1)?.content[0];
          return last?.type === "tool_result"
            ? { answer: last.content.split("\n")[0] ?? "" }
            : { tool: "read_page", input: { id: "signals" } };
        });
        const judge: Provider = {
          async generate<T>(request: GenerateRequest<T>) {
            return {
              output: request.schema.parse({
                facts: [{ fact: "f", essential: true, present: true }],
                contradicts: false,
                reason: "ok",
              }),
              usage: { in: 10, out: 10, cacheRead: 0, cacheWrite: 0 },
              model: "claude-haiku-4-5-20251001",
            };
          },
        };
        const result = await runEval({
          runDir,
          info,
          tools: {
            mcp: mcp.tools,
            "repo+mcp": combineToolSets(createRepoTools(sample.repo.dir, sample.sha), mcp.tools),
          },
          agents: provider,
          judge,
          batchJudge: false,
          maxUsd: 1,
        });
        const answers = result.records.flatMap((r) => (r.kind === "answer" ? [r] : []));
        expect(answers).toHaveLength(6);
        for (const a of answers) {
          expect(a.answer).toBe("Signal ingestion (page id: signals)");
          expect(a.calls).toEqual([
            { turn: 1, name: "read_page", input: { id: "signals" }, isError: false },
          ]);
        }
        expect(requests.map((r) => r.system)).toContain(agentSystemPrompt("mcp", "sample", 4));
        expect(requests.map((r) => r.system)).toContain(agentSystemPrompt("repo+mcp", "sample", 4));
        const summary = summarize(info, result.records);
        expect(summary.complete).toBe(true);
        expect(summary.pass).toBeNull();
        expect(summary.agents.mcp.answered).toBe(3);
        expect(summary.agents.wiki.answered).toBe(0);
      } finally {
        rmSync(runDir, { recursive: true, force: true });
      }
    },
    PROCESS_TIMEOUT_MS,
  );
});
