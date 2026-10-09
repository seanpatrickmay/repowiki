import { GitError, GitTimeoutError } from "@repowiki/engine";
import { type HistoryWiki, historyWiki } from "@repowiki/query/test-wiki";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GIT_TIMEOUT_MS } from "./git.ts";
import { serveWiki } from "./served.ts";

// engine's git calls, spied: each still runs the real function unless a test says otherwise.
const spies = vi.hoisted(() => ({
  isAncestor: vi.fn(),
  diffCommits: vi.fn(),
}));
vi.mock("@repowiki/engine", async (importOriginal) => {
  const real: typeof import("@repowiki/engine") = await importOriginal();
  spies.isAncestor.mockImplementation(real.isAncestor);
  spies.diffCommits.mockImplementation(real.diffCommits);
  return { ...real, isAncestor: spies.isAncestor, diffCommits: spies.diffCommits };
});

let h: HistoryWiki;
beforeAll(() => {
  h = historyWiki();
});
afterAll(() => h.repo.remove());
afterEach(() => {
  spies.isAncestor.mockClear();
  spies.diffCommits.mockClear();
});

describe("the served wiki's engine git calls", () => {
  it("give isAncestor and the marks' diffCommits GIT_TIMEOUT_MS", () => {
    const served = serveWiki(h.wiki, { repo: h.repo.dir, pinned: null });
    expect(served.isAncestor(h.commits.first, h.sha)).toBe(true);
    expect(spies.isAncestor).toHaveBeenCalledWith(h.repo.dir, h.commits.first, h.sha, {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const page = h.wiki.pages.find((p) => p.featureId === "signals");
    if (page === undefined) throw new Error("fixture");
    expect(served.freshness.marks(page.id, page.sections).size).toBeGreaterThan(0);
    expect(spies.diffCommits).toHaveBeenCalled();
    for (const call of spies.diffCommits.mock.calls) {
      expect(call[4]).toEqual({ timeoutMs: GIT_TIMEOUT_MS });
    }
  });

  it("caches only answers: a timeout is thrown and asked again, a missing commit is not kept", () => {
    const served = serveWiki(h.wiki, { repo: h.repo.dir, pinned: null });
    spies.isAncestor.mockImplementationOnce(() => {
      throw new GitTimeoutError("git merge-base timed out after 10000 ms in /repo");
    });
    expect(() => served.isAncestor(h.commits.first, h.sha)).toThrow(GitTimeoutError);
    expect(served.isAncestor(h.commits.first, h.sha)).toBe(true);
    expect(served.isAncestor(h.commits.first, h.sha)).toBe(true);
    expect(spies.isAncestor).toHaveBeenCalledTimes(2);

    spies.isAncestor.mockClear();
    const missing = "f".repeat(40);
    expect(served.isAncestor(missing, h.sha)).toBe(false);
    expect(served.isAncestor(missing, h.sha)).toBe(false);
    expect(spies.isAncestor).toHaveBeenCalledTimes(2);
    expect(spies.isAncestor.mock.results[0]?.type).toBe("throw");
    expect(spies.isAncestor.mock.results[0]?.value).toBeInstanceOf(GitError);
  });
});
