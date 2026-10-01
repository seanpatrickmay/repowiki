import { describe, expect, it } from "vitest";
import { articleView } from "./article.ts";
import { formatDate, formatNumber } from "./format.ts";
import { buildSiteModel } from "./model.ts";
import { fixtureExport } from "./test-fixtures.ts";

const REPO = "https://github.com/acme/demo-repo";
const site = buildSiteModel(fixtureExport(), REPO);
const page = (id: string) => {
  const revision = site.pages.get(id);
  if (revision === undefined) throw new Error(`no page ${id}`);
  return revision;
};

describe("formatDate and formatNumber", () => {
  it("reads the date as written, whatever the offset", () => {
    expect(formatDate("2026-03-10T23:30:00-08:00")).toBe("10 March 2026");
    expect(formatDate("2026-01-01T00:10:00+14:00")).toBe("1 January 2026");
  });

  it("groups thousands", () => {
    expect(formatNumber(1312)).toBe("1,312");
  });
});

describe("articleView", () => {
  const view = articleView(site, page("signals"));

  it("builds the table of contents from stored sections, then See also and References", () => {
    expect(view.toc.map((entry) => entry.title)).toEqual([
      "Overview",
      "How it works",
      "Data flow",
      "History",
      "Known limitations",
      "See also",
      "References",
    ]);
  });

  it("flags only sections that hold a stale claim", () => {
    expect(view.sections.filter((s) => s.stale).map((s) => s.anchor)).toEqual(["how-it-works"]);
    expect(view.leadStale).toBe(false);
  });

  it("marks the lead stale when a claim it supports is stale", () => {
    const revision = page("signals");
    const [lead, ...rest] = revision.sections;
    if (lead === undefined) throw new Error("no lead");
    const leadClaims = lead.claims.map((claim) => ({ ...claim, supports: ["s-h1"] }));
    const stale = articleView(site, {
      ...revision,
      sections: [{ ...lead, claims: leadClaims }, ...rest],
    });
    expect(stale.leadStale).toBe(true);
  });

  it("drops See also entries that have no page", () => {
    expect(view.seeAlso).toEqual([{ href: "/wiki/deliverables/", title: "Deliverables" }]);
  });

  it("fills the infobox from the revision and the feature's aliases", () => {
    expect(view.infobox.map((row) => [row.label, row.html])).toEqual([
      ["Also known as", "signal pipeline, SIGNALS_TABLE, /api/signals"],
      ["Files", "4"],
      ["Lines of code", "1,312"],
      ["Languages", "Python, TypeScript"],
      ["Entry points", "<code>src/signals/ingest.py</code><br><code>src/signals/api.ts</code>"],
      ["First commit", "26 January 2026"],
      ["Last commit", "10 March 2026"],
      [
        "Revision",
        `<a class="external" href="${REPO}/commit/${"b".repeat(40)}"><code>bbbbbbb</code></a> (PR #88)`,
      ],
    ]);
  });

  it("dates the page by its commit, not its generation time", () => {
    expect(view.lastEdited).toMatch(/^This page was last edited on 10 March 2026, at commit /);
  });

  it("omits an empty alias row and adds a notice for a retired feature", () => {
    const retired = articleView(site, page("exporter"));
    expect(retired.infobox.map((row) => row.label)).not.toContain("Also known as");
    expect(retired.notice).toBe(
      "This feature was retired at commit <code>ccccccc</code>. The article describes it as of its last revision.",
    );
    expect(view.notice).toBeNull();
  });
});
