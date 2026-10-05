import { memberId } from "@repowiki/core";
import { INGEST_PY } from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DRIFT_THRESHOLD, STORE_PY } from "../freshness/index.ts";
import { ensureInflightRepo, fetchHeads } from "./heads.ts";
import { featuresFromPaths, type ImpactContext, mergeBase, pullChanges } from "./impact.ts";
import { type Edits, type InflightFixture, inflightFixture } from "./test-inflight.ts";

// Each test builds a fixture wiki, a remote and inflight.git: seconds on a loaded machine.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let fx: InflightFixture;
let ctx: ImpactContext;
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
});
afterEach(() => fx.remove());

/** Pushes pull request `n` and fetches it into inflight.git; returns its head. */
function pull(n: number, edits: Edits, base = fx.first): string {
  const head = fx.pushPull(n, base, edits);
  fetchHeads(ctx.dir, fx.url, [{ number: n, headRefOid: head }], { protocol: "file" });
  return head;
}

const CHANGED_INGEST = INGEST_PY.replace("MAX_SIGNALS = 50", "MAX_SIGNALS = 80");

describe("pullChanges: file to feature (R8)", () => {
  it("puts an edited member file in its feature, with its line counts", async () => {
    const head = pull(1, { "src/signals/ingest.py": CHANGED_INGEST });
    const changes = await pullChanges(ctx, head);
    expect(changes.mergeBase).toBe(fx.first);
    expect(changes.files).toEqual([
      {
        path: "src/signals/ingest.py",
        oldPath: "src/signals/ingest.py",
        status: "modified",
        additions: 1,
        deletions: 1,
        featureId: "signals",
        placement: "member",
      },
    ]);
    expect(changes.features).toEqual([
      {
        featureId: "signals",
        files: 1,
        changedLines: 2,
        added: 0,
        removed: 0,
        churn: 0,
        drifts: false,
      },
    ]);
  });

  it("follows a rename to its old path's feature, and counts a deleted member as removed", async () => {
    const head = pull(2, {
      "src/signals/store.py": null,
      "src/signals/persist.py": STORE_PY,
      "docs/signals.md": null,
    });
    const { files, features } = await pullChanges(ctx, head);
    expect(files.map((f) => [f.path, f.oldPath, f.status, f.featureId, f.placement])).toEqual([
      ["docs/signals.md", "docs/signals.md", "deleted", "signals", "member"],
      ["src/signals/persist.py", "src/signals/store.py", "renamed", "signals", "member"],
    ]);
    expect(features[0]).toMatchObject({ featureId: "signals", files: 2, removed: 1, added: 0 });
  });

  it("places a new file by its directory, and one in a new directory by what it imports", async () => {
    const head = pull(3, {
      "src/signals/batch.py": "def batch():\n    return []\n",
      "src/reports/summary.py":
        "from src.deliverables.crud import complete\n\n\ndef summary(d):\n    return complete(d)\n",
    });
    const { files, features } = await pullChanges(ctx, head);
    expect(files.map((f) => [f.path, f.status, f.featureId, f.placement])).toEqual([
      ["src/reports/summary.py", "added", "deliverables", "inferred"],
      ["src/signals/batch.py", "added", "signals", "inferred"],
    ]);
    expect(features.map((f) => [f.featureId, f.added, f.changedLines])).toEqual([
      ["deliverables", 1, 5],
      ["signals", 1, 2],
    ]);
  });

  it("says a new file's members would drift a small feature past the threshold", async () => {
    const head = pull(4, {
      "src/deliverables/export.py": "def export(d):\n    return d\n",
      "src/deliverables/archive.py": "def archive(d):\n    return d\n",
    });
    const feature = (await pullChanges(ctx, head)).features[0];
    expect(feature?.featureId).toBe("deliverables");
    expect(feature?.drifts).toBe(true);
    expect(feature?.churn).toBeGreaterThan(DEFAULT_DRIFT_THRESHOLD);
  });

  it("gives no feature to a deleted file the wiki's head does not have", async () => {
    const head = pull(5, { "docs/signals.md": null });
    const membership = { ...ctx.manifest.membership };
    delete membership[memberId("docs/signals.md")];
    const { files, features } = await pullChanges(
      { ...ctx, manifest: { ...ctx.manifest, membership } },
      head,
    );
    expect(files).toEqual([
      expect.objectContaining({ path: "docs/signals.md", featureId: null, placement: "none" }),
    ]);
    expect(features).toEqual([]);
  });

  it("lists at most 300 files, by path, and counts the rest", async () => {
    const edits: Record<string, string> = {};
    for (let i = 0; i < 303; i++)
      edits[`src/signals/gen/m${String(i).padStart(3, "0")}.txt`] = `${i}\n`;
    const head = pull(6, edits);
    const { files, filesTruncated, features } = await pullChanges(ctx, head);
    expect(files).toHaveLength(300);
    expect(files[0]?.path).toBe("src/signals/gen/m000.txt");
    expect(filesTruncated).toBe(3);
    expect(features[0]).toMatchObject({ featureId: "signals", files: 303, added: 303 });
  }, 30_000);

  it("measures a pull request based on an older commit from its merge base", async () => {
    fx.repo.write("src/deliverables/crud.py", "# moved on\n");
    const second = fx.repo.commit("main moves on");
    const head = pull(7, { "src/signals/ingest.py": CHANGED_INGEST });
    expect(mergeBase(ctx.dir, second, head)).toBe(fx.first);
    const { files } = await pullChanges({ ...ctx, wikiHead: second }, head);
    // Main's own change to crud.py is not the pull request's.
    expect(files.map((f) => f.path)).toEqual(["src/signals/ingest.py"]);
  });
});

describe("featuresFromPaths", () => {
  it("counts GitHub's paths that are manifest members, with no lines and no drift", () => {
    expect(
      featuresFromPaths(ctx.manifest, ["src/signals/ingest.py", "docs/signals.md", "nowhere.py"]),
    ).toEqual([
      {
        featureId: "signals",
        files: 2,
        changedLines: 0,
        added: 0,
        removed: 0,
        churn: null,
        drifts: false,
      },
    ]);
  });
});
