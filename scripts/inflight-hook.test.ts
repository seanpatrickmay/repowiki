import { join } from "node:path";
import { INGEST_PY, makeGitHubPull, makeGitHubSnapshot } from "@repowiki/core/test-fixtures";
import { type InflightFixture, inflightFixture, listing } from "@repowiki/engine/test-inflight";
import { DEFAULT_MODELS, type Provider } from "@repowiki/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInflightArgs } from "./inflight-cli.ts";
import {
  beforeUpdate,
  compareLine,
  type HookContext,
  inflightAfterUpdate,
  mergedBetween,
} from "./inflight-hook.ts";
import { refreshOnline } from "./inflight-run.ts";
import { parseUpdateArgs } from "./update-cli.ts";
import { readInput, runUpdate } from "./update-run.ts";

// Each test builds a fixture wiki, a remote and inflight.git: seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let fx: InflightFixture;
let ctx: HookContext;
beforeEach(async () => {
  fx = await inflightFixture();
  ctx = {
    repo: fx.repo.dir,
    out: fx.out,
    repoName: "demo",
    store: fx.store,
    models: DEFAULT_MODELS,
    log: () => {},
  };
});
afterEach(() => fx.remove());

const lines = INGEST_PY.split("\n");
const ingestWith = (n: number, text: string) =>
  lines.map((line, i) => (i === n - 1 ? text : line)).join("\n");
/** #1 edits the cited line 12 (two claims go stale); #2 edits uncited line 7 (none does). */
const EDITS = {
  1: { "src/signals/ingest.py": ingestWith(12, "    signals = list()") },
  2: { "src/signals/ingest.py": ingestWith(7, "MAX_SIGNALS = 80") },
};

/** Pull requests #1 and #2 read from "GitHub", fetched and stored with no summary call. */
async function refreshed(): Promise<void> {
  const pulls = ([1, 2] as const).map((n) =>
    makeGitHubPull({ number: n, headRefOid: fx.pushPull(n, fx.first, EDITS[n]), closes: [] }),
  );
  const snapshot = makeGitHubSnapshot({ pulls, issues: [] });
  const result = await refreshOnline(
    { ...ctx, args: parseInflightArgs([fx.repo.dir, "--github", "acme/demo", "--no-llm"]) },
    {
      github: { read: () => ({ snapshot }) },
      fetch: { url: fx.url, options: { protocol: "file" } },
    },
  );
  expect(result.kind).toBe("done");
}

/** Lands #n's edit on the documented repository as a squash merge, "… (#n)". */
const merge = (n: 1 | 2): string => {
  for (const [path, text] of Object.entries(EDITS[n])) fx.repo.write(path, text);
  return fx.repo.commit(`Land pull request (#${n})`);
};

const noCall: Provider = {
  generate: () => Promise.reject(new Error("no call is expected")),
};

describe("mergedBetween", () => {
  it("names the pull requests merge and squash commits brought in after `from`", () => {
    fx.repo.write("a.txt", "a\n");
    fx.repo.commit("Merge pull request #5 from fork/branch");
    fx.repo.write("a.txt", "b\n");
    const to = fx.repo.commit("Tidy up (#6)");
    expect(mergedBetween(fx.repo.dir, fx.first, to)).toEqual(new Set([5, 6]));
    expect(mergedBetween(fx.repo.dir, to, to)).toEqual(new Set());
  });
});

describe("compareLine (R22)", () => {
  it("compares the merged pull request's predictions with what the move makes stale", async () => {
    await refreshed();
    const before = beforeUpdate(fx.store);
    if (before === null) throw new Error("the fixture has a wiki");
    const to = merge(1);
    expect(await compareLine(fx.repo.dir, before, to, new Set([1]), false)).toBe(
      "Pull request #1 merged: 2 claims predicted stale, 2 made stale, 2 in both.",
    );
    expect(await compareLine(fx.repo.dir, before, to, new Set([1]), true)).toBe(
      "Predictions not compared: a replay moves through several merges.",
    );
    expect(await compareLine(fx.repo.dir, before, to, new Set([1, 2]), false)).toBe(
      "Predictions not comparable: 2 pull requests merged in this update (#1, #2), so each one's stale claims would count against the others.",
    );
    // A merge outside the snapshot counts too: its stale claims would land on #1's line.
    expect(await compareLine(fx.repo.dir, before, to, new Set([99, 1]), false)).toBe(
      "Predictions not comparable: 2 pull requests merged in this update (#1, #99), so each one's stale claims would count against the others.",
    );
    expect(await compareLine(fx.repo.dir, before, to, new Set(), false)).toBe(
      "Predictions not comparable: no pull request merged in this update.",
    );
    expect(await compareLine(fx.repo.dir, before, to, new Set([99]), false)).toBe(
      "Predictions not compared: #99 is not in the snapshot.",
    );
    expect(
      await compareLine(fx.repo.dir, { ...before, inflight: null }, to, new Set([1]), false),
    ).toBe(
      "Predictions not compared: no snapshot was derived against this update's starting head.",
    );
  });
});

describe("inflightAfterUpdate (R4, C14)", () => {
  it("drops the merged pull request and re-derives the rest against the new head, offline", async () => {
    await refreshed();
    const before = beforeUpdate(fx.store);
    if (before === null) throw new Error("the fixture has a wiki");
    // #2 lands as an empty squash commit, so the update has no page to rewrite and makes no call.
    fx.repo.git("commit", "-q", "--allow-empty", "-m", "Land pull request (#2)");
    const to = fx.repo.git("rev-parse", "HEAD").trim();
    const gitDir = listing(join(fx.repo.dir, ".git"));
    const ran = await runUpdate(
      fx.store,
      await readInput(fx.repo.dir, to),
      parseUpdateArgs([fx.repo.dir, to]),
      DEFAULT_MODELS,
      "demo",
      () => {},
      "wiki:update",
      noCall,
    );
    expect(ran.update.to).toBe(to);
    const section = await inflightAfterUpdate(ctx, before, to, false);
    expect(section).toEqual([
      "## Work in flight",
      "",
      `Re-derived 1 open pull requests against ${to.slice(0, 7)} with no network and no call; dropped #2 (merged).`,
      "",
      "Pull request #2 merged: 0 claims predicted stale, 0 made stale, 0 in both.",
      "",
    ]);
    const inflight = fx.store.getInFlight();
    expect(inflight?.wikiHead).toBe(to);
    expect(inflight?.pulls.map((p) => [p.number, p.effects.map((e) => e.claimId)])).toEqual([
      [1, ["c1", "c2"]],
    ]);
    expect(fx.store.getGitHubSnapshot()?.pulls.map((p) => p.number)).toEqual([1]);
    // Nothing was written inside the documented repository (spec v2 #9 §12.6).
    expect(listing(join(fx.repo.dir, ".git"))).toEqual(gitDir);
  });

  it("does nothing when GitHub was never read, and warns rather than fails", async () => {
    expect(beforeUpdate(fx.store)).toBeNull();
    await refreshed();
    const before = beforeUpdate(fx.store);
    if (before === null) throw new Error("the fixture has a wiki");
    const warned: string[] = [];
    const section = await inflightAfterUpdate(
      { ...ctx, log: (line) => warned.push(line) },
      before,
      "f".repeat(40),
      false,
    );
    expect(section[2]).toMatch(/^Not re-derived: /);
    expect(warned[0]).toMatch(/^warning: work in flight not re-derived: /);
  });

  it("warns rather than fails when the store cannot even say whether GitHub was read", async () => {
    await refreshed();
    const before = beforeUpdate(fx.store);
    if (before === null) throw new Error("the fixture has a wiki");
    const store = Object.create(fx.store) as typeof fx.store;
    store.getGitHubSnapshot = () => {
      throw new Error("database is locked");
    };
    const warned: string[] = [];
    const section = await inflightAfterUpdate(
      { ...ctx, store, log: (line) => warned.push(line) },
      before,
      fx.first,
      false,
    );
    expect(section).toEqual(["## Work in flight", "", "Not re-derived: database is locked", ""]);
    expect(warned).toEqual(["warning: work in flight not re-derived: database is locked"]);
  });
});
