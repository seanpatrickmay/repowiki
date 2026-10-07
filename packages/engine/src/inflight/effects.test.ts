import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Revision } from "@repowiki/core";
import { INGEST_PY } from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DRIFT_THRESHOLD, inputAt, planPages, planUpdate } from "../freshness/index.ts";
import { createTestRepo, scrubbedGitEnv } from "../index/index.ts";
import { fileLevelEffects, mergeTree, pullImpact, staleClaims } from "./effects.ts";
import { ensureInflightRepo, fetchHeads, pullRef } from "./heads.ts";
import { forkPoint, type ImpactContext } from "./impact.ts";
import { type Edits, type InflightFixture, inflightFixture } from "./test-inflight.ts";

// Each test builds a fixture wiki, a remote and inflight.git: seconds on a loaded machine.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let fx: InflightFixture;
let ctx: ImpactContext;
let pages: Revision[];
beforeEach(async () => {
  fx = await inflightFixture();
  const manifest = fx.store.getLatestManifest();
  if (manifest === null) throw new Error("the fixture stores a manifest");
  ctx = {
    dir: ensureInflightRepo(fx.out, fx.repo.dir),
    wikiHead: fx.first,
    manifest,
    baseline: manifest,
    driftThreshold: DEFAULT_DRIFT_THRESHOLD,
  };
  pages = fx.store.listCurrentRevisions();
});
afterEach(() => fx.remove());

function pull(n: number, edits: Edits, base = fx.first): string {
  const head = fx.pushPull(n, base, edits);
  fetchHeads(ctx.dir, fx.url, [{ number: n, headRefOid: head }], { protocol: "file" });
  return head;
}

const lines = INGEST_PY.split("\n");
/** ingest.py with line `n` (1-based) replaced. */
const ingestWith = (n: number, text: string) =>
  lines.map((line, i) => (i === n - 1 ? text : line)).join("\n");
const signalsPage = () => pages.find((p) => p.featureId === "signals") as Revision;

describe("pullImpact (R7)", () => {
  it("predicts the cited claim and the lead summarizing it go stale when a PR edits the cited lines", async () => {
    const head = pull(1, { "src/signals/ingest.py": ingestWith(12, "    signals = list()") });
    const impact = await pullImpact(ctx, head, pages);
    expect(impact.merge).toBe("clean");
    expect(impact.effects).toEqual([
      {
        featureId: "signals",
        revisionId: signalsPage().id,
        claimId: "c1",
        reason: "it summarizes c2, which changed",
        certain: true,
      },
      {
        featureId: "signals",
        revisionId: signalsPage().id,
        claimId: "c2",
        reason: `src/signals/ingest.py:10-24 at ${fx.first.slice(0, 7)}: the cited lines changed`,
        certain: true,
      },
    ]);
  });

  it("predicts nothing for a PR that only moves the cited lines, or edits lines no claim cites", async () => {
    const moved = pull(2, { "src/signals/ingest.py": `# a header\n\n${INGEST_PY}` });
    expect((await pullImpact(ctx, moved, pages)).effects).toEqual([]);
    const uncited = pull(3, { "src/signals/ingest.py": ingestWith(7, "MAX_SIGNALS = 80") });
    expect((await pullImpact(ctx, uncited, pages)).effects).toEqual([]);
  });

  it("falls back to may-change for every claim citing a changed file when the merge conflicts", async () => {
    // Main moves on from the wiki's head with its own edit of line 12; the PR edits it too.
    fx.repo.write("src/signals/ingest.py", ingestWith(12, "    signals = [] # main"));
    const second = fx.repo.commit("main edits ingest");
    const head = pull(4, { "src/signals/ingest.py": ingestWith(12, "    signals = [] # pr") });
    const impact = await pullImpact({ ...ctx, wikiHead: second }, head, pages);
    expect(impact.merge).toBe("conflicts");
    expect(impact.effects.map((e) => [e.claimId, e.certain, e.reason])).toEqual([
      ["c1", false, "it summarizes c2, which may change"],
      ["c2", false, "the pull request changes a cited file"],
    ]);
  });

  it("matches what the update finds stale once the PR really merges (impact equivalence)", async () => {
    const head = pull(5, {
      "src/signals/ingest.py": ingestWith(15, "        if not sentence.text:"),
      "src/deliverables/crud.py": "def complete(deliverable):\n    return None\n",
    });
    const predicted = (await pullImpact(ctx, head, pages)).effects.map(
      (e) => `${e.featureId}/${e.claimId}`,
    );
    // Merge it for real in the documented repository, then plan the update to the merge.
    fx.repo.git("fetch", "--quiet", ctx.dir, `${pullRef(5)}:refs/heads/pr-5`);
    const merge = fx.repo.merge("pr-5", "Merge pull request #5 from contributor/pr-5");
    const input = await inputAt(fx.repo, merge);
    const plan = planUpdate(fx.store, input);
    const manifest = fx.store.getLatestManifest();
    if (manifest === null) throw new Error("the fixture stores a manifest");
    const actual = planPages(plan, fx.store, input, manifest, new Set()).rewrites.flatMap((r) =>
      r.claims.filter((c) => c.status === "stale").map((c) => `${r.featureId}/${c.claim.id}`),
    );
    expect(predicted.sort()).toEqual(actual.sort());
    expect(predicted).toEqual(["deliverables/c1", "deliverables/c2", "signals/c1", "signals/c2"]);
  });

  it("matches the update too when the PR renames a cited file and edits a claim's lines", async () => {
    const crud = fx.repo.git("show", `${fx.first}:src/deliverables/crud.py`);
    const head = pull(8, {
      "src/deliverables/crud.py": null,
      "src/deliverables/items.py": crud,
      "src/signals/ingest.py": ingestWith(12, "    signals = list()"),
    });
    const predicted = (await pullImpact(ctx, head, pages)).effects.map(
      (e) => `${e.featureId}/${e.claimId}`,
    );
    fx.repo.git("fetch", "--quiet", ctx.dir, `${pullRef(8)}:refs/heads/pr-8`);
    const merge = fx.repo.merge("pr-8", "Merge pull request #8 from contributor/pr-8");
    const input = await inputAt(fx.repo, merge);
    const plan = planUpdate(fx.store, input);
    const manifest = fx.store.getLatestManifest();
    if (manifest === null) throw new Error("the fixture stores a manifest");
    const actual = planPages(plan, fx.store, input, manifest, new Set()).rewrites.flatMap((r) =>
      r.claims.filter((c) => c.status === "stale").map((c) => `${r.featureId}/${c.claim.id}`),
    );
    expect(predicted.sort()).toEqual(actual.sort());
    expect(predicted).toContain("signals/c2");
  });

  it("never runs a merge driver a PR's .gitattributes names (R21)", async () => {
    const marker = join(fx.out, "pwned");
    // The user's global config defines the driver; inflight.git reads no global config, and no
    // attributes from any tree. The PR's .gitattributes asks for it on a conflicting file.
    const global = join(fx.out, "global.gitconfig");
    writeFileSync(global, `[merge "evil"]\n\tdriver = touch ${marker}; false\n`);
    fx.repo.write("src/signals/ingest.py", ingestWith(12, "    signals = [] # main"));
    const second = fx.repo.commit("main edits ingest");
    const head = pull(6, {
      ".gitattributes": "*.py merge=evil\n",
      "src/signals/ingest.py": ingestWith(12, "    signals = [] # pr"),
    });
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    let merged: ReturnType<typeof mergeTree>;
    try {
      merged = mergeTree(ctx.dir, second, head);
      // Asserted after the merge and outside any catch: a driver that ran fails the test.
      expect(existsSync(marker)).toBe(false);
      // Control: the same merge with the PR's attributes and the driver configured does run it.
      try {
        execFileSync(
          "git",
          ["-C", ctx.dir, "-c", `attr.tree=${head}`, "merge-tree", "--write-tree", second, head],
          { env: scrubbedGitEnv(), stdio: "ignore" },
        );
      } catch {
        // merge-tree exits 1 on the conflict.
      }
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
    expect(merged.merge).toBe("conflicts");
    expect(existsSync(marker)).toBe(true);
  });

  it("falls back to may-change for a PR whose head shares no history with the wiki's head", async () => {
    // A fork pushed with an unrelated history: merge-tree refuses it (exit 128).
    const orphan = createTestRepo();
    try {
      orphan.write("src/signals/ingest.py", ingestWith(12, "    signals = [] # fork"));
      const head = orphan.commit("an unrelated root");
      orphan.git("push", "--quiet", fx.url, `HEAD:refs/pull/7/head`);
      fetchHeads(ctx.dir, fx.url, [{ number: 7, headRefOid: head }], { protocol: "file" });
      expect(mergeTree(ctx.dir, fx.first, head)).toEqual({
        merge: "unknown",
        tree: null,
        reason: "unrelated",
      });
      const impact = await pullImpact(ctx, head, pages);
      expect(impact.mergeBase).toBeNull();
      expect([impact.merge, impact.mergeReason]).toEqual(["unknown", "unrelated"]);
      expect(impact.effects.length).toBeGreaterThan(0);
      expect(impact.effects.every((e) => !e.certain)).toBe(true);
    } finally {
      orphan.remove();
    }
  });
});

describe("a pull request's own changes (R27)", () => {
  it("diffs a pull request forked past the wiki's head from its fork point, and it only may change", async () => {
    // Main moves on past the wiki's head (another pull request merged, wiki:update not run yet),
    // editing ingest.py's cited lines; then a pull request forks from it and edits crud.py.
    const main = fx.pushPull(90, fx.first, {
      "src/signals/ingest.py": ingestWith(12, "    signals = list()"),
    });
    const head = pull(5, { "src/deliverables/crud.py": "x = 1\n" }, main);
    const fork = forkPoint(ctx.dir, main, head);
    expect(fork).toBe(main);
    const impact = await pullImpact(ctx, head, pages, fork as string);
    expect(impact.mergeBase).toBe(main);
    expect(impact.files.map((f) => f.path)).toEqual(["src/deliverables/crud.py"]);
    expect(impact.features.map((f) => f.featureId)).toEqual(["deliverables"]);
    expect(impact.behind).toBe(true);
    expect(impact.merge).toBe("unknown");
    expect(impact.effects.map((e) => [e.featureId, e.claimId, e.certain])).toEqual([
      ["deliverables", "c1", false],
      ["deliverables", "c2", false],
    ]);
  });

  it("keeps R7's certain effects when the fork point is in the wiki", async () => {
    const head = pull(1, { "src/signals/ingest.py": ingestWith(12, "    signals = list()") });
    const fork = forkPoint(ctx.dir, fx.first, head);
    expect(fork).toBe(fx.first);
    const impact = await pullImpact(ctx, head, pages, fork as string);
    expect(impact).toEqual(await pullImpact(ctx, head, pages));
    expect(impact.behind).toBe(false);
    expect(impact.merge).toBe("clean");
    expect(impact.effects.map((e) => [e.claimId, e.certain])).toEqual([
      ["c1", true],
      ["c2", true],
    ]);
  });

  it("finds no fork point for a base inflight.git lacks or none was given", () => {
    const head = pull(1, { "a.py": "a\n" });
    expect(forkPoint(ctx.dir, null, head)).toBeNull();
    expect(forkPoint(ctx.dir, "e".repeat(40), head)).toBeNull();
  });
});

describe("staleClaims", () => {
  it("leaves out a claim that was failing before the move, which the move does not touch", async () => {
    const page = signalsPage();
    const broken: Revision = {
      ...page,
      sections: page.sections.map((s) =>
        s.key === "overview"
          ? {
              ...s,
              claims: s.claims.map((c) => ({
                ...c,
                citations: c.citations.map((x) =>
                  x.kind === "code" ? { ...x, contentHash: "0".repeat(64) } : x,
                ),
              })),
            }
          : s,
      ),
    };
    const head = pull(7, { "src/deliverables/crud.py": "def complete(d):\n    return d\n" });
    const stale = await staleClaims(ctx.dir, fx.first, head, [broken]);
    expect(stale).toEqual([]);
  });
});

describe("fileLevelEffects", () => {
  it("names each claim citing a changed path, old or new, and the leads summarizing them", () => {
    const effects = fileLevelEffects(pages, [
      {
        status: "renamed",
        oldPath: "src/deliverables/crud.py",
        newPath: "src/d/crud.py",
        hunks: [],
        binary: false,
      },
    ]);
    expect(effects.map((e) => `${e.featureId}/${e.claimId}`)).toEqual([
      "deliverables/c1",
      "deliverables/c2",
    ]);
  });
});
