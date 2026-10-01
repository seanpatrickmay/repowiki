import { describe, expect, it } from "vitest";
import { aliasSlug, buildSiteModel, featureLink, finalTarget, hasArticleRoute } from "./model.ts";
import { fixtureExport } from "./test-fixtures.ts";

const site = buildSiteModel(fixtureExport(), null);

describe("aliasSlug", () => {
  it.each([
    ["signal pipeline", "signal-pipeline"],
    ["SIGNALS_TABLE", "signals-table"],
    ["/api/signals", "api-signals"],
    ["Café façade", "cafe-facade"],
    ["  ---  ", ""],
    [`${"a".repeat(63)} b`, "a".repeat(63)],
  ])("slugs %j as %j", (alias, slug) => {
    expect(aliasSlug(alias)).toBe(slug);
  });
});

describe("buildSiteModel", () => {
  it("routes features that have a page, a redirect or a disambiguation", () => {
    const routed = [...site.features.keys()].filter((id) => hasArticleRoute(site, id));
    expect(routed.sort()).toEqual([
      "deliverables",
      "exporter",
      "hostile-title",
      "legacy-signals",
      "reports",
      "signals",
    ]);
    expect(hasArticleRoute(site, "scheduler")).toBe(false);
    expect(hasArticleRoute(site, "ghost")).toBe(false);
  });

  it("resolves redirects and links only routed features", () => {
    expect(finalTarget(site, "legacy-signals")).toBe("signals");
    expect(finalTarget(site, "signals")).toBe("signals");
    expect(featureLink(site, "deliverables")).toEqual({
      href: "/wiki/deliverables/",
      title: "Deliverables",
    });
    expect(featureLink(site, "scheduler")).toBeNull();
    expect(featureLink(site, "ghost")).toBeNull();
  });

  it("makes alias routes, merging shared slugs and skipping ones that shadow feature ids", () => {
    expect(site.aliases).toEqual([
      { slug: "api-signals", alias: "/api/signals", targets: ["signals"] },
      { slug: "deliverable-records", alias: "deliverable records", targets: ["deliverables"] },
      { slug: "i-x-i", alias: "<i>x</i>", targets: ["hostile-title"] },
      { slug: "signal-pipeline", alias: "signal pipeline", targets: ["signals", "deliverables"] },
      { slug: "signals-table", alias: "SIGNALS_TABLE", targets: ["signals"] },
    ]);
  });

  it("indexes pages and full history by feature id", () => {
    expect(site.pages.get("signals")?.id).toBe("signals-2");
    expect(site.history.get("signals")?.map((r) => r.id)).toEqual(["signals-1", "signals-2"]);
  });
});
