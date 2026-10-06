import { describe, expect, it } from "vitest";
import { claimHref, pageHref, sectionHref } from "./hrefs.ts";
import { ABOUT_PAGE_ID } from "./wiki-view.ts";

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
});
