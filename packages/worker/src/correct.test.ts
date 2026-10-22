import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CORRECTIONS, MAX_NOTE_LENGTH } from "@repowiki/engine";
import { CORRECTION, type JobStep } from "@repowiki/hosted";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import type { Corrected, FailCode, Succeeded, WorkerApi, WorkerSpec } from "./api.ts";
import type { CliRun } from "./engine.ts";
import { type PhaseDeps, phase2 } from "./run.ts";

const TOKEN = "Abc_-".repeat(8).concat("xyz");
const NOTE = "a note only the model may read";
const ITEMS = [{ page: "signals", claimId: "c1", note: NOTE }];
const SPEC: WorkerSpec = {
  jobId: "00000000-0000-4000-8000-000000000001",
  attempt: 1,
  kind: "correct",
  commitSha: "a".repeat(40),
  repo: {
    fullName: "demo-dev/demo-repo",
    name: "demo-repo",
    cloneUrl: "https://github.com/demo-dev/demo-repo.git",
    sizeKb: 120,
  },
  author: { login: "demo-dev", githubUserId: 4242, commitShas: [] },
  limits: { maxIndexedFiles: 1000 },
  llmUrl: "http://repowiki.internal:8787/llm",
  correction: { items: ITEMS },
};

function fakeApi() {
  const calls: string[] = [];
  let succeeded: Succeeded | Corrected | null = null;
  const api: WorkerApi = {
    lease: async () => {
      calls.push("lease");
      return SPEC;
    },
    heartbeat: async (step: JobStep) => {
      calls.push(`heartbeat:${step}`);
    },
    indexed: async () => {
      calls.push("indexed");
      return "ok";
    },
    sourceExport: async () => {
      calls.push("source");
      return new TextEncoder().encode(JSON.stringify(fixtureExport()));
    },
    putExport: async () => {
      calls.push("export");
    },
    succeed: async (body) => {
      calls.push("succeed");
      succeeded = body;
    },
    fail: async (code: FailCode) => {
      calls.push(`fail:${code}`);
    },
  };
  return { api, calls, succeeded: () => succeeded };
}

type Seen = { script: string; args: readonly string[]; requests: unknown; source: unknown };

/** Phase 2 with a fake wiki:correct that answers `outcomes` (or fails with `status`). */
function deps(api: WorkerApi, outcomes: string[], status = 0) {
  const seen: Seen[] = [];
  const lines: object[] = [];
  const phase: PhaseDeps = {
    api,
    token: TOKEN,
    workDir: mkdtempSync(join(tmpdir(), "work-")),
    engineVersion: "test",
    log: (line) => lines.push(line),
    heartbeatMs: 60_000,
    runCli: async (input): Promise<CliRun> => {
      const arg = (flag: string) => String(input.args[input.args.indexOf(flag) + 1]);
      seen.push({
        script: input.script,
        args: input.args,
        requests: JSON.parse(readFileSync(arg("--requests"), "utf8")),
        source: JSON.parse(readFileSync(arg("--export"), "utf8")),
      });
      if (status === 0) writeFileSync(arg("--out"), JSON.stringify(fixtureExport()));
      const answer = outcomes.map((outcome) => ({
        page: "signals",
        claimId: "c1",
        outcome,
        detail: null,
      }));
      return {
        status,
        stdout: status === 0 ? JSON.stringify({ outcomes: answer }) : null,
        stderrTail: status === 0 ? "" : "wiki:correct failed",
        timedOut: false,
        costCapped: false,
      };
    },
  };
  return { phase, seen, lines };
}

describe("phase 2 of a correction job (ADR-0023)", () => {
  it("runs only wiki:correct on the export it corrects, then uploads and succeeds with outcomes", async () => {
    const { api, calls, succeeded } = fakeApi();
    const { phase, seen } = deps(api, ["rewritten"]);
    expect(await phase2(phase)).toBe(true);
    expect(seen.map((s) => s.script.split("/").at(-1))).toEqual(["wiki-correct.ts"]);
    expect(seen[0]?.requests).toEqual(ITEMS);
    expect(seen[0]?.source).toEqual(JSON.parse(JSON.stringify(fixtureExport())));
    expect(calls).toEqual([
      "lease",
      "heartbeat:write",
      "source",
      "heartbeat:render",
      "export",
      "succeed",
    ]);
    expect(succeeded()).toMatchObject({
      engineVersion: "test",
      outcomes: [{ page: "signals", claimId: "c1", outcome: "rewritten", detail: null }],
    });
    // The notes are on disk only while the command runs.
    const requests = String(seen[0]?.args[seen[0].args.indexOf("--requests") + 1]);
    expect(existsSync(requests)).toBe(false);
  });

  it("fails as unchanged when every sentence was refused, uploading nothing", async () => {
    const { api, calls } = fakeApi();
    expect(await phase2(deps(api, ["refused"]).phase)).toBe(false);
    expect(calls).not.toContain("export");
    expect(calls.at(-1)).toBe("fail:correction-unchanged");
  });

  it("fails the job when the command fails, and never logs a note", async () => {
    const { api, calls } = fakeApi();
    const { phase, lines } = deps(api, [], 1);
    expect(await phase2(phase)).toBe(false);
    expect(calls.at(-1)).toBe("fail:job-failed");
    expect(JSON.stringify(lines)).not.toContain(NOTE);
  });

  it("holds the hosted limits to the engine's", () => {
    expect(CORRECTION).toEqual({ items: MAX_CORRECTIONS, noteLength: MAX_NOTE_LENGTH });
  });
});
