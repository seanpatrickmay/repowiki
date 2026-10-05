import { WikiView } from "@repowiki/query";
import { extendedWiki, type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSiteModel, finalTarget, hasArticleRoute } from "../packages/site/src/model.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

/**
 * The wiki agent's view routes ids as the reader site does (query cannot depend on the site, so
 * WikiView keeps its own copy of the rules): this pins the two copies to each other.
 */
describe("WikiView and the site's model", () => {
  it("agree on every feature's route and final target, and on every alias route", () => {
    for (const wiki of [sample.wiki, extendedWiki(sample)]) {
      const view = new WikiView(wiki);
      const site = buildSiteModel(wiki, null);
      for (const feature of wiki.manifest.features) {
        expect(view.hasRoute(feature.id), feature.id).toBe(hasArticleRoute(site, feature.id));
        expect(view.finalTarget(feature.id), feature.id).toBe(finalTarget(site, feature.id));
      }
      expect(site.aliases.length).toBeGreaterThan(0);
      for (const route of site.aliases) {
        // WikiView adds each title's slug too, so its routes hold at least the site's targets.
        expect(view.aliasRoutes.get(route.slug), route.slug).toEqual(
          expect.arrayContaining(route.targets),
        );
        const resolved = view.resolve(route.alias);
        if (route.targets.length === 1 && resolved.kind === "page") {
          expect(resolved.featureId).toBe(route.targets[0]);
        }
      }
    }
  });
});
