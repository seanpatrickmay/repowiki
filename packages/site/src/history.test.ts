import { describe, expect, it } from "vitest";
import {
  hasHistory,
  historyPage,
  historyRows,
  oldRevisionNotice,
  oldRevisionRoutes,
  oldRevisionView,
} from "./history.ts";
import { buildSiteModel } from "./model.ts";
import { fixtureExport, HOSTILE_TITLE } from "./test-fixtures.ts";

const REPO = "https://github.com/acme/demo-repo";
const site = buildSiteModel(fixtureExport(), REPO);
const [first, second] = site.history.get("signals") ?? [];
if (first === undefined || second === undefined) throw new Error("fixture needs two revisions");

describe("historyRows", () => {
  it("lists revisions newest first, dated by commit", () => {
    expect(historyRows(site, "signals")).toEqual([
      {
        n: 2,
        date: "10 March 2026",
        oldHref: "/wiki/signals/history/2/",
        summaryHtml: `update (<a class="external" href="${REPO}/pull/88">PR #88</a>)`,
        commitHtml: `<a class="external" href="${REPO}/commit/${"b".repeat(40)}"><code>bbbbbbb</code></a>`,
        cost: "claude-haiku-4-5, 1,200 in / 300 out tokens",
      },
      {
        n: 1,
        date: "3 February 2026",
        oldHref: "/wiki/signals/history/1/",
        summaryHtml: "build",
        commitHtml: `<a class="external" href="${REPO}/commit/${"a".repeat(40)}"><code>aaaaaaa</code></a>`,
        cost: "claude-haiku-4-5, 1,200 in / 300 out tokens",
      },
    ]);
  });

  it("is empty for a feature with no revisions", () => {
    expect(historyRows(site, "scheduler")).toEqual([]);
  });

  it("leaves the PR and commit unlinked when the repo URL is unknown", () => {
    const plain = buildSiteModel(fixtureExport(), null);
    const [newest] = historyRows(plain, "signals");
    expect(newest?.summaryHtml).toBe("update (PR #88)");
    expect(newest?.commitHtml).toBe("<code>bbbbbbb</code>");
  });

  it("escapes a hostile repo URL in every link it builds", () => {
    const hostile = buildSiteModel(fixtureExport(), 'https://x.test/a"><img src=x onerror=1>');
    const [newest] = historyRows(hostile, "signals");
    for (const html of [newest?.summaryHtml, newest?.commitHtml]) {
      expect(html).toContain('href="https://x.test/a&quot;&gt;&lt;img src=x onerror=1&gt;/');
      expect(html).not.toContain("<img");
    }
  });
});

describe("oldRevisionNotice", () => {
  const plain = buildSiteModel(fixtureExport(), null);

  it("warns on an old revision and links the current one", () => {
    expect(oldRevisionNotice(plain, first)).toBe(
      'This is an old revision of this page, as of 3 February 2026 (commit <code>aaaaaaa</code>). It may differ significantly from the <a href="/wiki/signals/">current revision</a>.',
    );
  });

  it("says so when the revision is the current one", () => {
    expect(oldRevisionNotice(plain, second)).toBe(
      "This is the current revision of this page, as of 10 March 2026 (commit <code>bbbbbbb</code>).",
    );
  });
});

describe("hasHistory", () => {
  it("is true for articles and redirects that have revisions", () => {
    expect(hasHistory(site, "signals")).toBe(true);
    expect(hasHistory(site, "legacy-signals")).toBe(true);
  });

  it("is false for a page with no revisions or no history", () => {
    expect(hasHistory(site, "reports")).toBe(false);
    expect(hasHistory(site, "scheduler")).toBe(false);
    expect(hasHistory(site, "no-such-feature")).toBe(false);
  });
});

describe("historyPage", () => {
  it("titles the page by the feature and lists its rows", () => {
    const page = historyPage(site, "signals");
    expect(page.title).toBe("Signal ingestion");
    expect(page.rows.map((row) => row.n)).toEqual([2, 1]);
  });

  it("keeps a hostile feature title as plain text for the template to escape", () => {
    expect(historyPage(site, "hostile-title").title).toBe(HOSTILE_TITLE);
  });
});

describe("oldRevisionRoutes", () => {
  it("has one route per revision, numbered from the oldest", () => {
    const signals = oldRevisionRoutes(site).filter((route) => route.featureId === "signals");
    expect(signals).toEqual([
      { featureId: "signals", n: 1 },
      { featureId: "signals", n: 2 },
    ]);
  });

  it("covers every revision of every feature with history", () => {
    const expected = [...site.history.values()].reduce((sum, rows) => sum + rows.length, 0);
    expect(oldRevisionRoutes(site)).toHaveLength(expected);
  });
});

describe("oldRevisionView", () => {
  it("renders the numbered revision under the old-revision notice", () => {
    const view = oldRevisionView(site, "signals", 1);
    expect(view.featureId).toBe("signals");
    expect(view.title).toBe("Signal ingestion");
    expect(view.notice).toBe(oldRevisionNotice(site, first));
    expect(view.leadHtml).toBe("<b>Signal ingestion</b> turns chunks into signals.");
    expect(view.sections[0]?.html).toContain("Signals are built from chunks.");
  });

  it("throws on a revision that does not exist", () => {
    expect(() => oldRevisionView(site, "signals", 0)).toThrow("no revision 0 of signals");
    expect(() => oldRevisionView(site, "signals", 3)).toThrow("no revision 3 of signals");
    expect(() => oldRevisionView(site, "scheduler", 1)).toThrow("no revision 1 of scheduler");
  });
});
