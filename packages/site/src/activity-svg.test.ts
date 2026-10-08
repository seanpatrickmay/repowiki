import { makePeopleSnapshot, makePersonFacts } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  barChart,
  barTitle,
  bucketFor,
  bucketLabel,
  bucketStart,
  bucketStarts,
  chartWindow,
  heatLevel,
  heatmap,
  MAX_BARS,
  periodDays,
  repositorySeries,
  sparkline,
  xmlText,
} from "./activity-svg.ts";

const HOSTILE = "<script>alert(1)</script> & \"q\" 'p' \u202Eevil\u0007\u200Bx";

describe("xmlText", () => {
  it("escapes markup and drops invisible and control characters", () => {
    expect(xmlText(HOSTILE)).toBe(
      "&#60;script&#62;alert(1)&#60;/script&#62; &#38; &#34;q&#34; &#39;p&#39; evilx",
    );
    expect(xmlText("\uD800a")).toBe("\uFFFDa");
    // ZWJ joins an emoji sequence: it stays.
    expect(xmlText("a\u200Db")).toBe("a\u200Db");
  });
});

describe("bucketing (R22)", () => {
  it("starts weeks on Monday, and months and quarters on their first day", () => {
    expect(bucketStart("2026-03-11", "week")).toBe("2026-03-09");
    expect(bucketStart("2026-03-09", "week")).toBe("2026-03-09");
    expect(bucketStart("2026-03-11", "month")).toBe("2026-03-01");
    expect(bucketStart("2026-05-11", "quarter")).toBe("2026-04-01");
    expect(bucketStarts("2026-11-15", "2027-02-02", "month")).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
    ]);
  });

  it("picks the smallest bucket that draws at most 120 bars", () => {
    expect(bucketFor("2026-01-01", "2026-04-30")).toBe("day");
    expect(bucketFor("2026-01-01", "2027-06-30")).toBe("week");
    expect(bucketFor("2016-01-01", "2024-12-31")).toBe("month");
    // 31 years of quarters is 124 bars: over the cap, so years (the Task 30 ruling).
    expect(bucketFor("1996-01-01", "2026-12-31")).toBe("year");
    expect(bucketFor("2001-01-01", "2026-12-31")).toBe("quarter");
    expect(bucketStarts("2016-01-01", "2024-12-31", "month").length).toBeLessThanOrEqual(MAX_BARS);
  });

  it("labels each period as the spec writes it", () => {
    expect(bucketLabel("2026-03-09", "day")).toBe("9 Mar 2026");
    expect(bucketLabel("2026-03-09", "week")).toBe("Week of 9 Mar 2026");
    expect(bucketLabel("2026-03-01", "month")).toBe("March 2026");
    expect(bucketLabel("2026-04-01", "quarter")).toBe("Q2 2026");
    expect(barTitle("Week of 9 Mar 2026", { commits: 12, added: 840, deleted: 120 })).toBe(
      "Week of 9 Mar 2026: 12 commits, +840 −120 lines",
    );
    expect(periodDays("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(periodDays("2026")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });
});

const ada = makePersonFacts();
const series = [
  { label: ada.name, href: "/people/ada-lovelace/", cls: "series-1", activity: ada.activity },
];

describe("barChart (R21)", () => {
  const options = {
    label: "Commits by month",
    bucket: "month" as const,
    starts: bucketStarts("2026-01-01", "2026-03-31", "month"),
    hrefOf: (start: string) => `#activity-${start.slice(0, 4)}`,
  };

  it("draws a linked bar with a title per period, and the same numbers in a hidden table", () => {
    const html = barChart(series, options);
    expect(html).toMatch(
      /^<figure class="activity"><svg class="activity-chart" viewBox="0 0 720 160" role="img" aria-label="Commits by month"/,
    );
    expect(html.match(/<a href="#activity-2026">/g)).toHaveLength(3);
    expect(html).toContain("<title>January 2026: 2 commits, +80 −0 lines</title>");
    expect(html).toContain('<table class="visually-hidden"><caption>Commits by month</caption>');
    expect(html).toContain(
      '<tr><th scope="row">March 2026</th><td>1</td><td>10</td><td>10</td></tr>',
    );
    // One series: no legend.
    expect(html).not.toContain("chart-legend");
  });

  it("links no empty period, and none at the finest zoom", () => {
    const html = barChart(series, {
      ...options,
      starts: bucketStarts("2025-12-01", "2026-01-31", "month"),
    });
    expect(html.match(/<a href=/g)).toHaveLength(1);
    expect(barChart(series, { ...options, hrefOf: () => null })).not.toContain("<a ");
  });

  it("keeps a hostile name out of the markup in titles, legend and table", () => {
    const hostile = [
      { ...series[0], label: HOSTILE, cls: "series-1" },
      { label: "Bots", href: null, cls: "bots", activity: ada.activity },
    ] as Parameters<typeof barChart>[0];
    const html = barChart(hostile, options);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("\u202E");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(
      '<ul class="chart-legend"><li><span class="swatch series-1" aria-hidden="true"></span><a href="/people/ada-lovelace/">',
    );
  });
});

describe("repositorySeries", () => {
  it("names people by commits in range, then others, then bots", () => {
    const snapshot = makePeopleSnapshot();
    const s = repositorySeries(snapshot, "2026-01-01", "2026-12-31", (id) => `/people/${id}/`);
    expect(s.map((x) => [x.label, x.cls, x.href])).toEqual([
      ["Ada Lovelace", "series-1", "/people/ada-lovelace/"],
      ["Grace Hopper", "series-2", "/people/grace-hopper/"],
      ["Others", "others", null],
      ["Bots", "bots", null],
    ]);
    const march = repositorySeries(snapshot, "2026-03-01", "2026-03-31", (id) => id);
    expect(march.map((x) => x.label)).toEqual(["Ada Lovelace"]);
  });

  it("folds people past the eighth into Others", () => {
    const people = Array.from({ length: 10 }, (_, i) =>
      makePersonFacts({ id: `p-${i}`, name: `Person ${i}` }),
    );
    const s = repositorySeries(
      { ...makePeopleSnapshot(), people, others: [] },
      "2026-01-01",
      "2026-12-31",
      (id) => id,
    );
    expect(s.map((x) => x.cls)).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `series-${i + 1}`),
      "others",
    ]);
    expect(s.at(-1)?.activity.reduce((n, d) => n + d.commits, 0)).toBe(8);
  });
});

describe("heatmap and sparkline", () => {
  it("draws every day of the year in weekday rows, levelled by commits", () => {
    const html = heatmap(2026, ada.activity, "Ada Lovelace's commits in 2026");
    expect(html.match(/<rect /g)).toHaveLength(365);
    // 1 January 2026 is a Thursday: row 3 of the first week.
    expect(html).toContain(
      '<rect class="heat-0" x="0" y="42" width="12" height="12"><title>1 Jan 2026: 0 commits, +0 −0 lines</title></rect>',
    );
    expect(html).toContain('class="heat-2"');
    expect(html).toContain(
      '<tr><th scope="row">5 Jan 2026</th><td>2</td><td>80</td><td>0</td></tr>',
    );
    expect([0, 1, 3, 6, 7].map(heatLevel)).toEqual([0, 1, 2, 3, 4]);
  });

  it("draws a decorative sparkline", () => {
    const svg = sparkline(ada.activity, "2026-01-01", "2026-03-31");
    expect(svg).toMatch(
      /^<svg class="sparkline" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">/,
    );
    expect(svg.match(/<rect /g)).toHaveLength(3);
  });
});

describe("chart bounds (the Task 30 ruling)", () => {
  const day = (d: string, commits = 1) => ({ day: d, commits, added: 1, deleted: 0 });

  it("never draws more than MAX_BARS bars, coarsening to years and then cutting the oldest", () => {
    for (const [from, to] of [
      ["1970-01-01", "2026-12-31"],
      ["1971-06-01", "2026-01-02"],
    ] as const) {
      const bucket = bucketFor(from, to);
      expect(bucketStarts(from, to, bucket).length).toBeLessThanOrEqual(MAX_BARS);
    }
    expect(bucketStarts("2020-01-01", "2022-12-31", "year")).toEqual([
      "2020-01-01",
      "2021-01-01",
      "2022-01-01",
    ]);
    expect(bucketLabel("2020-01-01", "year")).toBe("2020");
    const wide = chartWindow([day("1970-01-01"), day("9999-12-31")], "9999-12-31");
    expect(wide.starts.length).toBeLessThanOrEqual(MAX_BARS);
    expect(wide.bucket).toBe("year");
    expect(wide.outside).toBe(1);
  });

  it("clamps dates to 1970 and the head's date, counting what it leaves out, and never throws", () => {
    const w = chartWindow(
      [day("0100-05-01", 2), day("2026-01-05"), day("2026-02-03"), day("9999-12-31", 3)],
      "2026-03-01",
    );
    expect([w.from, w.to, w.outside]).toEqual(["2026-01-05", "2026-02-03", 5]);
    expect(w.bucket).toBe("day");
    expect(w.note).toBe("5 commits dated before 1970 or after the head's date are not drawn.");
    const none = chartWindow([day("2030-01-01")], "2026-03-01");
    expect([none.from, none.to, none.starts]).toEqual(["2026-03-01", "2026-03-01", ["2026-03-01"]]);
    expect(chartWindow([day("2026-01-05")], "2026-03-01").note).toBeNull();
  });

  it("gives a one-commit bar a visible height beside a tall one", () => {
    const html = barChart(
      [
        {
          label: "x",
          href: null,
          cls: "series-1",
          activity: [day("2026-01-01", 2000), day("2026-02-01", 1)],
        },
      ],
      { label: "c", bucket: "month", starts: ["2026-01-01", "2026-02-01"], hrefOf: () => null },
    );
    const heights = [...html.matchAll(/<rect class="series-1"[^>]* height="([\d.]+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(heights).toHaveLength(2);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(2);
  });

  it("escapes a bar's and a legend's href the same way", () => {
    const href = '/people/a"b\u0007/';
    const html = barChart(
      [
        { label: "a", href, cls: "series-1", activity: [day("2026-01-01")] },
        { label: "b", href: null, cls: "series-2", activity: [day("2026-01-01")] },
      ],
      { label: "c", bucket: "month", starts: ["2026-01-01"], hrefOf: () => href },
    );
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(hrefs)).toEqual(new Set([xmlText(href)]));
  });

  it("prints a chart's note under it", () => {
    const html = barChart([{ label: "x", href: null, cls: "series-1", activity: [] }], {
      label: "c",
      bucket: "month",
      starts: ["2026-01-01"],
      hrefOf: () => null,
      note: "2 commits <b>dated</b> before 1970 are not drawn.",
    });
    expect(html).toContain(
      '<figcaption class="chart-note">2 commits &lt;b&gt;dated&lt;/b&gt; before 1970 are not drawn.</figcaption>',
    );
  });
});
