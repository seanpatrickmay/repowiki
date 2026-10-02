import type { Revision } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import {
  diffRoutes,
  diffView,
  hasHistory,
  historyPage,
  historyRows,
  oldRevisionNotice,
  oldRevisionRoutes,
  oldRevisionView,
  revisionLabelHtml,
} from "./history.ts";
import { escapeHtml } from "./inline.ts";
import { buildSiteModel } from "./model.ts";
import { fixtureExport, HOSTILE_TITLE } from "./test-fixtures.ts";

const REPO = "https://github.com/acme/demo-repo";
const site = buildSiteModel(fixtureExport(), REPO);
const [first, second] = site.history.get("signals") ?? [];
if (first === undefined || second === undefined) throw new Error("fixture needs two revisions");

describe("historyRows", () => {
  it("lists revisions newest first, dated by commit, with diff links after the first", () => {
    expect(historyRows(site, "signals")).toEqual([
      {
        n: 2,
        date: "10 March 2026",
        oldHref: "/wiki/signals/history/2/",
        diffHref: "/wiki/signals/diff/2/",
        summaryHtml: `update (<a class="external" href="${REPO}/pull/88">PR #88</a>)`,
        commitHtml: `<a class="external" href="${REPO}/commit/${"b".repeat(40)}"><code>bbbbbbb</code></a>`,
        cost: "claude-haiku-4-5, 1,200 in / 300 out tokens",
      },
      {
        n: 1,
        date: "3 February 2026",
        oldHref: "/wiki/signals/history/1/",
        diffHref: null,
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

describe("historyRows with a hostile reason", () => {
  it("escapes a reason that bypasses the schema enum, with and without a PR", () => {
    const reason = "<img src=x onerror=alert(1)> \"q\" & 'p'" as Revision["reason"];
    const escaped = "&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &#39;p&#39;";
    const hostile = {
      ...site,
      history: new Map([
        [
          "signals",
          [
            { ...first, reason, pr: null },
            { ...second, reason },
          ],
        ],
      ]),
    };
    const [withPr, withoutPr] = historyRows(hostile, "signals");
    expect(withPr?.summaryHtml).toBe(
      `${escaped} (<a class="external" href="${REPO}/pull/88">PR #88</a>)`,
    );
    expect(withoutPr?.summaryHtml).toBe(escaped);
  });
});

describe("oldRevisionNotice and revisionLabelHtml", () => {
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

  it("labels a revision for the diff header", () => {
    expect(revisionLabelHtml(plain, first, 1)).toBe(
      '<a href="/wiki/signals/history/1/">Revision as of 3 February 2026</a> (commit <code>aaaaaaa</code>)',
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

  it("keeps the retired banner after the old-revision notice for a retired feature", () => {
    const view = oldRevisionView(site, "exporter", 1);
    const [exporter] = site.history.get("exporter") ?? [];
    if (exporter === undefined) throw new Error("fixture needs an exporter revision");
    expect(view.notice).toBe(
      `${oldRevisionNotice(site, exporter)}<br>This feature was retired at commit <code>ccccccc</code>. The article describes it as of its last revision.`,
    );
  });

  it("shows only the old-revision notice for a feature that is not retired", () => {
    expect(oldRevisionView(site, "signals", 1).notice).toBe(oldRevisionNotice(site, first));
  });

  it("throws on a revision that does not exist", () => {
    expect(() => oldRevisionView(site, "signals", 0)).toThrow("no revision 0 of signals");
    expect(() => oldRevisionView(site, "signals", 3)).toThrow("no revision 3 of signals");
    expect(() => oldRevisionView(site, "scheduler", 1)).toThrow("no revision 1 of scheduler");
  });
});

describe("diffRoutes", () => {
  it("has one route per revision after the first, numbered from the oldest", () => {
    const signals = diffRoutes(site).filter((route) => route.featureId === "signals");
    expect(signals).toEqual([{ featureId: "signals", n: 2 }]);
  });

  it("covers every revision but the first of every feature with history", () => {
    const expected = [...site.history.values()].reduce((sum, rows) => sum + rows.length - 1, 0);
    expect(diffRoutes(site)).toHaveLength(expected);
  });

  it("skips a feature whose history page does not exist", () => {
    const orphan = {
      ...site,
      history: new Map([["no-such-feature", [first, second]]]),
    };
    expect(diffRoutes(orphan)).toEqual([]);
  });
});

describe("diffView", () => {
  const template = first.sections.flatMap((section) => section.claims)[0];
  if (template === undefined) throw new Error("fixture needs a claim");

  it("diffs a revision against its parent under labelled headers", () => {
    const view = diffView(site, "signals", 2);
    expect(view.title).toBe("Signal ingestion");
    expect(view.beforeHtml).toBe(revisionLabelHtml(site, first, 1));
    expect(view.afterHtml).toBe(revisionLabelHtml(site, second, 2));
    expect(view.sections.map((section) => section.title)).toEqual([
      "Lead",
      "Overview",
      "How it works",
      "Data flow",
      "History",
      "Known limitations",
    ]);
    const overview = view.sections[1];
    expect(overview?.rows[0]).toEqual({
      kind: "changed",
      sign: "~",
      label: "Changed",
      html: expect.stringContaining("Signals are <del>built</del><ins>created</ins> from"),
    });
  });

  it("gives each row a sign and a visually hidden label for its kind", () => {
    const rows = diffView(site, "signals", 2).sections.flatMap((section) => section.rows);
    expect(rows.find((row) => row.kind === "added")).toMatchObject({ sign: "+", label: "Added" });
    // Reversing the history turns the additions into removals.
    const reversed = { ...site, history: new Map([["signals", [second, first]]]) };
    const reversedRows = diffView(reversed, "signals", 2).sections.flatMap((s) => s.rows);
    expect(reversedRows.find((row) => row.kind === "removed")).toMatchObject({
      sign: "-",
      label: "Removed",
    });
  });

  describe("with a hostile feature title and hostile claim text", () => {
    const BEFORE_ONLY = "removed <img src=x onerror=alert(1)> \"q\" & 'p'";
    const SHARED = "shared <script>alert(1)</script> \"q\" & 'p'";
    const AFTER_ONLY = "added <iframe src=x></iframe> \"q\" & 'p'";
    const claim = (text: string) => ({ ...template, text });
    const revision = (base: Revision, sections: Revision["sections"]): Revision => ({
      ...base,
      featureId: "hostile-title",
      sections,
    });
    const hostile = {
      ...site,
      history: new Map([
        [
          "hostile-title",
          [
            revision(first, [
              { key: "lead", claims: [claim("plain <b>one</b>")] },
              { key: "overview", claims: [claim(SHARED), claim(BEFORE_ONLY)] },
            ]),
            revision(second, [
              { key: "lead", claims: [claim(HOSTILE_TITLE)] },
              { key: "overview", claims: [claim(SHARED)] },
              { key: "how-it-works", claims: [claim(AFTER_ONLY)] },
            ]),
          ],
        ],
      ]),
    };
    const view = diffView(hostile, "hostile-title", 2);
    const rows = view.sections.flatMap((section) => section.rows);

    it("keeps the title as plain text for the template to escape", () => {
      expect(view.title).toBe(HOSTILE_TITLE);
    });

    it("escapes the text of every kind of row", () => {
      expect(rows.map((row) => row.kind).sort()).toEqual([
        "added",
        "changed",
        "context",
        "removed",
      ]);
      const html = (kind: string) => rows.find((row) => row.kind === kind)?.html;
      expect(html("context")).toBe(escapeHtml(SHARED));
      expect(html("removed")).toBe(escapeHtml(BEFORE_ONLY));
      expect(html("added")).toBe(escapeHtml(AFTER_ONLY));
      // The word diff splits the text, so the escaped pieces are checked separately.
      expect(html("changed")).toContain("<ins>&lt;img</ins>");
      expect(html("changed")).toContain("alert(1)&gt;");
    });

    it("leaves no raw markup in any row", () => {
      const all = rows.map((row) => row.html).join("");
      expect(all.replace(/<\/?(del|ins)>/g, "")).not.toMatch(/[<>]/);
    });
  });

  it("falls back to one deletion and one insertion for claims too large to word-diff", () => {
    const words = (prefix: string, hostile: string) =>
      [hostile, ...Array.from({ length: 3_000 }, (_, i) => `${prefix}${i}`)].join(" ");
    const claimsOf = (revision: Revision, text: string): Revision => ({
      ...revision,
      sections: [{ key: "overview", claims: [{ ...template, text }] }],
    });
    const big = {
      ...site,
      history: new Map([
        [
          "signals",
          [claimsOf(first, words("a", "<i>old</i>")), claimsOf(second, words("b", "<u>new</u>"))],
        ],
      ]),
    };
    const rows = diffView(big, "signals", 2).sections.flatMap((section) => section.rows);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.kind).toBe("changed");
    expect(row?.html.match(/<del>/g)).toHaveLength(1);
    expect(row?.html.match(/<ins>/g)).toHaveLength(1);
    expect(row?.html).toContain("&lt;i&gt;old&lt;/i&gt;");
    expect(row?.html).toContain("&lt;u&gt;new&lt;/u&gt;");
    expect(row?.html).not.toMatch(/<(i|u)>/);
  });

  it("has no sections when only the reason, sources or tokens differ", () => {
    const view = diffView(site, "deliverables", 2);
    expect(view.sections).toEqual([]);
    expect(view.title).toBe("Deliverables");
  });

  it("throws before the second revision and on a revision that does not exist", () => {
    expect(() => diffView(site, "signals", 1)).toThrow("no revision 1 to diff of signals");
    expect(() => diffView(site, "signals", 0)).toThrow("no revision 0 to diff of signals");
    expect(() => diffView(site, "signals", 3)).toThrow("no revision 3 to diff of signals");
    expect(() => diffView(site, "scheduler", 2)).toThrow("no revision 2 to diff of scheduler");
  });
});
