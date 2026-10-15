import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStep } from "@repowiki/hosted";
import { describe, expect, it } from "vitest";
import type { FailCode, Succeeded, WorkerApi, WorkerSpec } from "./api.ts";
import { type PhaseDeps, phase1 } from "./run.ts";

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

function deps(api: WorkerApi): PhaseDeps {
  return {
    api,
    token: TOKEN,
    workDir: mkdtempSync(join(tmpdir(), "work-")),
    engineVersion: "test",
    log: () => {},
    heartbeatMs: 60_000,
    clone: async () => ({ ok: true }),
  };
}

describe("phase 1 (spec 2 S9)", () => {
  it("leases, records the fetch step, clones into repo/<name>, and beats once more", async () => {
    const { api, calls } = fakeApi();
    const d = deps(api);
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
    expect(await phase1({ ...deps(api), heartbeatMs: 10, clone: slow })).toBe(true);
    expect(calls.filter((c) => c === "heartbeat:fetch").length).toBeGreaterThan(2);
  });

  it("fails the job with the clone's code", async () => {
    const { api, calls } = fakeApi();
    const d = {
      ...deps(api),
      clone: async () => ({ ok: false as const, code: "repo-too-large" as const, detail: "big" }),
    };
    expect(await phase1(d)).toBe(false);
    expect(calls).toEqual(["lease", "heartbeat:fetch", "fail:repo-too-large"]);
  });

  it("fails the job, not the process, when the clone throws", async () => {
    const { api, calls } = fakeApi();
    const d = {
      ...deps(api),
      clone: async (): Promise<never> => {
        throw new Error("boom");
      },
    };
    expect(await phase1(d)).toBe(false);
    expect(calls.at(-1)).toBe("fail:job-failed");
  });
});
