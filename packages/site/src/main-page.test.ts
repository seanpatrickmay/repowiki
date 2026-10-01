import { SHA_C } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { didYouKnowText, mainPageView, rotation } from "./main-page.ts";
import { buildSiteModel } from "./model.ts";
import { fixtureExport, HOSTILE_TITLE } from "./test-fixtures.ts";

const site = buildSiteModel(fixtureExport(), null);

describe("rotation", () => {
  it("is seeded by the head sha and stays in range", () => {
    expect(rotation(SHA_C, 3)).toBe(0);
    expect(rotation("0000000500000000000000000000000000000000", 3)).toBe(2);
    expect(rotation(SHA_C, 0)).toBe(0);
  });
});

describe("didYouKnowText", () => {
  it.each([
    ["Signals are built from chunks.", "... that signals are built from chunks?"],
    ["API keys rotate daily.", "... that API keys rotate daily?"],
    ["`ingest_chunk` retries twice", "... that `ingest_chunk` retries twice?"],
    ["Is it cached?", "... that is it cached?"],
  ])("turns %j into %j", (text, hook) => {
    expect(didYouKnowText(text)).toBe(hook);
  });
});

describe("mainPageView", () => {
  const view = mainPageView(site);

  it("counts active articles and features one chosen by the head sha", () => {
    // Active features with a page: deliverables, hostile-title and signals (scheduler has none).
    expect(view.articleCount).toBe(3);
    expect(view.featured).toEqual({
      href: "/wiki/deliverables/",
      title: "Deliverables",
      leadHtml: "<b>Deliverables</b> are the records that Signal ingestion feed.",
    });
  });

  it("draws Did you know from hook claims of active articles", () => {
    expect(view.didYouKnow.map((item) => [item.title, item.html])).toEqual([
      [
        "Deliverables",
        "... that deliverables are stored as rows in the <code>deliverables</code> table?",
      ],
      [
        "Signal ingestion",
        "... that signals are created from ingested chunks by <code>ingest_chunk</code>?",
      ],
      ["Signal ingestion", "... that signal ingestion was introduced in PR #45?"],
    ]);
  });

  it("lists recently updated articles newest first, by commit date", () => {
    // Redirects (legacy-signals) are left out; the retired exporter and the hostile title are in.
    expect(view.recent).toEqual([
      { href: "/wiki/signals/", title: "Signal ingestion", date: "10 March 2026" },
      { href: "/wiki/hostile-title/", title: HOSTILE_TITLE, date: "25 February 2026" },
      { href: "/wiki/deliverables/", title: "Deliverables", date: "20 February 2026" },
      { href: "/wiki/exporter/", title: "CSV exporter", date: "15 January 2026" },
    ]);
  });

  it("breaks commit-date ties by feature id, whatever order the pages arrive in", () => {
    const base = fixtureExport();
    const tied = "2026-02-20T11:00:00-05:00";
    const withTie = (pages: typeof base.pages) => {
      const model = buildSiteModel({ ...base, pages }, null);
      return mainPageView(model).recent.map((item) => item.href);
    };
    const pages = base.pages.map((page) =>
      page.featureId === "hostile-title" ? { ...page, commitDate: tied } : page,
    );
    const expected = [
      "/wiki/signals/",
      "/wiki/deliverables/",
      "/wiki/hostile-title/",
      "/wiki/exporter/",
    ];
    expect(withTie(pages)).toEqual(expected);
    expect(withTie([...pages].reverse())).toEqual(expected);
  });

  it("asks for a hover preview in a hook's links only where one is served", () => {
    const base = fixtureExport();
    const pages = base.pages.map((page) =>
      page.featureId === "deliverables"
        ? {
            ...page,
            sections: page.sections.map((section) => ({
              ...section,
              claims: section.claims.map((claim) =>
                claim.hook
                  ? { ...claim, text: "[[signals]] and [[legacy-signals]] feed [[scheduler]]." }
                  : claim,
              ),
            })),
          }
        : page,
    );
    const [first] = mainPageView(buildSiteModel({ ...base, pages }, null)).didYouKnow;
    expect(first?.html).toBe(
      '... that <a class="wikilink" href="/wiki/signals/" title="Signal ingestion" data-preview="signals">Signal ingestion</a> and <a class="wikilink" href="/wiki/legacy-signals/" title="Legacy signals" data-preview="legacy-signals">Legacy signals</a> feed scheduler?',
    );
  });

  it("copes with a site that has no articles", () => {
    const base = fixtureExport();
    const empty = mainPageView(buildSiteModel({ ...base, pages: [], history: {} }, null));
    expect(empty).toEqual({ articleCount: 0, featured: null, didYouKnow: [], recent: [] });
  });
});
