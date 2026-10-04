import type { Manifest } from "@repowiki/core";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Every diffCommits call planUpdate and planPages make, as [from, to]. */
const diffs = vi.hoisted(() => ({ calls: [] as [string, string][] }));
vi.mock("../index/index.ts", async (importOriginal) => {
  const index = await importOriginal<typeof import("../index/index.ts")>();
  return {
    ...index,
    diffCommits: (repo: string, from: string, to: string) => {
      diffs.calls.push([from, to]);
      return index.diffCommits(repo, from, to);
    },
  };
});

const { measureDrift, planPages, planUpdate } = await import("./plan.ts");
const { builtWiki, inputAt } = await import("./test-wiki-repo.ts");

let cleanup: () => void = () => {};
afterEach(() => cleanup());

describe("planPages", () => {
  it("reads the diff from each citation's sha once, however many citations name it", async () => {
    const { repo, store, first } = await builtWiki();
    cleanup = () => {
      store.close();
      repo.remove();
    };
    // The head moves on with no page changed, so every citation still names `first`.
    const later = repo.commit("chore: nothing");
    store.putManifest({ ...(store.getManifest(first) as Manifest), sha: later });
    store.setHead(later);
    repo.write("src/signals/store.py", "def save_signal(signal):\n    return None\n");
    const target = repo.commit("fix: drop the return");
    const input = await inputAt(repo, target);
    diffs.calls = [];
    const plan = planUpdate(store, input);
    const { manifest } = measureDrift(plan, input.index, plan.placement.decided, 1);
    planPages(plan, store, input, manifest, new Set());
    // One diff from the head (the plan's), and one from `first`, for both pages' citations.
    expect(diffs.calls).toEqual([
      [later, target],
      [first, target],
    ]);
  });
});
