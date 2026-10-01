import { makeFeature, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { buildSiteModel } from "./model.ts";
import { articleFor, pageFor, type WikiRoute, wikiRoutes } from "./routes.ts";
import { leadSummary } from "./summary.ts";
import { fixtureExport, fixtureExportWith, HOSTILE_TITLE } from "./test-fixtures.ts";

const site = buildSiteModel(fixtureExport(), null);

describe("wikiRoutes", () => {
  it("emits articles, feature redirects and disambiguations, then alias pages", () => {
    expect(wikiRoutes(site)).toEqual([
      { slug: "signals", kind: "article", featureId: "signals" },
      { slug: "deliverables", kind: "article", featureId: "deliverables" },
      { slug: "legacy-signals", kind: "redirect", title: "Legacy signals", target: "signals" },
      {
        slug: "reports",
        kind: "disambiguation",
        title: "Reports",
        targets: ["signals", "deliverables"],
      },
      { slug: "exporter", kind: "article", featureId: "exporter" },
      { slug: "hostile-title", kind: "article", featureId: "hostile-title" },
      { slug: "api-signals", kind: "redirect", title: "/api/signals", target: "signals" },
      {
        slug: "deliverable-records",
        kind: "redirect",
        title: "deliverable records",
        target: "deliverables",
      },
      { slug: "i-x-i", kind: "redirect", title: "<i>x</i>", target: "hostile-title" },
      {
        slug: "signal-pipeline",
        kind: "disambiguation",
        title: "signal pipeline",
        targets: ["signals", "deliverables"],
      },
      { slug: "signals-table", kind: "redirect", title: "SIGNALS_TABLE", target: "signals" },
    ]);
  });

  it("never emits two pages for one slug", () => {
    const slugs = wikiRoutes(site).map((route) => route.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("skips features without a revision", () => {
    expect(site.pages.has("scheduler")).toBe(false);
    expect(wikiRoutes(site).map((route) => route.slug)).not.toContain("scheduler");
  });
});

describe("articleFor", () => {
  it("returns the current revision of the routed feature", () => {
    const route = { slug: "signals", kind: "article", featureId: "signals" } as const;
    expect(articleFor(site, route).id).toBe("signals-2");
  });

  it("throws when the routed feature has no page", () => {
    const route = { slug: "scheduler", kind: "article", featureId: "scheduler" } as const;
    expect(() => articleFor(site, route)).toThrow("no page for scheduler");
  });
});

describe("pageFor", () => {
  const route = (slug: string): WikiRoute => {
    const found = wikiRoutes(site).find((candidate) => candidate.slug === slug);
    if (found === undefined) throw new Error(`no route ${slug}`);
    return found;
  };

  it("builds the article view for an article route", () => {
    const page = pageFor(site, route("signals"));
    expect(page.kind === "article" && page.view.title).toBe("Signal ingestion");
  });

  it("sends a redirect to its target with the old title in the query", () => {
    expect(pageFor(site, route("legacy-signals"))).toEqual({
      kind: "redirect",
      title: "Legacy signals",
      target: { title: "Signal ingestion", href: "/wiki/signals/" },
      refresh: "0; url=/wiki/signals/?redirectedfrom=Legacy%20signals",
    });
  });

  it("percent-encodes a hostile title and survives a lone surrogate in it", () => {
    const hostile = pageFor(site, route("i-x-i"));
    expect(hostile.kind === "redirect" && hostile.refresh).toBe(
      "0; url=/wiki/hostile-title/?redirectedfrom=%3Ci%3Ex%3C%2Fi%3E",
    );
    const lone = pageFor(site, {
      slug: "x",
      kind: "redirect",
      title: "a\uD800b",
      target: "signals",
    });
    expect(lone.kind === "redirect" && lone.refresh).toBe(
      "0; url=/wiki/signals/?redirectedfrom=a%EF%BF%BDb",
    );
    const title = pageFor(site, {
      slug: "y",
      kind: "redirect",
      title: HOSTILE_TITLE,
      target: "signals",
    });
    const query =
      title.kind === "redirect" ? title.refresh?.split("?redirectedfrom=")[1] : undefined;
    expect(query).toBeDefined();
    expect(query).not.toMatch(/[<>"& ]/);
    expect(decodeURIComponent(query ?? "")).toBe(HOSTILE_TITLE);
  });

  it("shows a redirect to a feature without a page as plain text, with no refresh", () => {
    expect(
      pageFor(site, { slug: "gone", kind: "redirect", title: "Gone", target: "scheduler" }),
    ).toEqual({
      kind: "redirect",
      title: "Gone",
      target: { title: "Scheduler", href: null },
      refresh: null,
    });
  });

  it("lists each disambiguation target with its link-free lead", () => {
    expect(pageFor(site, route("reports"))).toEqual({
      kind: "disambiguation",
      title: "Reports",
      entries: [
        {
          title: "Signal ingestion",
          href: "/wiki/signals/",
          summaryHtml: expect.stringMatching(/^: <b>Signal ingestion<\/b> is the subsystem/),
        },
        {
          title: "Deliverables",
          href: "/wiki/deliverables/",
          summaryHtml: ": <b>Deliverables</b> are the records that Signal ingestion feed.",
        },
      ],
    });
  });

  it("keeps a target without a page as an unlinked entry with no summary", () => {
    expect(
      pageFor(site, { slug: "z", kind: "disambiguation", title: "Z", targets: ["scheduler"] }),
    ).toEqual({
      kind: "disambiguation",
      title: "Z",
      entries: [{ title: "Scheduler", href: null, summaryHtml: null }],
    });
  });
});

const redirectTo = (id: string, to: string, aliases: string[] = []) =>
  makeFeature({
    id,
    title: id,
    aliases,
    status: { kind: "redirect", to },
    lineage: [
      { kind: "create", sha: SHA_A },
      { kind: "merge", sha: SHA_B, into: to },
    ],
  });

describe("redirect chains", () => {
  // old-legacy -> legacy-signals -> signals
  const chained = buildSiteModel(
    fixtureExportWith([redirectTo("old-legacy", "legacy-signals", ["Ancient"])]),
    null,
  );

  it("points a chained redirect straight at the final target", () => {
    const route = wikiRoutes(chained).find((candidate) => candidate.slug === "old-legacy");
    expect(route).toEqual({
      slug: "old-legacy",
      kind: "redirect",
      title: "old-legacy",
      target: "signals",
    });
    expect(route && pageFor(chained, route)).toEqual({
      kind: "redirect",
      title: "old-legacy",
      target: { title: "Signal ingestion", href: "/wiki/signals/" },
      refresh: "0; url=/wiki/signals/?redirectedfrom=old-legacy",
    });
  });

  it("points an alias of a chained redirect at the final target too", () => {
    const route = wikiRoutes(chained).find((candidate) => candidate.slug === "ancient");
    expect(route).toEqual({
      slug: "ancient",
      kind: "redirect",
      title: "Ancient",
      target: "signals",
    });
  });
});

describe("disambiguation targets", () => {
  const dab = (targets: string[]): WikiRoute => ({
    slug: "d",
    kind: "disambiguation",
    title: "D",
    targets,
  });
  const merged = buildSiteModel(fixtureExportWith([redirectTo("dead-end", "scheduler")]), null);

  it("links a merged-away target to its final article and shows that article's lead", () => {
    // legacy-signals is a redirect that still has a (stale) revision of its own.
    expect(site.pages.has("legacy-signals")).toBe(true);
    const page = pageFor(site, dab(["legacy-signals", "deliverables"]));
    expect(page).toEqual({
      kind: "disambiguation",
      title: "D",
      entries: [
        {
          title: "Signal ingestion",
          href: "/wiki/signals/",
          summaryHtml: expect.stringMatching(/^: <b>Signal ingestion<\/b> is the subsystem/),
        },
        {
          title: "Deliverables",
          href: "/wiki/deliverables/",
          summaryHtml: ": <b>Deliverables</b> are the records that Signal ingestion feed.",
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain("Legacy signals");
  });

  it("lists one entry when two targets resolve to the same article", () => {
    const page = pageFor(site, dab(["legacy-signals", "signals", "deliverables"]));
    expect(page.kind === "disambiguation" && page.entries.map((entry) => entry.href)).toEqual([
      "/wiki/signals/",
      "/wiki/deliverables/",
    ]);
  });

  it("renders a target that resolves to a feature without a page as plain text", () => {
    const page = pageFor(merged, dab(["dead-end"]));
    expect(page).toEqual({
      kind: "disambiguation",
      title: "D",
      entries: [{ title: "Scheduler", href: null, summaryHtml: null }],
    });
  });
});

describe("leadSummary", () => {
  it("renders the lead without links", () => {
    expect(leadSummary(site, "deliverables")).toBe(
      "<b>Deliverables</b> are the records that Signal ingestion feed.",
    );
    expect(leadSummary(site, "scheduler")).toBeNull();
  });
});
