import { makePersonFacts } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  barChart,
  barTitle,
  bucketFor,
  bucketLabel,
  bucketStart,
  bucketStarts,
  MAX_BARS,
  periodDays,
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
    expect(bucketFor("1996-01-01", "2026-12-31")).toBe("quarter");
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
