import { describe, expect, it } from "vitest";
import { buildSiteModel } from "./model.ts";
import { articleFor, type WikiRoute, wikiRoutes } from "./routes.ts";
import { fixtureExport } from "./test-fixtures.ts";

const site = buildSiteModel(fixtureExport(), null);

describe("wikiRoutes", () => {
  const articleIds = wikiRoutes(site)
    .filter((route) => route.kind === "article")
    .map((route) => route.featureId);

  it("routes active and retired features that have a revision", () => {
    expect(articleIds).toContain("signals");
    expect(articleIds).toContain("deliverables");
    expect(articleIds).toContain("exporter");
  });

  it("skips redirects, disambiguations and features without a revision", () => {
    // legacy-signals is a redirect that has a revision; reports is a disambiguation;
    // scheduler is active but has no revision.
    expect(site.pages.has("legacy-signals")).toBe(true);
    expect(site.pages.has("scheduler")).toBe(false);
    for (const id of ["legacy-signals", "reports", "scheduler"]) {
      expect(articleIds).not.toContain(id);
    }
  });

  it("uses the feature id as the slug, once per feature", () => {
    const routes = wikiRoutes(site);
    expect(routes.every((route) => route.slug === route.featureId)).toBe(true);
    expect(new Set(routes.map((route) => route.slug)).size).toBe(routes.length);
  });
});

describe("articleFor", () => {
  it("returns the current revision of the routed feature", () => {
    const route: WikiRoute = { slug: "signals", kind: "article", featureId: "signals" };
    expect(articleFor(site, route).id).toBe("signals-2");
  });

  it("throws when the routed feature has no page", () => {
    const route: WikiRoute = { slug: "scheduler", kind: "article", featureId: "scheduler" };
    expect(() => articleFor(site, route)).toThrow("no page for scheduler");
  });
});
