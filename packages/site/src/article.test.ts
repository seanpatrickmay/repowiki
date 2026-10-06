import {
  bodyClaim,
  codeCitation,
  commitCitation,
  leadClaim,
  makeFeature,
  SHA_A,
  SHA_B,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { anchoredClaim, articleView } from "./article.ts";
import { formatDate, formatNumber } from "./format.ts";
import { buildSiteModel } from "./model.ts";
import { fixtureExport, fixtureExportWith } from "./test-fixtures.ts";

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
    expect(view.seeAlso).toEqual([
      { href: "/wiki/deliverables/", title: "Deliverables" },
      { href: "/wiki/reports/", title: "Reports" },
    ]);
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

  it("passes the revision's Mermaid source through untouched, or null", () => {
    expect(articleView(site, page("signals")).diagram).toBe(page("signals").diagram);
    expect(articleView(site, page("signals")).diagram).toContain("flowchart LR");
    expect(articleView(site, page("deliverables")).diagram).toBeNull();
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

  it("marks the lead stale when one of its own claims is stale", () => {
    const revision = page("signals");
    const [lead, ...rest] = revision.sections;
    if (lead === undefined) throw new Error("no lead");
    const leadClaims = lead.claims.map((claim) => ({
      ...claim,
      supports: [],
      staleSince: "b".repeat(40),
    }));
    const stale = articleView(site, {
      ...revision,
      sections: [{ ...lead, claims: leadClaims }, ...rest],
    });
    expect(stale.leadStale).toBe(true);
  });

  it.each([[[]], [["ghost"]]])("has no See also entry for %j", (seeAlso) => {
    const bare = articleView(site, { ...page("signals"), seeAlso });
    expect(bare.seeAlso).toEqual([]);
    expect(bare.toc.map((entry) => entry.title)).not.toContain("See also");
    expect(bare.toc.map((entry) => entry.title)).toContain("References");
  });

  it("renders claim text with its reference markers, and lists the references", () => {
    const overview = view.sections.find((s) => s.anchor === "overview");
    expect(overview?.html).toContain(
      'Each signal stores its source chunk and a <i>confidence</i> score.<sup class="reference" id="cite-ref-1-1"><a href="#cite-note-1">[1]</a></sup><sup class="reference" id="cite-ref-2-0"><a href="#cite-note-2">[2]</a></sup>',
    );
    expect(view.references.length).toBeGreaterThan(0);
    expect(view.references[0]).toEqual({
      n: 1,
      html: `<a class="external" href="${REPO}/blob/${"a".repeat(40)}/src/signals/ingest.py#L10-L24"><code>src/signals/ingest.py:L10-24@aaaaaaa</code></a> (<code>ingest_chunk</code>)`,
      // Three claims cite this source (the fixture's default citation), hence the lettered back-links.
      backlinks:
        '^ <a class="ref-back" href="#cite-ref-1-0" aria-label="Back to citing claim 1">a</a> <a class="ref-back" href="#cite-ref-1-1" aria-label="Back to citing claim 2">b</a> <a class="ref-back" href="#cite-ref-1-2" aria-label="Back to citing claim 3">c</a>',
    });
  });
});

describe("articleView with hostile text", () => {
  const HOSTILE = `<img src=x onerror=1>"&'`;
  const ESCAPED = "&lt;img src=x onerror=1&gt;&quot;&amp;&#39;";
  const revision = page("signals");
  const signals = site.features.get("signals");
  if (signals === undefined) throw new Error("no feature signals");
  const hostileSite = {
    ...site,
    features: new Map(site.features).set("signals", {
      ...signals,
      aliases: [HOSTILE],
    }),
  };
  const hostile = articleView(hostileSite, {
    ...revision,
    infobox: { ...revision.infobox, languages: [HOSTILE], entryPoints: [HOSTILE] },
    sections: [
      {
        key: "lead",
        claims: [leadClaim({ id: "h-lead", text: HOSTILE, supports: [] })],
      },
      {
        key: "overview",
        claims: [
          bodyClaim({
            id: "h-o1",
            text: HOSTILE,
            citations: [
              codeCitation({ path: `src/${HOSTILE}.py`, symbol: HOSTILE }),
              commitCitation({ subject: HOSTILE }),
            ],
          }),
        ],
      },
    ],
  });

  it("escapes claim text, citations and infobox values", () => {
    const rendered = [
      hostile.leadHtml,
      ...hostile.sections.map((s) => s.html),
      ...hostile.infobox.map((row) => row.html),
      ...hostile.references.map((ref) => ref.html),
    ];
    for (const html of rendered) expect(html).not.toContain("<img");
    expect(hostile.leadHtml).toContain(ESCAPED);
    expect(hostile.sections[0]?.html).toContain(ESCAPED);
    const row = (label: string) => hostile.infobox.find((r) => r.label === label)?.html;
    expect(row("Also known as")).toBe(ESCAPED);
    expect(row("Languages")).toBe(ESCAPED);
    expect(row("Entry points")).toBe(`<code>${ESCAPED}</code>`);
    expect(hostile.references).toHaveLength(2);
    expect(hostile.references[0]?.html).toContain("src/&lt;img");
    expect(hostile.references[0]?.html).toContain(`(<code>${ESCAPED}</code>)`);
    expect(hostile.references[1]?.html).toContain(`&quot;${ESCAPED}&quot;`);
  });
});

describe("articleView preview ids", () => {
  it("asks for a preview only where a preview file will exist", () => {
    // `old-name` redirects to `scheduler`, which has no page, so there is nothing to preview.
    const withDangling = buildSiteModel(
      fixtureExportWith([
        makeFeature({
          id: "old-name",
          title: "Old name",
          aliases: [],
          status: { kind: "redirect", to: "scheduler" },
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "merge", sha: SHA_B, into: "scheduler" },
          ],
        }),
      ]),
      REPO,
    );
    const revision = withDangling.pages.get("signals");
    if (revision === undefined) throw new Error("no signals page");
    const view = articleView(withDangling, {
      ...revision,
      sections: [
        {
          key: "lead",
          claims: [
            leadClaim({
              id: "p-lead",
              text: "See [[old-name]], [[legacy-signals]] and [[deliverables]].",
              supports: [],
            }),
          ],
        },
      ],
    });
    expect(view.leadHtml).toContain('href="/wiki/old-name/" title="Old name">Old name</a>');
    expect(view.leadHtml).not.toContain('data-preview="old-name"');
    expect(view.leadHtml).toContain('data-preview="legacy-signals"');
    expect(view.leadHtml).toContain('data-preview="deliverables"');
  });
});

describe("claim anchors (spec v2 #4 R17)", () => {
  it("wraps a claim in its anchor once per page, and leaves an id it cannot anchor bare", () => {
    const used = new Set<string>();
    expect(anchoredClaim("c3", "<b>x</b>", used)).toBe(
      '<span class="claim" id="claim-c3"><b>x</b></span>',
    );
    expect(anchoredClaim("c3", "again", used)).toBe("again");
    expect(anchoredClaim('c3"><img src=x>', "text", used)).toBe("text");
    expect(anchoredClaim("c 4", "text", used)).toBe("text");
  });

  it("anchors every claim of an article, lead and sections", () => {
    const view = articleView(site, page("signals"));
    const ids = [view.leadHtml, ...view.sections.map((s) => s.html)].flatMap((html) =>
      [...html.matchAll(/<span class="claim" id="([^"]+)">/g)].map((m) => m[1]),
    );
    const claims = page("signals").sections.flatMap((s) => s.claims.map((c) => `claim-${c.id}`));
    expect(ids).toEqual(claims);
  });

  it("anchors a repeated claim id only at its first claim", () => {
    const revision = page("signals");
    const [lead, ...rest] = revision.sections;
    if (lead === undefined) throw new Error("no lead");
    const twice = articleView(site, {
      ...revision,
      sections: [
        { ...lead, claims: lead.claims.map((c) => ({ ...c, id: "dup" })) },
        ...rest.map((s) => ({ ...s, claims: s.claims.map((c) => ({ ...c, id: "dup" })) })),
      ],
    });
    const all = [twice.leadHtml, ...twice.sections.map((s) => s.html)].join(" ");
    expect(all.split('id="claim-dup"')).toHaveLength(2);
  });
});
