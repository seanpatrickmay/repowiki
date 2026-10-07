import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type GitHubSnapshot, WikiExport } from "@repowiki/core";
import {
  INGEST_PY,
  makeGitHubIssue,
  makeGitHubPull,
  makeGitHubSnapshot,
} from "@repowiki/core/test-fixtures";
import { type GitHubSource, INFLIGHT_DIR, scrubbedGitEnv } from "@repowiki/engine";
import { type InflightFixture, inflightFixture } from "@repowiki/engine/test-inflight";
import { DEFAULT_MODELS, type GenerateRequest, type Provider } from "@repowiki/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInflightArgs } from "./inflight-cli.ts";
import {
  clearInFlightData,
  type RefreshContext,
  type RefreshSources,
  refreshOffline,
  refreshOnline,
} from "./inflight-run.ts";

// Each test builds a fixture wiki, a remote and inflight.git: seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let fx: InflightFixture;
let snapshot: GitHubSnapshot;
let logged: string[];
beforeEach(async () => {
  fx = await inflightFixture();
  logged = [];
  const ingest = INGEST_PY.replace("    signals = []", "    signals = list()");
  const one = fx.pushPull(1, fx.first, { "src/signals/ingest.py": ingest });
  const two = fx.pushPull(2, fx.first, { "src/deliverables/crud.py": "x = 1\n" });
  snapshot = makeGitHubSnapshot({
    pulls: [
      makeGitHubPull({ number: 1, headRefOid: one, closes: [7] }),
      makeGitHubPull({
        number: 2,
        headRefOid: two,
        closes: [],
        files: ["src/deliverables/crud.py"],
        updatedAt: "2026-10-02T09:00:00Z",
      }),
    ],
    issues: [makeGitHubIssue()],
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  fx.remove();
});

const context = (...flags: string[]): RefreshContext => ({
  repo: fx.repo.dir,
  out: fx.out,
  repoName: "demo",
  store: fx.store,
  args: parseInflightArgs([
    fx.repo.dir,
    // --offline and --clear read no GitHub, so they take no --github.
    ...(flags.includes("--offline") || flags.includes("--clear") ? [] : ["--github", "acme/demo"]),
    ...flags,
  ]),
  models: DEFAULT_MODELS,
  log: (line) => logged.push(line),
  now: () => new Date("2026-10-04T12:00:00Z"),
});
const github = (answer: ReturnType<GitHubSource["read"]> = { snapshot }): GitHubSource => ({
  read: () => answer,
});

/** A provider that answers every summary call with one claim on ingest.py's changed line. */
function scripted() {
  const calls: GenerateRequest<unknown>[] = [];
  const provider: Provider = {
    async generate<T>(req: GenerateRequest<T>) {
      calls.push(req as GenerateRequest<unknown>);
      const user = String(req.messages[0]?.content);
      const output = user.includes("#1 ")
        ? {
            claims: [
              {
                text: "It builds a `list()`.",
                cite: ["src/signals/ingest.py:12-12"],
                features: ["signals"],
              },
            ],
          }
        : {
            claims: [
              {
                text: "It rewrites crud.py.",
                cite: ["src/deliverables/crud.py:1-1"],
                features: [],
              },
            ],
          };
      return {
        output: output as T,
        usage: { in: 4000, out: 200, cacheRead: 0, cacheWrite: 0 },
        model: "claude-haiku-4-5-20251001",
      };
    },
  };
  return { provider, calls };
}
const sources = (provider?: Provider, source = github()): RefreshSources => ({
  github: source,
  fetch: { url: fx.url, options: { protocol: "file" } },
  ...(provider === undefined ? {} : { provider }),
});
const exported = () =>
  WikiExport.parse(JSON.parse(readFileSync(join(fx.out, "export.json"), "utf8")));

describe("refreshOnline (spec v2 #9 §4.1)", () => {
  it("reads, fetches, derives, asks once, stores and exports; a second run asks nothing", async () => {
    const first = scripted();
    const done = await refreshOnline(context(), sources(first.provider));
    expect(done.kind).toBe("done");
    if (done.kind !== "done") return;
    expect(first.calls).toHaveLength(2);
    expect([...done.status]).toEqual([
      [1, "new"],
      [2, "new"],
    ]);
    expect(logged.slice(0, 3)).toEqual([
      "acme/demo: 2 open pull requests, 1 open issue",
      "pull-request heads: 2 fetched, 0 missing, 0 moved since GitHub was read",
      expect.stringMatching(/^2 pull-request summaries \(0 cached, 2 to request\): about \$/),
    ]);
    expect(fx.store.getGitHubSnapshot()).toEqual(snapshot);
    expect(fx.store.getInFlight()).toEqual(done.inflight);
    expect(exported().inflight).toEqual(done.inflight);
    expect(done.inflight.pulls[0]?.effects.map((e) => e.claimId)).toEqual(["c1", "c2"]);

    const second = scripted();
    const again = await refreshOnline(context(), sources(second.provider));
    expect(second.calls).toHaveLength(0);
    expect(again.kind === "done" && [...again.status.values()]).toEqual(["cached", "cached"]);
  });

  it("asks nothing with --no-llm, and stops after the estimate with --dry-run, storing nothing", async () => {
    const p = scripted();
    const dry = await refreshOnline(context("--dry-run"), sources(p.provider));
    expect(dry).toEqual({ kind: "dry-run" });
    expect([fx.store.getGitHubSnapshot(), fx.store.getInFlight()]).toEqual([null, null]);
    expect(existsSync(join(fx.out, "export.json"))).toBe(false);
    const keyless = await refreshOnline(context("--no-llm"), sources(p.provider));
    expect(keyless.kind === "done" && [...keyless.status.values()]).toEqual([
      "not asked",
      "not asked",
    ]);
    expect(p.calls).toHaveLength(0);
  });

  it("refuses an inflight model with no price before any call (C12)", async () => {
    const p = scripted();
    const unpriced = { ...context(), models: { ...DEFAULT_MODELS, inflight: "claude-unknown-1" } };
    await expect(refreshOnline(unpriced, sources(p.provider))).rejects.toThrow(
      "the inflight role's model claude-unknown-1 has no known price",
    );
    expect(p.calls).toHaveLength(0);
    expect(fx.store.getInFlight()).toBeNull();
  });

  it("skips with GitHub's reason and writes nothing (R3)", async () => {
    const skipped = await refreshOnline(
      context(),
      sources(undefined, github({ skip: "gh is not installed (no gh on PATH)" })),
    );
    expect(skipped).toEqual({ kind: "skipped", reason: "gh is not installed (no gh on PATH)" });
    expect(fx.store.getGitHubSnapshot()).toBeNull();
    expect(readdirSync(fx.out)).toEqual([]);
  });

  it("fails once, before any summary is stored, when calls are due and there is no key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(refreshOnline(context(), sources())).rejects.toThrow(
      /^ANTHROPIC_API_KEY is not set: pnpm wiki:inflight /,
    );
    expect(fx.store.getInFlight()).toBeNull();
    expect(existsSync(join(fx.out, "export.json"))).toBe(false);
  });

  it("rebuilds inflight.git once when it lost the objects its refs name (R5)", async () => {
    await refreshOnline(context("--no-llm"), sources());
    // The blob pull request #1 adds is gone, and so are the remote's refs: the rebuilt
    // inflight.git cannot fetch them again.
    const dir = join(fx.out, INFLIGHT_DIR);
    const blob = execFileSync(
      "git",
      ["-C", dir, "rev-parse", `${snapshot.pulls[0]?.headRefOid}:src/signals/ingest.py`],
      { encoding: "utf8", env: scrubbedGitEnv() },
    ).trim();
    rmSync(join(dir, "objects", blob.slice(0, 2), blob.slice(2)));
    fx.deletePull(1);
    fx.deletePull(2);
    logged = [];
    const done = await refreshOnline(context("--no-llm"), sources());
    expect(logged).toContain("inflight.git lost an object it borrowed; rebuilding it once");
    expect(logged.filter((l) => l.startsWith("pull-request heads:"))).toEqual([
      expect.stringMatching(/^pull-request heads: 2 fetched, 0 missing/),
      expect.stringMatching(/^pull-request heads: 0 fetched, 2 missing/),
    ]);
    expect(logged).toContainEqual(expect.stringMatching(/^#1: impact not computed: /));
    expect(done.kind === "done" && done.inflight.pulls.map((p) => p.head)).toEqual([
      "missing",
      "missing",
    ]);
  });
});

describe("refreshOffline and --clear (spec v2 #9 §4.2)", () => {
  it("re-derives from the stored snapshot, drops merged pull requests and keeps their summaries", async () => {
    const done = await refreshOnline(context(), sources(scripted().provider));
    const summary = done.kind === "done" ? done.inflight.pulls[0]?.summary : undefined;
    const offline = await refreshOffline(context("--offline"), new Set([2]));
    expect(offline.kind === "done" && offline.inflight.pulls.map((p) => p.number)).toEqual([1]);
    expect(offline.kind === "done" && offline.inflight.pulls[0]?.summary).toEqual(summary);
    expect(offline.kind === "done" && [...offline.status]).toEqual([[1, "cached"]]);
    expect(fx.store.getGitHubSnapshot()?.pulls.map((p) => p.number)).toEqual([1]);
    expect(exported().inflight?.pulls).toHaveLength(1);
  });

  it("skips when GitHub was never read", async () => {
    expect(await refreshOffline(context("--offline"))).toEqual({
      kind: "skipped",
      reason: "GitHub was never read; run pnpm wiki:inflight online first",
    });
  });

  it("clears the snapshot, the summary cache and inflight.git, and exports none", async () => {
    await refreshOnline(context(), sources(scripted().provider));
    clearInFlightData(context("--clear"));
    expect([fx.store.getGitHubSnapshot(), fx.store.getInFlight()]).toEqual([null, null]);
    expect(existsSync(join(fx.out, INFLIGHT_DIR))).toBe(false);
    expect(exported().inflight).toBeNull();
    const again = scripted();
    await refreshOnline(context(), sources(again.provider));
    expect(again.calls).toHaveLength(2);
  });
});
