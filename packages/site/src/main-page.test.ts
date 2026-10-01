import { SHA_C } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  allPagesEntries,
  articleCountText,
  didYouKnowText,
  mainPageView,
  randomTargets,
  rotation,
} from "./main-page.ts";
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
    ["Wait...", "... that wait?"],
    ["Wait\u2026", "... that wait?"],
    ["Does it work?!", "... that does it work?"],
    ["Ends with colon:", "... that ends with colon?"],
    ["Stops!!", "... that stops?"],
    ['Uses "x."', '... that uses "x"?'],
    ['Uses "x".', '... that uses "x"?'],
    ["Uses \u201cx.\u201d", "... that uses \u201cx\u201d?"],
    ["Calls (the api.)", "... that calls (the api)?"],
    ["  Padded text.  ", "... that padded text?"],
  ])("turns %j into %j", (text, hook) => {
    expect(didYouKnowText(text)).toBe(hook);
  });

  it.each(["", "   ", ".", "?!", "...", ":", '"."'])("has no hook for %j", (text) => {
    expect(didYouKnowText(text)).toBeNull();
  });
});

describe("articleCountText", () => {
  it.each([
    [0, "0 articles."],
    [1, "1 article."],
    [2, "2 articles."],
  ])("writes %j as %j", (count, text) => {
    expect(articleCountText(count)).toBe(text);
  });
});

describe("mainPageView", () => {
  const view = mainPageView(site);

  it("counts active articles and features one chosen by the head sha", () => {
    // Active features with a page: deliverables, hostile-title and signals (scheduler has none).
    expect(view.articleCount).toBe(3);
    expect(view.featured).toEqual({
      href: "/wiki/deliverables/",
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

  it("rotates the featured article and the hooks with the head sha", () => {
    // 0x00000001 % 3 === 1: the second active article, and the hooks start at the second one.
    const head = `00000001${"0".repeat(32)}`;
    const rotated = mainPageView(buildSiteModel({ ...fixtureExport(), head }, null));
    expect(rotated.featured).toEqual({
      href: "/wiki/hostile-title/",
      leadHtml: "She said &quot;hi&quot; and it&#39;s fine.",
    });
    expect(rotated.featured?.leadHtml).not.toContain("<img");
    expect(rotated.didYouKnow.map((item) => item.html)).toEqual([
      "... that signals are created from ingested chunks by <code>ingest_chunk</code>?",
      "... that signal ingestion was introduced in PR #45?",
      "... that deliverables are stored as rows in the <code>deliverables</code> table?",
    ]);
  });

  it("escapes a hostile hook and skips a hook with no text", () => {
    const base = fixtureExport();
    const hook = (text: string) => ({ ...base.pages[0]?.sections[1]?.claims[0], text, hook: true });
    const pages = base.pages.map((page) =>
      page.featureId === "hostile-title"
        ? {
            ...page,
            sections: page.sections.map((section) =>
              section.key === "overview"
                ? {
                    ...section,
                    claims: [hook("<img src=x onerror=alert(1)> & co."), hook("..."), hook("  ")],
                  }
                : section,
            ),
          }
        : page,
    );
    const model = buildSiteModel({ ...base, pages } as typeof base, null);
    const htmls = mainPageView(model).didYouKnow.map((item) => item.html);
    expect(htmls).toContain("... that &lt;img src=x onerror=alert(1)&gt; &amp; co?");
    expect(htmls.join("")).not.toContain("<img");
    expect(htmls.filter((html) => html === "... that ?")).toEqual([]);
  });

  it("lists by the written calendar date first, so the list never contradicts the dates shown", () => {
    const base = fixtureExport();
    const dates: Record<string, string> = {
      // 2026-03-11T08:00+14:00 is 2026-03-10T18:00Z; 2026-03-10T23:30-10:00 is 2026-03-11T09:30Z.
      // By instant signals is newer; by the date shown, deliverables (11 March) is.
      signals: "2026-03-10T23:30:00-10:00",
      deliverables: "2026-03-11T08:00:00+14:00",
    };
    const pages = base.pages.map((page) => ({
      ...page,
      commitDate: dates[page.featureId] ?? page.commitDate,
    }));
    const recent = mainPageView(buildSiteModel({ ...base, pages }, null)).recent;
    expect(recent.slice(0, 2).map((item) => [item.href, item.date])).toEqual([
      ["/wiki/deliverables/", "11 March 2026"],
      ["/wiki/signals/", "10 March 2026"],
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

describe("randomTargets", () => {
  it("lists the URLs of active features with a page, sorted by id", () => {
    expect(randomTargets(site)).toEqual([
      "/wiki/deliverables/",
      "/wiki/hostile-title/",
      "/wiki/signals/",
    ]);
  });

  it("is empty for a site without pages", () => {
    const base = fixtureExport();
    expect(randomTargets(buildSiteModel({ ...base, pages: [], history: {} }, null))).toEqual([]);
  });
});

describe("allPagesEntries", () => {
  it("lists every routed feature by title with its status note", () => {
    // Punctuation sorts first, so the hostile title leads.
    expect(allPagesEntries(site)).toEqual([
      { href: "/wiki/hostile-title/", title: HOSTILE_TITLE, note: null },
      { href: "/wiki/exporter/", title: "CSV exporter", note: "retired" },
      { href: "/wiki/deliverables/", title: "Deliverables", note: null },
      {
        href: "/wiki/legacy-signals/",
        title: "Legacy signals",
        note: "redirect to Signal ingestion",
      },
      { href: "/wiki/reports/", title: "Reports", note: "disambiguation" },
      { href: "/wiki/signals/", title: "Signal ingestion", note: null },
    ]);
  });
});
