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
});
