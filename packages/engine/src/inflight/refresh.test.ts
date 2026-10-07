import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GitHubSnapshot } from "@repowiki/core";
import {
  INGEST_PY,
  makeGitHubIssue,
  makeGitHubPull,
  makeGitHubSnapshot,
} from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureInflightRepo, fetchHeads } from "./heads.ts";
import { deriveInFlight } from "./refresh.ts";
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
