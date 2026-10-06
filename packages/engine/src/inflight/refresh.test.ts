import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GitHubSnapshot } from "@repowiki/core";
import {
  INGEST_PY,
  makeGitHubIssue,
  makeGitHubPull,
  makeGitHubSnapshot,
} from "@repowiki/core/test-fixtures";
import { callCostUsd, type GenerateRequest, type Provider } from "@repowiki/llm";
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
import type { InFlightAnswer, SummaryRequest } from "./summary.ts";
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
        baseRefOid: fx.first,
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
        baseRefOid: fx.first,
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

describe("deriveInFlight against each pull request's own base (R27)", () => {
  it("credits main's newer commits to no pull request forked after them", async () => {
    // The reviewer's probe: the wiki is built at fx.first; main moves on (ingest.py's cited lines)
    // with wiki:update not yet run; then pull request #5 forks from main and edits crud.py.
    const main = fx.pushPull(90, fx.first, {
      "src/signals/ingest.py": ingestWith(12, "    signals = list()"),
    });
    const head = fx.pushPull(5, main, { "src/deliverables/crud.py": "x = 1\n" });
    const snapshot = makeGitHubSnapshot({
      pulls: [makeGitHubPull({ number: 5, headRefOid: head, baseRefOid: main, closes: [] })],
      issues: [],
    });
    const { heads } = fetchHeads(dir, fx.url, snapshot.pulls, { protocol: "file" });
    const [five] = (await derive(snapshot, heads)).pulls;
    expect(five?.pull).toMatchObject({
      head: "fetched",
      mergeBase: main,
      baseSha: main,
      behind: true,
      merge: "unknown",
    });
    expect(five?.pull.files.map((f) => f.path)).toEqual(["src/deliverables/crud.py"]);
    expect(five?.pull.features.map((f) => f.featureId)).toEqual(["deliverables"]);
    expect(five?.pull.effects.map((e) => `${e.featureId}/${e.claimId}/${e.certain}`)).toEqual([
      "deliverables/c1/false",
      "deliverables/c2/false",
    ]);
    // Its summary request shows only its own lines, none of main's.
    expect(five?.request?.user).toContain("crud.py");
    expect(five?.request?.user).not.toContain("ingest.py");
  });

  it("keeps R7's certain effects for a pull request forked from the wiki's head", async () => {
    const head = fx.pushPull(1, fx.first, {
      "src/signals/ingest.py": ingestWith(12, "    signals = list()"),
    });
    const withBase = makeGitHubSnapshot({
      pulls: [makeGitHubPull({ number: 1, headRefOid: head, baseRefOid: fx.first, closes: [] })],
      issues: [],
    });
    const { heads } = fetchHeads(dir, fx.url, withBase.pulls, { protocol: "file" });
    const [one] = (await derive(withBase, heads)).pulls;
    expect(one?.pull).toMatchObject({ behind: false, merge: "clean", mergeBase: fx.first });
    expect(one?.pull.effects.map((e) => `${e.claimId}/${e.certain}`)).toEqual([
      "c1/true",
      "c2/true",
    ]);
  });

  it("treats a pull request whose base was not read as behind: GitHub's files, no request", async () => {
    const head = fx.pushPull(6, fx.first, { "src/deliverables/crud.py": "x = 1\n" });
    const snapshot = makeGitHubSnapshot({
      pulls: [
        makeGitHubPull({
          number: 6,
          headRefOid: head,
          baseRefOid: null,
          closes: [],
          files: ["src/deliverables/crud.py"],
        }),
      ],
      issues: [],
    });
    const { heads } = fetchHeads(dir, fx.url, snapshot.pulls, { protocol: "file" });
    const [six] = (await derive(snapshot, heads)).pulls;
    expect(six?.pull).toMatchObject({
      head: "fetched",
      mergeBase: null,
      behind: true,
      merge: "unknown",
      files: [],
    });
    expect(six?.pull.features.map((f) => f.featureId)).toEqual(["deliverables"]);
    expect(six?.pull.effects.every((e) => !e.certain)).toBe(true);
    expect(six?.pull.effects.map((e) => e.claimId)).toEqual(["c1", "c2"]);
    expect(six?.request).toBeNull();
  });
});

describe("deriveInFlight's summary requests (R9, R14)", () => {
  it("makes no request for a pull with no citable lines, so a refresh spends nothing on it", async () => {
    const head = fx.pushPull(4, fx.first, { "src/deliverables/crud.py": null });
    const snapshot = makeGitHubSnapshot({
      pulls: [makeGitHubPull({ number: 4, headRefOid: head, baseRefOid: fx.first, closes: [] })],
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
          baseRefOid: fx.first,
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

describe("withinBudget across pull requests (R17)", () => {
  /** A derived pull with a request of `tokens` input tokens and no cached answer. */
  const due = (number: number, updatedAt: string, tokens: number) => ({
    pull: { number },
    request: { number, tokens } as SummaryRequest,
    cached: null,
    updatedAt,
  });
  const derived = {
    pulls: [
      due(1, "2026-10-01T00:00:00Z", 1000),
      due(2, "2026-10-03T00:00:00Z", 9000),
      due(3, "2026-10-02T00:00:00Z", 100),
    ],
  } as unknown as Derived;
  const ceiling = (tokens: number) =>
    callCostUsd(MODEL, { in: tokens, out: 1500, cacheRead: 0, cacheWrite: 0 }, true) as number;
  const numbers = (r: { chosen: SummaryRequest[]; over: SummaryRequest[] }) => ({
    chosen: r.chosen.map((q) => q.number),
    over: r.over.map((q) => q.number),
  });
  const budget = (maxUsd: number) => numbers(withinBudget(derived, MODEL, true, maxUsd));

  it("takes the newest activity first, each at its ceiling, up to an exact fit", () => {
    // Newest first: #2 (9,000 tokens), #3 (100), #1 (1,000).
    const all = ceiling(9000) + ceiling(100) + ceiling(1000);
    expect(estimateSummaries(derived, MODEL, true)?.ceilingUsd).toBe(all);
    expect(budget(all)).toEqual({ chosen: [2, 3, 1], over: [] });
    expect(budget(ceiling(9000))).toEqual({ chosen: [2], over: [3, 1] });
  });

  it("stops at the first that does not fit: no later, cheaper one is taken", () => {
    expect(budget(ceiling(9000) + ceiling(100) + ceiling(1000) - 1e-9)).toEqual({
      chosen: [2, 3],
      over: [1],
    });
    // #3 and #1 would fit alone, but #2 is newer and does not.
    expect(budget(ceiling(9000) - 1e-9)).toEqual({ chosen: [], over: [2, 3, 1] });
  });
});
