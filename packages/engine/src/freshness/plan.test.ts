import { INGEST_PY } from "@repowiki/core/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import type { TestRepo } from "../index/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { buildUpdatePack, type PageRewrite } from "../write/index.ts";
import { knownFeature, measureDrift, planPages, planUpdate, UpdateError } from "./plan.ts";
import { builtWiki, inputAt } from "./test-wiki-repo.ts";

let repo: TestRepo;
let store: Store;
let first: string;
afterEach(() => {
  store.close();
  repo.remove();
});

/** A pull request that edits ingest_chunk and adds src/signals/batch.py, merged as #7. */
function mergePaging(): { branch: string; merge: string } {
  repo.git("switch", "-q", "-c", "paging");
  repo.write(
    "src/signals/ingest.py",
    INGEST_PY.replace(
      "    # Blank sentences make no signal.",
      "    # Blank sentences are skipped.",
    ),
  );
  repo.write("src/signals/batch.py", "def drain(queue):\n    return list(queue)\n");
  const branch = repo.commit("feat: drain signals in batches");
  repo.git("switch", "-q", "main");
  return { branch, merge: repo.merge("paging", "Merge pull request #7 from me/paging") };
}

describe("planUpdate", () => {
  it("reads the diff, the new commits, the PR and where the new files go", async () => {
    ({ repo, store, first } = await builtWiki());
    const { branch, merge } = mergePaging();
    const plan = planUpdate(store, await inputAt(repo, merge));
    expect(plan).toMatchObject({ from: first, to: merge, pr: 7 });
    expect(plan.commits.map((c) => c.sha)).toEqual([merge, branch]);
    expect([...plan.touched].sort()).toEqual(["src/signals/batch.py", "src/signals/ingest.py"]);
    expect(plan.baseline.sha).toBe(first);
    expect(plan.placement.decided.get("src/signals/batch.py")).toBe("signals");
    expect(knownFeature(plan)("src/signals/batch.py")).toBe("signals");
    expect(knownFeature(plan)("src/deliverables/crud.py")).toBe("deliverables");
  });

  it("reads no PR from a merge whose subject names none", async () => {
    ({ repo, store, first } = await builtWiki());
    repo.git("switch", "-q", "-c", "local");
    repo.write("src/signals/store.py", "def save_signal(signal):\n    return None\n");
    repo.commit("fix: drop the return");
    repo.git("switch", "-q", "main");
    const merge = repo.merge("local", "Merge branch 'local'");
    expect(planUpdate(store, await inputAt(repo, merge)).pr).toBeNull();
  });

  it("refuses an empty store, the head itself and a commit off the head's history", async () => {
    ({ repo, store, first } = await builtWiki());
    await expect(async () => planUpdate(store, await inputAt(repo, first))).rejects.toThrow(
      `the wiki is already at ${first}`,
    );
    repo.git("switch", "-q", "--orphan", "other");
    repo.write("README.md", "other\n");
    const other = repo.commit("chore: unrelated root");
    await expect(async () => planUpdate(store, await inputAt(repo, other))).rejects.toThrow(
      UpdateError,
    );
    const empty = openStore(":memory:");
    await expect(async () => planUpdate(empty, await inputAt(repo, other))).rejects.toThrow(
      "the store has no wiki yet",
    );
    empty.close();
  });
});

describe("planPages", () => {
  it("rewrites the page whose code changed and carries the other forward", async () => {
    ({ repo, store, first } = await builtWiki());
    const { merge } = mergePaging();
    const input = await inputAt(repo, merge);
    const plan = planUpdate(store, input);
    const { manifest, drifted } = measureDrift(plan, input.index, plan.placement.decided, 0.2);
    expect(manifest.membership["src/signals/batch.py"]?.featureId).toBe("signals");
    expect(drifted).toEqual(["signals"]);
    const pages = planPages(plan, store, input, manifest, new Set());
    expect(pages.carried).toEqual(["deliverables"]);
    expect(pages.whole).toEqual([]);
    expect(pages.rewrites.map((r) => r.featureId)).toEqual(["signals"]);
    const [signals] = pages.rewrites;
    expect(signals?.claims.map((c) => [c.key, c.claim.id, c.status])).toEqual([
      ["lead", "c1", "stale"],
      ["overview", "c2", "stale"],
      ["history", "c3", "fresh"],
    ]);
    expect(signals?.gaps.map((g) => [g.path, g.symbol])).toEqual([
      ["src/signals/batch.py", "drain"],
    ]);
    expect(signals?.membershipChanged).toBe(true);
  });

  it("makes a lead marked out of date a target of its page's call when the page is dirty anyway", async () => {
    ({ repo, store, first } = await builtWiki());
    const page = store.getCurrentRevision("signals");
    if (page === null) throw new Error("no page");
    store.putRevision({
      ...page,
      id: "signals-stale-lead",
      reason: "update",
      parentId: page.id,
      sections: page.sections.map((s) => ({
        ...s,
        claims: s.claims.map((c) => (s.key === "lead" ? { ...c, staleSince: first } : c)),
      })),
    });
    // A new file and nothing the page cites: the page is dirty for its gap alone.
    repo.write("src/signals/batch.py", "def drain(queue):\n    return list(queue)\n");
    const added = repo.commit("feat: drain signals");
    const input = await inputAt(repo, added);
    const plan = planUpdate(store, input);
    const { manifest } = measureDrift(plan, input.index, plan.placement.decided, 1);
    const [signals] = planPages(plan, store, input, manifest, new Set()).rewrites;
    expect(signals?.claims.map((c) => [c.claim.id, c.status])).toEqual([
      ["c1", "stale"],
      ["c2", "fresh"],
      ["c3", "fresh"],
    ]);
    expect(signals?.claims[0]?.reasons).toEqual([
      `it was marked out of date at ${first.slice(0, 7)}`,
    ]);
    expect(
      buildUpdatePack({ rewrite: signals as PageRewrite, manifest, ...input }).targets,
    ).toEqual(["c1"]);

    // A page nothing makes dirty keeps its marked lead as it is, and costs no call.
    const empty = repo.commit("chore: nothing");
    store.setHead(added);
    store.putManifest({ ...manifest, sha: added });
    const quiet = await inputAt(repo, empty);
    const next = planUpdate(store, quiet);
    const moved = measureDrift(next, quiet.index, next.placement.decided, 1).manifest;
    expect(planPages(next, store, quiet, moved, new Set()).carried).toContain("signals");
  });

  it("refuses, as an UpdateError, to measure drift while a new file has no feature", async () => {
    ({ repo, store, first } = await builtWiki());
    // A root-level file no import, co-change or directory signal places: it is disputed.
    repo.write("notes.py", "def note():\n    return 1\n");
    const added = repo.commit("feat: add notes");
    const input = await inputAt(repo, added);
    const plan = planUpdate(store, input);
    expect(plan.placement.disputed.map((d) => d.path)).toEqual(["notes.py"]);
    // Placement is not complete: the decided files alone leave notes.py without a feature.
    expect(() => measureDrift(plan, input.index, plan.placement.decided, 0.2)).toThrow(UpdateError);
    expect(() => measureDrift(plan, input.index, plan.placement.decided, 0.2)).toThrow(
      /no feature for the new file notes\.py/,
    );
    expect(
      measureDrift(plan, input.index, new Map([["notes.py", "deliverables"]]), 0.2).manifest
        .membership["notes.py"]?.featureId,
    ).toBe("deliverables");
  });

  it("aborts with an UpdateError naming a citation sha git does not know", async () => {
    ({ repo, store, first } = await builtWiki());
    const page = store.listCurrentRevisions().find((r) => r.featureId === "signals");
    const ghost = "f".repeat(40);
    store.putRevision({
      ...(page as NonNullable<typeof page>),
      id: "signals-ghost",
      reason: "update",
      parentId: page?.id ?? null,
      sections: (page?.sections ?? []).map((section) => ({
        ...section,
        claims: section.claims.map((claim) => ({
          ...claim,
          citations: claim.citations.map((c) => (c.kind === "code" ? { ...c, sha: ghost } : c)),
        })),
      })),
    });
    const { merge } = mergePaging();
    const input = await inputAt(repo, merge);
    const plan = planUpdate(store, input);
    const { manifest } = measureDrift(plan, input.index, plan.placement.decided, 0.2);
    expect(() => planPages(plan, store, input, manifest, new Set())).toThrow(
      new RegExp(`${ghost}.*cannot diff`),
    );
  });

  it("writes whole the features the operations changed, and carries everything on an empty diff", async () => {
    ({ repo, store, first } = await builtWiki());
    repo.git("commit", "-q", "--allow-empty", "-m", "chore: nothing");
    const empty = repo.git("rev-parse", "HEAD").trim();
    const input = await inputAt(repo, empty);
    const plan = planUpdate(store, input);
    expect(plan.changes).toEqual([]);
    const { manifest, drifted } = measureDrift(plan, input.index, new Map(), 0.2);
    expect(drifted).toEqual([]);
    expect(planPages(plan, store, input, manifest, new Set())).toMatchObject({
      rewrites: [],
      whole: [],
      carried: ["deliverables", "signals"],
    });
    expect(planPages(plan, store, input, manifest, new Set(["signals"]))).toMatchObject({
      rewrites: [],
      whole: ["signals"],
      carried: ["deliverables"],
    });
  });
});
