import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePeopleSnapshot, makePersonFacts } from "@repowiki/core/test-fixtures";
import { Facts, type JobStep, Suggestions } from "@repowiki/hosted";
import type { Provider } from "@repowiki/llm";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { ApiError, type FailCode, type Succeeded, type WorkerApi, WorkerSpec } from "./api.ts";
import type { CliRun } from "./engine.ts";
import { AUTHOR_ID } from "./people-file.ts";
import {
  CLI_TIMEOUT_MS,
  heartbeater,
  type PhaseDeps,
  phase1,
  phase2,
  WIKI_BATCH_ROUNDS,
  WIKI_DEADLINE_MINUTES,
} from "./run.ts";

const TOKEN = "Abc_-".repeat(8).concat("xyz");
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

function fakeApi(indexed: "ok" | "too-large" = "ok", lease: () => WorkerSpec = () => SPEC) {
  const calls: string[] = [];
  let succeeded: Succeeded | null = null;
  const api: WorkerApi = {
    lease: async () => {
      calls.push("lease");
      return lease();
    },
    heartbeat: async (step: JobStep) => {
      calls.push(`heartbeat:${step}`);
    },
    indexed: async (n: number) => {
      calls.push(`indexed:${n}`);
      return indexed;
    },
    sourceExport: async () => {
      throw new Error("a build reads no source export");
    },
    putExport: async () => {
      calls.push("export");
    },
    succeed: async (body) => {
      calls.push("succeed");
      succeeded = body as Succeeded;
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

/** The fixture export with a page for every active feature (it lacks the scheduler's). */
function completeExport() {
  const exp = fixtureExport();
  const page = exp.pages[0];
  if (page === undefined) throw new Error("the fixture has no page");
  const scheduler = {
    ...page,
    id: "scheduler-page-1",
    featureId: "scheduler",
    parentId: null,
    reason: "build" as const,
  };
  return {
    ...exp,
    pages: [...exp.pages, scheduler],
    history: { ...exp.history, scheduler: [scheduler] },
  };
}

function deps(
  api: WorkerApi,
  cli: (script: string) => CliRun,
  built: () => ReturnType<typeof fixtureExport> = completeExport,
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
    countTree: async () => 3,
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
      const out = String(input.args[input.args.indexOf("--out") + 1]);
      if (run.status === 0 && input.script.endsWith("wiki-build.ts")) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "export.json"), JSON.stringify(built()));
      }
      // wiki-people rewrites the export with the People snapshot, the author under AUTHOR_ID.
      if (run.status === 0 && input.script.endsWith("wiki-people.ts")) {
        writeFileSync(join(out, "export.json"), JSON.stringify(withPeople(built())));
      }
      return run;
    },
  };
}

/** The export with a People snapshot: the author, a teammate, and the fixture's features. */
function withPeople(exp: ReturnType<typeof fixtureExport>) {
  const snapshot = makePeopleSnapshot({
    commits: 9,
    totalLines: 240,
    unattributedLines: 0,
    people: [
      makePersonFacts({
        id: AUTHOR_ID,
        name: "Demo Dev",
        commits: 5,
        currentLines: 70,
        features: [
          { featureId: "signals", commits: 4, currentLines: 60 },
          { featureId: "deliverables", commits: 1, currentLines: 10 },
        ],
      }),
      makePersonFacts({ id: "grace-hopper", name: "Grace Hopper", commits: 4, currentLines: 170 }),
    ],
    redirects: [],
  });
  return { ...exp, people: { snapshot, pages: [] } };
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

/** Resolves after `ms`, or as soon as `signal` aborts. */
const waitOrAbort = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

describe("the heartbeater", () => {
  it("never sends a heartbeat while one is still in flight", async () => {
    let open = 0;
    let most = 0;
    let sent = 0;
    const api = {
      ...fakeApi().api,
      heartbeat: async () => {
        open++;
        sent++;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 40));
        open--;
      },
    };
    const beat = heartbeater(api, 5, () => {});
    await beat.step("write");
    await new Promise((resolve) => setTimeout(resolve, 200));
    beat.stop();
    expect(sent).toBeGreaterThan(2);
    expect(most).toBe(1);
  });
});

describe("a lost lease (401 or 409 on a heartbeat)", () => {
  const losing = (status: number) => {
    const fake = fakeApi();
    let beats = 0;
    fake.api.heartbeat = async (step: JobStep) => {
      fake.calls.push(`heartbeat:${step}`);
      if (++beats > 3) throw new ApiError(status, `heartbeat: HTTP ${status}`);
    };
    return fake;
  };

  it("stops phase 2's running CLI and ends the phase without a fail call", async () => {
    const { api, calls } = losing(409);
    const signals: (AbortSignal | undefined)[] = [];
    const d = deps(api, okRun);
    const run = d.runCli;
    const lost = await phase2({
      ...d,
      heartbeatMs: 10,
      runCli: async (input) => {
        signals.push(input.signal);
        if (input.script.endsWith("wiki-build.ts")) await waitOrAbort(10_000, input.signal);
        return run?.(input) ?? okRun();
      },
    });
    expect(lost).toBe(false);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(true);
    expect(calls.filter((c) => c.startsWith("fail") || c === "succeed")).toEqual([]);
  });

  it("stops phase 1's running clone and ends the phase without a fail call", async () => {
    const { api, calls } = losing(401);
    const lost = await phase1({
      ...deps(api, okRun),
      heartbeatMs: 10,
      clone: async (input) => {
        await waitOrAbort(10_000, input.signal);
        return input.signal?.aborted
          ? { ok: false as const, code: "job-failed" as const, detail: "clone stopped" }
          : { ok: true as const };
      },
    });
    expect(lost).toBe(false);
    expect(calls.filter((c) => c.startsWith("fail"))).toEqual([]);
  });
});

describe("phase 2 (spec 2 S9, §8)", () => {
  it("keeps the lease with interval heartbeats while a long CLI runs", async () => {
    const { api, calls } = fakeApi();
    const d = deps(api, okRun);
    const run = d.runCli;
    const slow: typeof d.runCli = async (input) => {
      if (input.script.endsWith("wiki-build.ts")) await new Promise((r) => setTimeout(r, 120));
      return run?.(input) ?? okRun();
    };
    expect(await phase2({ ...d, heartbeatMs: 10, runCli: slow })).toBe(true);
    expect(calls.filter((c) => c === "heartbeat:write").length).toBeGreaterThan(3);
  });

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
    expect(d.runs[1]?.args).toEqual([
      repo,
      SPEC.commitSha,
      "--out",
      out,
      "--deadline",
      String(WIKI_DEADLINE_MINUTES),
    ]);
    // Every batch round's deadline fits in the CLI's time limit, with time over for the rest.
    expect(WIKI_DEADLINE_MINUTES * WIKI_BATCH_ROUNDS * 60_000).toBeLessThan(CLI_TIMEOUT_MS);
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
      // The token reaches a CLI as its API key only: never in its argv or another variable.
      const { ANTHROPIC_API_KEY: _key, ...rest } = run.env;
      expect(JSON.stringify([run.script, run.args, rest])).not.toContain(TOKEN.slice(0, 12));
    }
    expect(readFileSync(join(d.workDir, "people.json"), "utf8")).not.toContain(TOKEN.slice(0, 12));
    const body = succeeded();
    expect(Facts.safeParse(body?.facts).success).toBe(true);
    expect(body?.facts.indexedFiles).toBe(2);
    expect(body?.facts.author).toEqual({
      commits: 5,
      totalCommits: 9,
      currentLines: 70,
      totalLines: 240,
      features: [
        { featureId: "signals", commits: 4, currentLines: 60 },
        { featureId: "deliverables", commits: 1, currentLines: 10 },
      ],
    });
    expect(Suggestions.safeParse(body?.suggestions).success).toBe(true);
    expect(body?.engineVersion).toBe("test");
    expect(body?.models).toEqual(["claude-haiku-5-5"]);
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
    expect(succeeded()?.models).toEqual(["claude-haiku-5-5", "claude-haiku-4-5-20251001"]);
    expect(succeeded()?.suggestions.tagline).toBe("A tool");
  });

  it("stores the index child's technologies and logs the manifests it could not read (ADR-0014)", async () => {
    const { api, succeeded } = fakeApi();
    const react = { id: "react", evidence: { path: "package.json" }, importingFiles: 4 };
    const d = deps(api, okRun);
    const indexRepo = async () => ({
      files: [{ language: "typescript", loc: 10, skipped: null }],
      technologies: [react],
      unparsed: ["Cargo.toml"],
      tooLarge: ["big/package.json"],
    });
    expect(await phase2({ ...d, indexRepo })).toBe(true);
    expect(succeeded()?.facts.technologies).toEqual([react]);
    expect(d.lines).toContainEqual({
      phase: 2,
      technologies: "unread",
      unparsed: ["Cargo.toml"],
      tooLarge: ["big/package.json"],
    });
  });

  it("stops without a model call or a second failure when the server finds the repository too large", async () => {
    const { api, calls } = fakeApi("too-large");
    const d = deps(api, okRun);
    expect(await phase2(d)).toBe(false);
    expect(calls).toEqual(["lease", "heartbeat:index", "indexed:2"]);
    expect(d.runs).toEqual([]);
  });

  it("refuses a tree listing over three times the file limit before indexing it", async () => {
    const { api, calls } = fakeApi("too-large");
    const indexed: string[] = [];
    const d = {
      ...deps(api, okRun),
      countTree: async () => SPEC.limits.maxIndexedFiles * 3 + 1,
      indexRepo: async (repo: string) => {
        indexed.push(repo);
        return { files: [] };
      },
    };
    expect(await phase2(d)).toBe(false);
    expect(calls).toEqual(["lease", "heartbeat:index", "indexed:3001"]);
    expect(indexed).toEqual([]);
    expect(d.runs).toEqual([]);
  });

  it("indexes a tree listing at three times the limit, and fails one git cannot list", async () => {
    const homes: string[] = [];
    const ok = fakeApi();
    const d = {
      ...deps(ok.api, okRun),
      countTree: async (_repo: string, _sha: string, home: string) => {
        homes.push(home);
        return SPEC.limits.maxIndexedFiles * 3;
      },
      indexRepo: async (_repo: string, _sha: string, home: string) => {
        homes.push(home);
        return { files: [{ language: "python", loc: 10, skipped: null }] };
      },
      emails: (_repo: string, _shas: readonly string[], home: string) => {
        homes.push(home);
        return [];
      },
    };
    expect(await phase2(d)).toBe(true);
    expect(ok.calls).toContain("indexed:1");
    expect(homes).toEqual(Array.from({ length: 3 }, () => join(d.workDir, "home")));
    const broken = fakeApi();
    expect(await phase2({ ...deps(broken.api, okRun), countTree: async () => null })).toBe(false);
    expect(broken.calls).toEqual(["lease", "heartbeat:index", "fail:job-failed"]);
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
    const d = deps(
      api,
      (script) => (script.endsWith("wiki-build.ts") ? { ...okRun(), costCapped: true } : okRun()),
      fixtureExport,
    );
    expect(await phase2(d)).toBe(false);
    expect(calls.at(-1)).toBe("fail:job-cost-cap");
    expect(calls).not.toContain("export");
  });

  it("succeeds when a CLI showed the cost-cap mark but every page and the About article came", async () => {
    const { api, calls } = fakeApi();
    const d = deps(api, (script) =>
      script.endsWith("wiki-build.ts") ? { ...okRun(), costCapped: true } : okRun(),
    );
    expect(await phase2(d)).toBe(true);
    expect(calls.at(-1)).toBe("succeed");
  });

  it("fails with job-failed when an active feature has no page, or there is no About article", async () => {
    for (const built of [fixtureExport, () => ({ ...completeExport(), architecture: [] })]) {
      const { api, calls } = fakeApi();
      expect(await phase2(deps(api, okRun, built))).toBe(false);
      expect(calls.at(-1)).toBe("fail:job-failed");
      expect(calls).not.toContain("export");
    }
  });

  it("fails with job-failed for any other CLI failure or a timeout, and logs no token", async () => {
    // One tail holds the token whole where the log's 1000-character cut falls; another begins
    // with the token's end, where the runner's 4 KB cut fell.
    for (const stderrTail of [
      `rejected key ${TOKEN}${"x".repeat(990)}`,
      `${TOKEN.slice(15)} was rejected`,
    ]) {
      const { api, calls } = fakeApi();
      const d = deps(api, () => ({ status: null, stderrTail, timedOut: true, costCapped: false }));
      expect(await phase2(d)).toBe(false);
      expect(calls.at(-1)).toBe("fail:job-failed");
      expect(d.lines.length).toBeGreaterThan(0);
      const logged = JSON.stringify(d.lines);
      for (let i = 0; i + 8 <= TOKEN.length; i++)
        expect(logged).not.toContain(TOKEN.slice(i, i + 8));
    }
  });

  it("fails the job when the lease is refused or its spec is bad, but not when the token is", async () => {
    for (const phase of [phase1, phase2]) {
      const broken = fakeApi("ok", () => {
        throw new ApiError(503, "lease: HTTP 503");
      });
      expect(await phase(deps(broken.api, okRun))).toBe(false);
      expect(broken.calls).toEqual(["lease", "fail:job-failed"]);
      const bad = fakeApi("ok", () => WorkerSpec.parse({ ...SPEC, commitSha: "nope" }));
      expect(await phase(deps(bad.api, okRun))).toBe(false);
      expect(bad.calls).toEqual(["lease", "fail:job-failed"]);
      const refused = fakeApi("ok", () => {
        throw new ApiError(401, "lease: HTTP 401");
      });
      expect(await phase(deps(refused.api, okRun))).toBe(false);
      expect(refused.calls).toEqual(["lease"]);
    }
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
