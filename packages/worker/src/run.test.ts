import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Facts, type JobStep, Suggestions } from "@repowiki/hosted";
import type { Provider } from "@repowiki/llm";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import type { FailCode, Succeeded, WorkerApi, WorkerSpec } from "./api.ts";
import type { CliRun } from "./engine.ts";
import { type PhaseDeps, phase1, phase2 } from "./run.ts";

const TOKEN = "t".repeat(43);
const SPEC: WorkerSpec = {
  jobId: "00000000-0000-4000-8000-000000000001",
  attempt: 1,
  kind: "generate",
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
};

function fakeApi(indexed: "ok" | "too-large" = "ok") {
  const calls: string[] = [];
  let succeeded: Succeeded | null = null;
  const api: WorkerApi = {
    lease: async () => {
      calls.push("lease");
      return SPEC;
    },
    heartbeat: async (step: JobStep) => {
      calls.push(`heartbeat:${step}`);
    },
    indexed: async (n: number) => {
      calls.push(`indexed:${n}`);
      return indexed;
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
  return { api, calls, succeeded: () => succeeded as Succeeded | null };
}

const provider: Provider = {
  generate: async () => {
    throw new Error("no model in tests");
  },
};

type Run = { script: string; args: readonly string[]; env: Record<string, string> };

function deps(
  api: WorkerApi,
  cli: (script: string) => CliRun,
): PhaseDeps & { runs: Run[]; lines: object[] } {
  const workDir = mkdtempSync(join(tmpdir(), "work-"));
  const runs: Run[] = [];
  const lines: object[] = [];
  return {
    runs,
    lines,
    api,
    token: TOKEN,
    workDir,
    engineVersion: "test",
    log: (line) => lines.push(line),
    heartbeatMs: 60_000,
    clone: async () => ({ ok: true }),
    indexRepo: async () => ({
      files: [
        { language: "python", loc: 10, skipped: null },
        { language: null, loc: 2, skipped: null },
        { language: null, loc: 0, skipped: "binary" },
      ],
    }),
    emails: () => [],
    provider: () => provider,
    runCli: async (input) => {
      runs.push(input);
      const run = cli(input.script);
      if (run.status === 0 && input.script.endsWith("wiki-build.ts")) {
        const out = String(input.args[input.args.indexOf("--out") + 1]);
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "export.json"), JSON.stringify(fixtureExport()));
      }
      return run;
    },
  };
}

const okRun = (): CliRun => ({ status: 0, stderrTail: "", timedOut: false, costCapped: false });

describe("phase 1 (spec 2 S9)", () => {
  it("leases, records the fetch step, clones into repo/<name>, and beats once more", async () => {
    const { api, calls } = fakeApi();
    const d = deps(api, okRun);
    const dirs: string[] = [];
    expect(
      await phase1({
        ...d,
        clone: async (input) => {
          dirs.push(input.dir);
          return { ok: true };
        },
      }),
    ).toBe(true);
    expect(calls).toEqual(["lease", "heartbeat:fetch", "heartbeat:fetch"]);
    expect(dirs).toEqual([join(d.workDir, "repo", "demo-repo")]);
  });

  it("keeps the lease with heartbeats while a long clone runs (A1)", async () => {
    const { api, calls } = fakeApi();
    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { ok: true as const };
    };
    expect(await phase1({ ...deps(api, okRun), heartbeatMs: 10, clone: slow })).toBe(true);
    expect(calls.filter((c) => c === "heartbeat:fetch").length).toBeGreaterThan(2);
  });

  it("fails the job with the clone's code", async () => {
    const { api, calls } = fakeApi();
    const d = {
      ...deps(api, okRun),
      clone: async () => ({ ok: false as const, code: "repo-too-large" as const, detail: "big" }),
    };
    expect(await phase1(d)).toBe(false);
    expect(calls).toEqual(["lease", "heartbeat:fetch", "fail:repo-too-large"]);
  });

  it("fails the job, not the process, when the clone throws", async () => {
    const { api, calls } = fakeApi();
    const d = {
      ...deps(api, okRun),
      clone: async (): Promise<never> => {
        throw new Error("boom");
      },
    };
    expect(await phase1(d)).toBe(false);
    expect(calls.at(-1)).toBe("fail:job-failed");
  });
});

describe("phase 2 (spec 2 S9, §8)", () => {
  it("indexes, runs the three CLIs through the proxy, and succeeds with valid facts", async () => {
    const { api, calls, succeeded } = fakeApi();
    const d = deps(api, okRun);
    expect(await phase2(d)).toBe(true);
    expect(calls).toEqual([
      "lease",
      "heartbeat:index",
      "indexed:2",
      "heartbeat:manifest",
      "heartbeat:write",
      "heartbeat:people",
      "heartbeat:facts",
      "heartbeat:render",
      "export",
      "succeed",
    ]);
    expect(d.runs.map((r) => r.script.split("/").at(-1))).toEqual([
      "manifest-build.ts",
      "wiki-build.ts",
      "wiki-people.ts",
    ]);
    const repo = join(d.workDir, "repo", "demo-repo");
    const out = join(d.workDir, "out");
    expect(d.runs[0]?.args).toEqual([repo, SPEC.commitSha, "--out", out]);
    expect(d.runs[1]?.args.slice(0, 4)).toEqual([repo, SPEC.commitSha, "--out", out]);
    expect(d.runs[2]?.args).toEqual([
      repo,
      "--out",
      out,
      "--people-file",
      join(d.workDir, "people.json"),
      "--no-narrative",
    ]);
    for (const run of d.runs) {
      expect(run.env.ANTHROPIC_BASE_URL).toBe(SPEC.llmUrl);
      expect(run.env.ANTHROPIC_API_KEY).toBe(TOKEN);
      expect(run.env.HOME).toBe(join(d.workDir, "home"));
      expect(run.args.join(" ")).not.toContain(TOKEN);
    }
    const body = succeeded();
    expect(Facts.safeParse(body?.facts).success).toBe(true);
    expect(body?.facts.indexedFiles).toBe(2);
    expect(Suggestions.safeParse(body?.suggestions).success).toBe(true);
    expect(body?.engineVersion).toBe("test");
    expect(body?.models).toEqual(["claude-haiku-4-5"]);
  });

  it("lists the suggestions call's model beside the CLIs' models (A3)", async () => {
    const { api, succeeded } = fakeApi();
    const answered: Provider = {
      generate: async <T>() => ({
        output: {
          tagline: "A tool",
          summary: "It does things.",
          contributionDraft: "",
          highlightCandidates: [],
        } as T,
        usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
        model: "claude-haiku-4-5-20251001",
      }),
    };
    expect(await phase2({ ...deps(api, okRun), provider: () => answered })).toBe(true);
    expect(succeeded()?.models).toEqual(["claude-haiku-4-5", "claude-haiku-4-5-20251001"]);
    expect(succeeded()?.suggestions.tagline).toBe("A tool");
  });

  it("stops without a model call or a second failure when the server finds the repository too large", async () => {
    const { api, calls } = fakeApi("too-large");
    const d = deps(api, okRun);
    expect(await phase2(d)).toBe(false);
    expect(calls).toEqual(["lease", "heartbeat:index", "indexed:2"]);
    expect(d.runs).toEqual([]);
  });

  it("fails with job-cost-cap when a CLI died on the proxy's cost refusal", async () => {
    const { api, calls } = fakeApi();
    const d = deps(api, (script) =>
      script.endsWith("wiki-build.ts")
        ? { status: 1, stderrTail: "no page could be written", timedOut: false, costCapped: true }
        : okRun(),
    );
    expect(await phase2(d)).toBe(false);
    expect(calls.at(-1)).toBe("fail:job-cost-cap");
    expect(calls).not.toContain("succeed");
  });

  it("fails with job-cost-cap when a CLI hit the cap but still exited 0 with pages missing", async () => {
    const { api, calls } = fakeApi();
    const d = deps(api, (script) =>
      script.endsWith("wiki-build.ts") ? { ...okRun(), costCapped: true } : okRun(),
    );
    expect(await phase2(d)).toBe(false);
    expect(calls.at(-1)).toBe("fail:job-cost-cap");
    expect(calls).not.toContain("export");
  });

  it("fails with job-failed for any other CLI failure or a timeout, and logs no token", async () => {
    const { api, calls } = fakeApi();
    const d = deps(api, () => ({
      status: null,
      stderrTail: `rejected key ${TOKEN}`,
      timedOut: true,
      costCapped: false,
    }));
    expect(await phase2(d)).toBe(false);
    expect(calls.at(-1)).toBe("fail:job-failed");
    expect(d.lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(d.lines)).not.toContain(TOKEN);
  });

  it("fails with job-failed when the engine's index throws", async () => {
    const { api, calls } = fakeApi();
    const d = {
      ...deps(api, okRun),
      indexRepo: async (): Promise<never> => {
        throw new Error("no such commit");
      },
    };
    expect(await phase2(d)).toBe(false);
    expect(calls).toEqual(["lease", "heartbeat:index", "fail:job-failed"]);
  });
});
