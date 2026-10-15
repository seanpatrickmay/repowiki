import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WikiExport } from "@repowiki/core";
import type { JobStep } from "@repowiki/hosted";
import { createClaudeProvider, createLedger, type Provider, resolveModels } from "@repowiki/llm";
import { ApiError, type FailCode, leaseGone, type WorkerApi, type WorkerSpec } from "./api.ts";
import { type CloneResult, cloneBare } from "./clone.ts";
import { CLI, type CliRun, engineEnv, ROOT, rebasedFetch, runCli } from "./engine.ts";
import { buildFacts, type FileFacts, indexedCount } from "./facts.ts";
import { countTree, indexInChild, TREE_FACTOR } from "./indexing.ts";
import { authorEmails, peopleFile } from "./people-file.ts";
import { suggest } from "./suggestions.ts";

/** One CLI may run this long. */
export const CLI_TIMEOUT_MS = 90 * 60_000;
/**
 * wiki-build's `--deadline`, which cancels each Message Batch still running after that many
 * minutes (scripts/wiki-cli.ts): per batch, not per run. A build waits on at most four batches in
 * turn (the pages, their retry, the About article, its retry), so four deadlines, 80 minutes,
 * fit inside CLI_TIMEOUT_MS with 10 minutes left for packing, verifying, linking and the export.
 */
export const WIKI_DEADLINE_MINUTES = 20;
export const WIKI_BATCH_ROUNDS = 4;
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
  /** Counts the tree's blobs before indexing (countTree); null when git failed. */
  countTree?: (repo: string, sha: string, home: string) => Promise<number | null>;
  /** Indexes in a child under time and heap limits (indexInChild). */
  indexRepo?: (
    repo: string,
    rev: string,
    home: string,
    signal?: AbortSignal,
  ) => Promise<{ files: readonly FileFacts[] }>;
  emails?: (repo: string, shas: readonly string[], home: string) => string[];
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

/**
 * Sends the current step at once on every change, and again every `everyMs` while it lasts, one
 * at a time (a slow heartbeat skips the next tick). A 401 or 409 on an interval heartbeat means
 * the lease is gone: the beats stop and `onLost` runs once, to stop the work in hand.
 */
export function heartbeater(
  api: WorkerApi,
  everyMs: number,
  log: (line: object) => void,
  onLost: () => void = () => {},
) {
  let current: JobStep | null = null;
  /** The heartbeat in flight, settled or not; null when none is. */
  let inFlight: Promise<unknown> | null = null;
  const send = (step: JobStep) => {
    const sent = api.heartbeat(step).finally(() => {
      if (inFlight === sent) inFlight = null;
    });
    inFlight = sent;
    return sent;
  };
  const timer = setInterval(() => {
    if (current === null || inFlight !== null) return;
    send(current).catch((error: unknown) => {
      log({ heartbeat: "failed", ...why(error) });
      if (!leaseGone(error)) return;
      clearInterval(timer);
      onLost();
    });
  }, everyMs);
  timer.unref();
  return {
    async step(step: JobStep) {
      current = step;
      await inFlight?.catch(() => {});
      await send(step);
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/** The lease was lost while work ran: the phase ends with no fail call (the server has moved on). */
class LeaseLost extends Error {
  constructor() {
    super("the lease was lost");
    this.name = "LeaseLost";
  }
}

/**
 * `text` with every whole `token` replaced, and a start that is the token's end (8 characters or
 * more, where a cut fell inside it) replaced too.
 */
export function redact(text: string, token: string): string {
  let out = text.split(token).join("[token]");
  for (let n = token.length - 1; n >= 8; n--) {
    if (out.startsWith(token.slice(-n))) {
      out = `[token]${out.slice(n)}`;
      break;
    }
  }
  return out;
}

/**
 * The lease (spec 2 §6); null after reporting a refusal or a bad spec as job-failed, unless the
 * token itself was refused.
 */
async function leased(deps: PhaseDeps, phase: 1 | 2): Promise<WorkerSpec | null> {
  try {
    return await deps.api.lease();
  } catch (error) {
    deps.log({ phase, failed: "lease", ...why(error) });
    if (!leaseGone(error)) await reportFailure(deps, "job-failed");
    return null;
  }
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
  const spec = await leased(deps, 1);
  if (spec === null) return false;
  const where = paths(deps.workDir, spec);
  const lost = new AbortController();
  const beat = heartbeater(deps.api, deps.heartbeatMs ?? HEARTBEAT_MS, deps.log, () =>
    lost.abort(),
  );
  try {
    await beat.step("fetch");
    mkdirSync(where.home, { recursive: true });
    const cloned = await (deps.clone ?? cloneBare)({
      url: spec.repo.cloneUrl,
      sha: spec.commitSha,
      dir: where.repo,
      sizeKb: spec.repo.sizeKb,
      home: where.home,
      signal: lost.signal,
    });
    if (lost.signal.aborted) throw new LeaseLost();
    if (!cloned.ok) {
      deps.log({ phase: 1, failed: cloned.code, detail: cloned.detail });
      return reportFailure(deps, cloned.code);
    }
    await deps.api.heartbeat("fetch");
    return true;
  } catch (error) {
    deps.log({ phase: 1, failed: "job-failed", ...why(error) });
    if (leaseGone(error) || lost.signal.aborted) return false;
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

/** Whether the export holds a page for every active feature and an About article. */
function complete(exp: WikiExport): boolean {
  const paged = new Set(exp.pages.map((p) => p.featureId));
  const active = exp.manifest.features.filter((f) => f.status.kind === "active");
  return exp.architecture.length > 0 && active.every((f) => paged.has(f.id));
}

/** Phase 2, with the network locked to the server (spec 2 S9): the engine, facts and upload. */
export async function phase2(deps: PhaseDeps): Promise<boolean> {
  const spec = await leased(deps, 2);
  if (spec === null) return false;
  const where = paths(deps.workDir, spec);
  const lost = new AbortController();
  const beat = heartbeater(deps.api, deps.heartbeatMs ?? HEARTBEAT_MS, deps.log, () =>
    lost.abort(),
  );
  const env = engineEnv({ home: where.home, llmUrl: spec.llmUrl, token: deps.token });
  // Whether a CLI that exited 0 showed the cost refusal: trusted only if the wiki is incomplete.
  let capped = false;
  const cli = async (script: string, args: string[]) => {
    const run: CliRun = await (deps.runCli ?? runCli)({
      script: join(ROOT, script),
      args,
      env,
      timeoutMs: CLI_TIMEOUT_MS,
      signal: lost.signal,
    });
    if (lost.signal.aborted) throw new LeaseLost();
    capped ||= run.costCapped;
    if (run.status === 0) return;
    deps.log({
      cli: script,
      status: run.status,
      timedOut: run.timedOut,
      costCapped: run.costCapped,
      // Redacted before the cut, so the cut never leaves part of the token behind.
      stderr: redact(run.stderrTail, deps.token).slice(-1000),
    });
    throw new CliFailed(run.costCapped ? "job-cost-cap" : "job-failed", `${script} failed`);
  };
  try {
    mkdirSync(where.home, { recursive: true });
    await beat.step("index");
    // A tree far past the file limit is refused on its listing, before the index reads it.
    const listed = await (deps.countTree ?? countTree)(where.repo, spec.commitSha, where.home);
    if (listed === null) throw new Error("the tree could not be listed");
    if (listed > spec.limits.maxIndexedFiles * TREE_FACTOR) {
      if ((await deps.api.indexed(listed)) === "too-large") return false;
      throw new Error("the server took a count over the file limit");
    }
    const index = await (
      deps.indexRepo ?? ((repo, sha, home, signal) => indexInChild({ repo, sha, home, signal }))
    )(where.repo, spec.commitSha, where.home, lost.signal);
    if (lost.signal.aborted) throw new LeaseLost();
    if ((await deps.api.indexed(indexedCount(index.files))) === "too-large") return false;
    await beat.step("manifest");
    await cli(CLI.manifest, [where.repo, spec.commitSha, "--out", where.out]);
    await beat.step("write");
    await cli(CLI.wiki, [
      where.repo,
      spec.commitSha,
      "--out",
      where.out,
      "--deadline",
      `${WIKI_DEADLINE_MINUTES}`,
    ]);
    await beat.step("people");
    const emails = (deps.emails ?? authorEmails)(where.repo, spec.author.commitShas, where.home);
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
    if (!complete(exp)) {
      deps.log({ phase: 2, incomplete: true, costCapped: capped });
      throw new CliFailed(capped ? "job-cost-cap" : "job-failed", "the wiki is incomplete");
    }
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
    if (leaseGone(error) || lost.signal.aborted) return false;
    return reportFailure(deps, code);
  } finally {
    beat.stop();
  }
}
