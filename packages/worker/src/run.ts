import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WikiExport } from "@repowiki/core";
import type { JobStep } from "@repowiki/hosted";
import { createClaudeProvider, createLedger, type Provider, resolveModels } from "@repowiki/llm";
import { ApiError, type FailCode, type WorkerApi, type WorkerSpec } from "./api.ts";
import { type CloneResult, cloneBare } from "./clone.ts";
import { CLI, type CliRun, engineEnv, ROOT, rebasedFetch, runCli } from "./engine.ts";
import { buildFacts, type FileFacts, indexedCount } from "./facts.ts";
import { indexInChild } from "./indexing.ts";
import { authorEmails, peopleFile } from "./people-file.ts";
import { suggest } from "./suggestions.ts";

/** One CLI may run this long; wiki-build's batches get an 80-minute deadline inside it. */
export const CLI_TIMEOUT_MS = 90 * 60_000;
/** A quarter of the server's 120-second lease. */
export const HEARTBEAT_MS = 30_000;

export interface PhaseDeps {
  api: WorkerApi;
  token: string;
  /** Holds `repo/<name>`, `out/`, `home/` and `people.json`; nothing is written in the clone. */
  workDir: string;
  engineVersion: string;
  log: (line: object) => void;
  heartbeatMs?: number;
  clone?: (input: Parameters<typeof cloneBare>[0]) => Promise<CloneResult>;
  runCli?: typeof runCli;
  /** Indexes in a child under time and heap limits (indexInChild). */
  indexRepo?: (repo: string, rev: string, home: string) => Promise<{ files: readonly FileFacts[] }>;
  emails?: (repo: string, shas: readonly string[]) => string[];
  provider?: (spec: WorkerSpec, token: string) => Provider;
}

class CliFailed extends Error {
  readonly code: FailCode;
  constructor(code: FailCode, message: string) {
    super(message);
    this.name = "CliFailed";
    this.code = code;
  }
}

/** Sends the current step at once on every change, and again every `everyMs` while it lasts. */
export function heartbeater(api: WorkerApi, everyMs: number, log: (line: object) => void) {
  let current: JobStep | null = null;
  const timer = setInterval(() => {
    if (current === null) return;
    api.heartbeat(current).catch((error: unknown) => log({ heartbeat: "failed", ...why(error) }));
  }, everyMs);
  timer.unref();
  return {
    async step(step: JobStep) {
      current = step;
      await api.heartbeat(step);
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/** What a log line may say about an error: its class and an API status, never its message. */
const why = (error: unknown) => ({
  error: error instanceof Error ? error.name : "unknown",
  ...(error instanceof ApiError ? { status: error.status } : {}),
});

const paths = (workDir: string, spec: WorkerSpec) => ({
  repo: join(workDir, "repo", spec.repo.name),
  out: join(workDir, "out"),
  home: join(workDir, "home"),
  people: join(workDir, "people.json"),
});

async function reportFailure(deps: PhaseDeps, code: FailCode): Promise<false> {
  await deps.api
    .fail(code)
    .catch((error: unknown) => deps.log({ fail: "unreported", ...why(error) }));
  return false;
}

/** Phase 1, with the network open (spec 2 S9): lease, then clone under heartbeats (A1). */
export async function phase1(deps: PhaseDeps): Promise<boolean> {
  const spec = await deps.api.lease();
  const where = paths(deps.workDir, spec);
  const beat = heartbeater(deps.api, deps.heartbeatMs ?? HEARTBEAT_MS, deps.log);
  try {
    await beat.step("fetch");
    mkdirSync(where.home, { recursive: true });
    const cloned = await (deps.clone ?? cloneBare)({
      url: spec.repo.cloneUrl,
      sha: spec.commitSha,
      dir: where.repo,
      sizeKb: spec.repo.sizeKb,
      home: where.home,
    });
    if (!cloned.ok) {
      deps.log({ phase: 1, failed: cloned.code, detail: cloned.detail });
      return reportFailure(deps, cloned.code);
    }
    await deps.api.heartbeat("fetch");
    return true;
  } catch (error) {
    deps.log({ phase: 1, failed: "job-failed", ...why(error) });
    return reportFailure(deps, "job-failed");
  } finally {
    beat.stop();
  }
}

function defaultProvider(spec: WorkerSpec, token: string): Provider {
  return createClaudeProvider({
    models: resolveModels(),
    ledger: createLedger(),
    runId: `hosted-${spec.jobId}-${spec.attempt}`,
    apiKey: token,
    fetch: rebasedFetch(spec.llmUrl),
  });
}

/** Phase 2, with the network locked to the server (spec 2 S9): the engine, facts and upload. */
export async function phase2(deps: PhaseDeps): Promise<boolean> {
  const spec = await deps.api.lease();
  const where = paths(deps.workDir, spec);
  const beat = heartbeater(deps.api, deps.heartbeatMs ?? HEARTBEAT_MS, deps.log);
  const env = engineEnv({ home: where.home, llmUrl: spec.llmUrl, token: deps.token });
  const hidden = (text: string) => text.split(deps.token).join("[token]");
  const cli = async (script: string, args: string[]) => {
    const run: CliRun = await (deps.runCli ?? runCli)({
      script: join(ROOT, script),
      args,
      env,
      timeoutMs: CLI_TIMEOUT_MS,
    });
    if (run.status === 0 && !run.costCapped) return;
    deps.log({
      cli: script,
      status: run.status,
      timedOut: run.timedOut,
      costCapped: run.costCapped,
      stderr: hidden(run.stderrTail.slice(-1000)),
    });
    throw new CliFailed(run.costCapped ? "job-cost-cap" : "job-failed", `${script} failed`);
  };
  try {
    mkdirSync(where.home, { recursive: true });
    await beat.step("index");
    const index = await (
      deps.indexRepo ?? ((repo, sha, home) => indexInChild({ repo, sha, home }))
    )(where.repo, spec.commitSha, where.home);
    if ((await deps.api.indexed(indexedCount(index.files))) === "too-large") return false;
    await beat.step("manifest");
    await cli(CLI.manifest, [where.repo, spec.commitSha, "--out", where.out]);
    await beat.step("write");
    await cli(CLI.wiki, [where.repo, spec.commitSha, "--out", where.out, "--deadline", "80"]);
    await beat.step("people");
    const emails = (deps.emails ?? authorEmails)(where.repo, spec.author.commitShas);
    writeFileSync(where.people, JSON.stringify(peopleFile(spec.author.login, emails)));
    await cli(CLI.people, [
      where.repo,
      "--out",
      where.out,
      "--people-file",
      where.people,
      "--no-narrative",
    ]);
    await beat.step("facts");
    const bytes = readFileSync(join(where.out, "export.json"));
    const exp = WikiExport.parse(JSON.parse(bytes.toString("utf8")));
    const facts = buildFacts(index.files, exp);
    const provider = (deps.provider ?? defaultProvider)(spec, deps.token);
    const { suggestions, model } = await suggest(provider, exp, facts, spec.author.login);
    await beat.step("render");
    await deps.api.putExport(bytes);
    // The CLIs run with no config file, so their models are resolveModels()'s (A3).
    const models = [
      ...new Set([...Object.values(resolveModels()), ...(model === null ? [] : [model])]),
    ].slice(0, 8);
    await deps.api.succeed({ suggestions, facts, engineVersion: deps.engineVersion, models });
    return true;
  } catch (error) {
    const code = error instanceof CliFailed ? error.code : "job-failed";
    deps.log({ phase: 2, failed: code, ...why(error) });
    return reportFailure(deps, code);
  } finally {
    beat.stop();
  }
}
