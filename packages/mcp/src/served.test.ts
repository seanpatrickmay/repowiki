import { type HistoryWiki, historyWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_AS_OF_VIEWS, serveWiki } from "./served.ts";

let h: HistoryWiki;
beforeAll(() => {
  h = historyWiki();
});
afterAll(() => h.repo.remove());

describe("serveWiki", () => {
  it("serves the export's view, search index and head date", () => {
    const served = serveWiki(h.wiki, { repo: h.repo.dir, pinned: null });
    expect(served.view.pages.get("signals")?.id).toBe("signals-3");
    expect(served.index.search("export_deliverable", 8)[0]).toBe("deliverables");
    expect(served.headDate).toBe("2026-01-04");
    expect(served.pinned).toBe(false);
    expect(served.reloadProblem).toBeNull();
    expect(served.freshness.status().compare).toBe(h.commits.after);
  });

  it("resolves a hex prefix, and answers isAncestor with a commit it lacks as false", () => {
    const served = serveWiki(h.wiki, { repo: h.repo.dir, pinned: h.sha });
    expect(served.resolveCommit(h.commits.first.slice(0, 7))).toBe(h.commits.first);
    expect(served.resolveCommit("fffffff")).toBeNull();
    expect(served.isAncestor(h.commits.first, h.sha)).toBe(true);
    expect(served.isAncestor(h.sha, h.commits.first)).toBe(false);
    expect(served.isAncestor("f".repeat(40), h.sha)).toBe(false);
    expect(served.pinned).toBe(true);
  });

  it("keeps the views of the last MAX_AS_OF_VIEWS points, newest use last", () => {
    const served = serveWiki(h.wiki, { repo: h.repo.dir, pinned: null });
    const first = served.at({ kind: "date", date: "2026-01-02" });
    expect(served.at({ kind: "date", date: "2026-01-02" })).toBe(first);
    expect(first.view.pages.get("signals")?.id).toBe("signals-1");
    expect(first.index.search("deliverables", 8)).toEqual([]);
    for (let day = 10; day < 10 + MAX_AS_OF_VIEWS; day++) {
      served.at({ kind: "date", date: `2026-01-${day}` });
    }
    expect(served.at({ kind: "date", date: "2026-01-02" })).not.toBe(first);
  });

  it("evicts the least recently used point: a view used again is kept", () => {
    const served = serveWiki(h.wiki, { repo: h.repo.dir, pinned: null });
    const day = (n: number) => ({
      kind: "date" as const,
      date: `2026-02-${String(n).padStart(2, "0")}`,
    });
    const first = served.at(day(1));
    const second = served.at(day(2));
    for (let n = 3; n <= MAX_AS_OF_VIEWS; n++) served.at(day(n));
    expect(served.at(day(1))).toBe(first);
    served.at(day(MAX_AS_OF_VIEWS + 1));
    expect(served.at(day(1))).toBe(first);
    expect(served.at(day(2))).not.toBe(second);
  });

  it("builds its search index and freshness once, on first use, and runs no git before", () => {
    const served = serveWiki(h.wiki, { repo: "/nonexistent/repowiki-repo", pinned: null });
    expect(served.index).toBe(served.index);
    const freshness = served.freshness;
    expect(served.freshness).toBe(freshness);
    expect(freshness.status()).toMatchObject({ known: false });
  });
});
