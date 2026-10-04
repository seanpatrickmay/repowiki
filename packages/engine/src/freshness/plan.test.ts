import { INGEST_PY } from "@repowiki/core/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import type { TestRepo } from "../index/index.ts";
import { openStore, type Store } from "../store/index.ts";
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
