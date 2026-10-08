import { makePersonFacts } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { articleView } from "./article.ts";
import { articleInflight } from "./inflight-article.ts";
import { buildSiteModel } from "./model.ts";
import {
  activityRoutes,
  activityView,
  computedLead,
  peopleIndexView,
  peopleRoutes,
  personView,
} from "./people.ts";
import { fixtureExport } from "./test-fixtures.ts";
import { fixturePeople, HOSTILE_PERSON_NAME, peopleExport } from "./test-people.ts";

const site = buildSiteModel(peopleExport(), "https://github.com/acme/demo-repo");
const people = fixturePeople();

describe("peopleRoutes (spec v2 #6 §11)", () => {
  it("has the index, one page per person with a page, and the redirects", () => {
    expect(peopleRoutes(site).map((r) => [r.kind, r.path])).toEqual([
      ["index", undefined],
      ["person", "ada-lovelace"],
      ["person", "grace-hopper"],
      ["person", "hostile-name"],
      ["redirect", "ada"],
    ]);
  });

  it("has no route at all without People", () => {
    expect(peopleRoutes(buildSiteModel(fixtureExport(), null))).toEqual([]);
  });
});

describe("peopleIndexView", () => {
  it("lists people by commits, the bots, and each feature's contributors by share", () => {
    const view = peopleIndexView(site, people);
    expect(view.people.map((p) => [p.name, p.commits, p.share])).toEqual([
      ["Ada Lovelace", "4", "38%"],
      ["Grace Hopper", "3", "46%"],
      [HOSTILE_PERSON_NAME, "1", "0.0%"],
    ]);
    expect(view.bots).toEqual([{ name: "dependabot[bot]", commits: "1" }]);
    expect(view.byFeature.map((f) => [f.anchor, f.contributors])).toEqual([
      ["feature-deliverables", ['<a href="/people/ada-lovelace/">Ada Lovelace</a> (25%)']],
      [
        "feature-signals",
        [
          '<a href="/people/grace-hopper/">Grace Hopper</a> (55%)',
          '<a href="/people/ada-lovelace/">Ada Lovelace</a> (40%)',
        ],
      ],
    ]);
    expect(view.chart).toContain('<ul class="chart-legend">');
  });
});

describe("personView", () => {
  it("renders the narrative's lead, chronicle, areas and references", () => {
    const view = personView(site, people, "ada-lovelace");
    expect(view.leadHtml).toContain(
      "<b>Ada Lovelace</b> contributed between January and March 2026",
    );
    expect(view.leadHtml).toContain('href="/wiki/signals/"');
    expect(view.chronicle).toHaveLength(1);
    expect(view.areasHtml).toContain("her commits added the ingestion loop");
    expect(view.references[0]?.html).toContain("https://github.com/acme/demo-repo/commit/");
    expect(view.pulls).toEqual([
      {
        number: 3,
        title: "Add signal ingestion",
        merged: "20 January 2026",
        href: "https://github.com/acme/demo-repo/pull/3",
      },
    ]);
    expect(view.infobox.map((r) => r.label)).toEqual([
      "Other names",
      "Active",
      "Commits",
      "Lines",
      "Current lines",
      "Pull requests",
      "Main features",
    ]);
    expect(view.asOf).toBe("Narrative as of 14 March 2026 (aaaaaaa).");
    expect(view.due).toBeNull();
    expect(view.years.map((y) => y.anchor)).toEqual(["activity-2026"]);
  });

  it("gives a person with no narrative the computed lead, escaped", () => {
    const view = personView(site, people, "hostile-name");
    expect(view.leadHtml).toBe(
      "<b>&lt;script&gt;alert(1)&lt;/script&gt; &quot;Q&quot; &amp; &#39;P&#39;</b> made 1 commit between 30 December 2025 and 30 December 2025.",
    );
    expect(view.chronicle).toEqual([]);
    expect(view.asOf).toMatch(/^No narrative/);
    const grace = people.snapshot.people.find((p) => p.id === "grace-hopper");
    expect(grace === undefined ? "" : computedLead(grace)).toContain("made 3 commits");
  });

  it("says how many newer commits the narrative does not cover yet", () => {
    const later = {
      ...people,
      pages: people.pages.map((p) => ({ ...p, commitDate: "2026-02-01T00:00:00Z" })),
    };
    expect(personView(site, later, "ada-lovelace").due).toBe(
      "2 newer commits are not yet in the narrative.",
    );
  });
});

describe("the activity pages (R22)", () => {
  it("are all time, then each year and month with commits, and none without People", () => {
    expect(activityRoutes(site).map((r) => r.period)).toEqual([
      undefined,
      "2025",
      "2025-12",
      "2026",
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(activityRoutes(buildSiteModel(fixtureExport(), null))).toEqual([]);
  });

  it("zoom from all time to a year by week, then to a month by day", () => {
    const all = activityView(site, people, undefined);
    expect([all.title, all.up, all.down.map((d) => d.href)]).toEqual([
      "Activity",
      null,
      ["/special/activity/2025/", "/special/activity/2026/"],
    ]);
    expect(all.chart).toContain('<a href="/special/activity/2026/">');
    const year = activityView(site, people, "2026");
    expect(year.title).toBe("Activity in 2026");
    expect(year.up).toEqual({ label: "All time", href: "/special/activity/" });
    expect(year.chart).toContain("Week of 5 Jan 2026");
    expect(year.chart).toContain('<a href="/special/activity/2026-01/">');
    const month = activityView(site, people, "2026-02");
    expect(month.title).toBe("Activity in February 2026");
    expect(month.up).toEqual({ label: "2026", href: "/special/activity/2026/" });
    expect(month.chart.split("</svg>")[0]).not.toContain("<a href=");
    expect(month.chart).toContain("10 Feb 2026: 1 commit");
  });
});

describe("Main contributors (R23)", () => {
  it("lists five people by current lines, then 'and N more' to the People index", () => {
    const base = fixturePeople();
    const many = Array.from({ length: 7 }, (_, i) =>
      makePersonFacts({
        id: `p-${i}`,
        name: `Person ${i}`,
        currentLines: 10 + i,
        features: [{ featureId: "signals", commits: 1, currentLines: 10 + i }],
      }),
    );
    const wiki = {
      ...peopleExport(),
      people: {
        ...base,
        snapshot: {
          ...base.snapshot,
          people: many,
          redirects: [],
          totalLines: 91 + base.snapshot.unattributedLines,
          featureLines: { signals: 91 },
        },
        pages: [],
      },
    };
    const s = buildSiteModel(wiki, null);
    const page = s.pages.get("signals");
    if (page === undefined) throw new Error("signals has a page");
    const row = articleView(s, page, articleInflight(s, "signals")).infobox.find(
      (r) => r.label === "Main contributors",
    );
    expect(row?.ignore).toBe(true);
    expect(row?.html.match(/<a href="\/people\/p-/g)).toHaveLength(5);
    expect(row?.html).toMatch(/^<a href="\/people\/p-6\/">Person 6<\/a> \(18%\)/);
    expect(row?.html).toContain('<a href="/people/#feature-signals">and 2 more</a>');
  });
});
