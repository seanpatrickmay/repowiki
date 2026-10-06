import { ASK_HREF } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import { claimHref, pageHref, sectionHref } from "./hrefs.ts";
import { extendedWiki, sampleWiki } from "./test-wiki.ts";
import { ABOUT_PAGE_ID, WikiView } from "./wiki-view.ts";

describe("hrefs", () => {
  it("links a feature page and the About article", () => {
    expect(pageHref("signals")).toBe("/wiki/signals/");
    expect(pageHref(ABOUT_PAGE_ID)).toBe("/special/about/");
  });

  it("links a section, and the lead as the page itself", () => {
    expect(sectionHref("signals", "how-it-works")).toBe("/wiki/signals/#how-it-works");
    expect(sectionHref(ABOUT_PAGE_ID, "layers")).toBe("/special/about/#layers");
    expect(sectionHref("signals", "lead")).toBe("/wiki/signals/");
  });

  it("links a claim at its anchor, or at its section when its id has none", () => {
    expect(claimHref("signals", "s-1", "overview")).toBe("/wiki/signals/#claim-s-1");
    expect(claimHref(ABOUT_PAGE_ID, "c2", "lead")).toBe("/special/about/#claim-c2");
    expect(claimHref("signals", "s.1", "overview")).toBe("/wiki/signals/#overview");
    expect(claimHref("signals", "s:1", "lead")).toBe("/wiki/signals/");
  });

  it("links every page, section and claim of a wiki as an answer may carry them", () => {
    const sample = sampleWiki();
    try {
      const view = new WikiView(extendedWiki(sample));
      const hrefs = [pageHref(ABOUT_PAGE_ID)];
      for (const page of view.wiki.pages) {
        hrefs.push(pageHref(page.featureId));
        for (const section of page.sections) {
          hrefs.push(sectionHref(page.featureId, section.key));
          for (const claim of section.claims) {
            hrefs.push(claimHref(page.featureId, claim.id, section.key));
          }
        }
      }
      expect(hrefs.filter((href) => !ASK_HREF.test(href))).toEqual([]);
    } finally {
      sample.repo.remove();
    }
  });

  it.each([
    ["a page id that is not a slug", () => pageHref("../x")],
    ["an empty page id", () => pageHref("")],
    ["a section key that is not one", () => sectionHref("signals", "#x")],
  ])("refuses %s rather than build a bad link", (_what, build) => {
    expect(build).toThrow(/not a page id|not a section key/);
  });
});
