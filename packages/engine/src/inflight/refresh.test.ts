import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GitHubSnapshot } from "@repowiki/core";
import {
  INGEST_PY,
  makeGitHubIssue,
  makeGitHubPull,
  makeGitHubSnapshot,
} from "@repowiki/core/test-fixtures";
import type { GenerateRequest, Provider } from "@repowiki/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExport } from "../store/index.ts";
import { ensureInflightRepo, fetchHeads } from "./heads.ts";
import {
  completeInFlight,
  type Derived,
  deriveInFlight,
  estimateSummaries,
  withinBudget,
} from "./refresh.ts";
import type { InFlightAnswer } from "./summary.ts";
import { type InflightFixture, inflightFixture } from "./test-inflight.ts";

// Each test builds a fixture wiki, a remote and inflight.git: seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let fx: InflightFixture;
let dir: string;
beforeEach(async () => {
  fx = await inflightFixture();
  dir = ensureInflightRepo(fx.out, fx.repo.dir);
});
afterEach(() => fx.remove());

const MODEL = "claude-haiku-4-5";
const lines = INGEST_PY.split("\n");
const ingestWith = (n: number, text: string) =>
  lines.map((line, i) => (i === n - 1 ? text : line)).join("\n");

/** Pull request #1 fetched (it edits ingest_chunk), #2 never fetched, #3 moved since GitHub read it. */
function snapshotWithPulls(): {
  snapshot: GitHubSnapshot;
  heads: ReturnType<typeof fetchHeads>["heads"];
} {
  const one = fx.pushPull(1, fx.first, {
    "src/signals/ingest.py": ingestWith(12, "    signals = list()"),
  });
  const three = fx.pushPull(3, fx.first, { "src/deliverables/crud.py": "x = 1\n" });
  fx.pushPull(3, fx.first, { "src/deliverables/crud.py": "x = 2\n" });
  const snapshot = makeGitHubSnapshot({
    pulls: [
      makeGitHubPull({
        number: 1,
        headRefOid: one,
        closes: [7, 99],
        updatedAt: "2026-10-03T09:00:00Z",
      }),
      makeGitHubPull({
        number: 2,
        headRefOid: "e".repeat(40),
        closes: [],
        files: ["src/deliverables/crud.py", "nowhere.py"],
        filesTotal: 2,
        updatedAt: "2026-10-02T09:00:00Z",
      }),
      makeGitHubPull({
        number: 3,
        headRefOid: three,
        closes: [],
        updatedAt: "2026-10-01T09:00:00Z",
      }),
    ],
    issues: [
      makeGitHubIssue({ number: 7 }),
      makeGitHubIssue({ number: 8, title: "Deliverables export fails", body: "", labels: [] }),
    ],
  });
  const { heads } = fetchHeads(dir, fx.url, snapshot.pulls, { protocol: "file" });
  return { snapshot, heads };
}

const derive = (snapshot: GitHubSnapshot, heads: Map<number, "fetched" | "missing" | "moved">) =>
  deriveInFlight({ store: fx.store, dir, snapshot, heads, model: MODEL });

/** A provider answering every summary request with one claim citing ingest.py's changed line. */
function provider(): { provider: Provider; calls: GenerateRequest<unknown>[] } {
  const calls: GenerateRequest<unknown>[] = [];
  return {
    calls,
    provider: {
      async generate<T>(req: GenerateRequest<T>) {
        calls.push(req as GenerateRequest<unknown>);
        const output: InFlightAnswer = {
          claims: [
            {
              text: "It builds the list with `list()`.",
              cite: ["src/signals/ingest.py:12-12"],
              features: ["signals"],
            },
          ],
        };
        return {
          output: output as T,
          usage: { in: 4000, out: 200, cacheRead: 0, cacheWrite: 0 },
          model: "claude-haiku-4-5-20251001",
        };
      },
    },
  };
}

const complete = (
  derived: Derived,
  p: Provider | null,
  maxUsd = 1,
  previous = null as Parameters<typeof completeInFlight>[2]["previous"],
) =>
  completeInFlight(fx.store, derived, {
    provider: p,
    model: MODEL,
    batch: true,
    maxUsd,
    fetchedAt: "2026-10-03T09:30:00Z",
    previous,
    now: () => new Date("2026-10-04T12:00:00Z"),
  });

describe("deriveInFlight", () => {
  it("computes fetched heads' impacts, others from GitHub's file list, and maps the issues", async () => {
    const { snapshot, heads } = snapshotWithPulls();
    expect([...heads]).toEqual([
      [1, "fetched"],
      [2, "missing"],
      [3, "moved"],
    ]);
    const derived = await derive(snapshot, heads);
    const [one, two, three] = derived.pulls.map((p) => p.pull);
    expect(one).toMatchObject({
      head: "fetched",
      merge: "clean",
      closes: [7],
      mergeBase: fx.first,
    });
    expect(one?.effects.map((e) => `${e.featureId}/${e.claimId}`)).toEqual([
      "signals/c1",
      "signals/c2",
    ]);
    expect(two).toMatchObject({
      head: "missing",
      merge: "unknown",
      files: [],
      effects: [],
      summary: null,
    });
    expect(two?.features).toEqual([
      {
        featureId: "deliverables",
        files: 1,
        changedLines: 0,
        added: 0,
        removed: 0,
        churn: null,
        drifts: false,
      },
    ]);
    expect(three?.head).toBe("moved");
    expect(derived.pulls.map((p) => p.request === null)).toEqual([false, true, true]);
    expect(
      derived.issues.map((i) => [
        i.number,
        i.features.map((e) => `${e.kind}:${e.featureId}`),
        i.pulls,
      ]),
    ).toEqual([
      [7, ["pull:signals"], [1]],
      [8, ["name:deliverables"], []],
    ]);
    expect(derived.corrupt).toBe(false);
  });

  it("marks a pull request missing and the store corrupt when inflight.git lost its objects", async () => {
    const { snapshot, heads } = snapshotWithPulls();
    for (const entry of readdirSync(join(dir, "objects"))) {
      if (/^[0-9a-f]{2}$/.test(entry) || entry === "pack")
        rmSync(join(dir, "objects", entry), { recursive: true });
    }
    const logged: string[] = [];
    const derived = await deriveInFlight({
      store: fx.store,
      dir,
      snapshot,
      heads,
      model: MODEL,
      log: (l) => logged.push(l),
    });
    expect(derived.corrupt).toBe(true);
    expect(derived.pulls[0]?.pull.head).toBe("missing");
    expect(logged[0]).toMatch(/^#1: impact not computed: /);
  });
});

describe("deriveInFlight's summary requests (R9, R14)", () => {
  it("makes no request for a pull with no citable lines, so a refresh spends nothing on it", async () => {
    const head = fx.pushPull(4, fx.first, { "src/deliverables/crud.py": null });
    const snapshot = makeGitHubSnapshot({
      pulls: [makeGitHubPull({ number: 4, headRefOid: head, closes: [] })],
      issues: [],
    });
    const { heads } = fetchHeads(dir, fx.url, snapshot.pulls, { protocol: "file" });
    const derived = await derive(snapshot, heads);
    expect(derived.pulls[0]?.pull.files.map((f) => [f.path, f.status])).toEqual([
      ["src/deliverables/crud.py", "deleted"],
    ]);
    expect(derived.pulls[0]?.request).toBeNull();
    const p = provider();
    const done = await complete(derived, p.provider);
    expect(p.calls).toHaveLength(0);
    expect(done.status.get(4)).toBe("none");
  });

  it("gives each pull its own key, finds a stored answer by it, and derives the same twice", async () => {
    const { snapshot, heads } = snapshotWithPulls();
    const four = fx.pushPull(4, fx.first, {
      "src/signals/ingest.py": ingestWith(13, "    # A blank sentence makes no signal."),
    });
    const both = {
      ...snapshot,
      pulls: [
        ...snapshot.pulls,
        makeGitHubPull({
          number: 4,
          headRefOid: four,
          closes: [],
          updatedAt: "2026-09-30T09:00:00Z",
        }),
      ],
    };
    const fetched = fetchHeads(dir, fx.url, both.pulls, { protocol: "file" }).heads;
    const derived = await derive(both, fetched);
    expect(await derive(both, fetched)).toEqual(derived);
    const [one, , , other] = derived.pulls;
    const key = one?.request?.key ?? "";
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(other?.request?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(other?.request?.key).not.toBe(key);
    expect(one?.cached).toBeNull();
    const done = await complete(derived, provider().provider);
    const summary = done.inflight.pulls[0]?.summary;
    if (summary == null) throw new Error("pull request #1 was summarised");
    const again = await derive(both, fetched);
    expect(again.pulls[0]?.cached).toEqual(summary);
    expect(again.pulls[3]?.cached).toEqual(done.inflight.pulls[3]?.summary ?? null);
  });

  it("logs a pull request's failure through the caller's describeError", async () => {
    const { snapshot, heads } = snapshotWithPulls();
    for (const entry of readdirSync(join(dir, "objects"))) {
      if (/^[0-9a-f]{2}$/.test(entry) || entry === "pack")
        rmSync(join(dir, "objects", entry), { recursive: true });
    }
    const logged: string[] = [];
    await deriveInFlight({
      store: fx.store,
      dir,
      snapshot,
      heads,
      model: MODEL,
      log: (l) => logged.push(l),
      describeError: (error) => `described: ${error instanceof Error ? error.name : "?"}`,
    });
    expect(logged[0]).toBe("#1: impact not computed: described: GitError");
  });
});

describe("the summary round", () => {
  it("estimates the misses before any call, at 700 output tokens and at the 1,500 cap", async () => {
    const { snapshot, heads } = snapshotWithPulls();
    const derived = await derive(snapshot, heads);
    const estimate = estimateSummaries(derived, MODEL, true);
    const tokens = derived.pulls[0]?.request?.tokens ?? 0;
    expect(estimate).toEqual({
      requests: 1,
      cached: 0,
      typicalUsd: ((tokens * 1 + 700 * 5) / 1e6) * 0.5,
      ceilingUsd: ((tokens * 1 + 1500 * 5) / 1e6) * 0.5,
    });
    expect(estimateSummaries(derived, "claude-unknown-1", true)).toBeNull();
    expect(withinBudget(derived, MODEL, true, 0.000001)).toEqual({
      chosen: [],
      over: [derived.pulls[0]?.request],
    });
  });

  it("asks once, caches the verified summary, and makes no call on an immediate second refresh", async () => {
    const { snapshot, heads } = snapshotWithPulls();
    const first = provider();
    const done = await complete(await derive(snapshot, heads), first.provider);
    expect(first.calls).toHaveLength(1);
    expect(done.status.get(1)).toBe("new");
    expect(done.inflight.pulls[0]?.summary?.claims.map((c) => c.id)).toEqual(["p1-c1"]);
    expect([done.status.get(2), done.status.get(3)]).toEqual(["none", "none"]);
    fx.store.putInFlight(done.inflight);
    expect(
      buildExport(fx.store, { repo: "demo", exportedAt: "2026-10-04T12:00:00Z" }).inflight,
    ).toEqual(done.inflight);

    const second = provider();
    const again = await complete(await derive(snapshot, heads), second.provider);
    expect(second.calls).toHaveLength(0);
    expect(again.status.get(1)).toBe("cached");
    expect(again.inflight.pulls[0]?.summary).toEqual(done.inflight.pulls[0]?.summary);
  });

  it("asks nothing over budget, and nothing at all without a provider", async () => {
    const { snapshot, heads } = snapshotWithPulls();
    const derived = await derive(snapshot, heads);
    const p = provider();
    expect((await complete(derived, p.provider, 0.000001)).status.get(1)).toBe("over budget");
    expect((await complete(derived, null)).status.get(1)).toBe("not asked");
    expect(p.calls).toHaveLength(0);
  });

  it("keeps the previous summary of a head that did not move when its request is not cached", async () => {
    const { snapshot, heads } = snapshotWithPulls();
    const done = await complete(await derive(snapshot, heads), provider().provider);
    fx.store.pruneInFlightSummaries([]);
    const offline = await complete(await derive(snapshot, heads), null, 1, done.inflight);
    expect(offline.status.get(1)).toBe("kept");
    expect(offline.inflight.pulls[0]?.summary).toEqual(done.inflight.pulls[0]?.summary);
  });
});
