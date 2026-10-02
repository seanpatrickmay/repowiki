import { makeFeature, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { buildSiteModel, featureLink, finalTarget, hasArticleRoute } from "./model.ts";
import { fixtureExport, fixtureExportWith } from "./test-fixtures.ts";

const site = buildSiteModel(fixtureExport(), null);

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

  it("gives aliases on redirect and disambiguation features their own routes", () => {
    const withAliases = buildSiteModel(
      fixtureExportWith([
        makeFeature({
          id: "merged-away",
          title: "Merged away",
          aliases: ["Old Name"],
          status: { kind: "redirect", to: "signals" },
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "merge", sha: SHA_B, into: "signals" },
          ],
        }),
        makeFeature({
          id: "split-away",
          title: "Split away",
          aliases: ["Fork Name"],
          status: { kind: "disambiguation", to: ["signals", "deliverables"] },
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "split", sha: SHA_B, into: ["signals", "deliverables"] },
          ],
        }),
      ]),
      null,
    );
    const routes = withAliases.aliases.filter((route) =>
      ["old-name", "fork-name"].includes(route.slug),
    );
    expect(routes).toEqual([
      { slug: "fork-name", alias: "Fork Name", targets: ["split-away"] },
      { slug: "old-name", alias: "Old Name", targets: ["signals"] },
    ]);
  });

  it("indexes pages and full history by feature id", () => {
    expect(site.pages.get("signals")?.id).toBe("signals-2");
    expect(site.history.get("signals")?.map((r) => r.id)).toEqual(["signals-1", "signals-2"]);
  });
});
