import { describe, expect, it } from "vitest";
import { buildSiteModel } from "./model.ts";
import { previewData } from "./preview.ts";
import { fixtureExport, HOSTILE_TITLE } from "./test-fixtures.ts";

const site = buildSiteModel(fixtureExport(), null);

describe("previewData", () => {
  it("shows the link-free lead and key facts of an article", () => {
    expect(previewData(site, "deliverables")).toEqual({
      title: "Deliverables",
      url: "/wiki/deliverables/",
      html: '<p><b>Deliverables</b> are the records that Signal ingestion feed.</p><p class="preview-facts">2 files &middot; 410 lines &middot; Python &middot; last commit 20 February 2026</p>',
    });
  });

  it("previews a redirect as its target", () => {
    expect(previewData(site, "legacy-signals")).toEqual(previewData(site, "signals"));
    expect(previewData(site, "signals")?.html).not.toContain("<a ");
  });

  it("lists the targets of a disambiguation", () => {
    expect(previewData(site, "reports")?.html).toBe(
      "<p><b>Reports</b> may refer to: Signal ingestion, Deliverables.</p>",
    );
  });

  it("has nothing for features without a page", () => {
    expect(previewData(site, "scheduler")).toBeNull();
    expect(previewData(site, "ghost")).toBeNull();
  });

  it("keeps the title plain text and escapes everything in the html", () => {
    const preview = previewData(site, "hostile-title");
    // The client inserts the title with textContent, so it must not be pre-escaped.
    expect(preview?.title).toBe(HOSTILE_TITLE);
    expect(preview?.html).toMatch(/^<p>She said &quot;hi&quot; and it&#39;s fine\.<\/p>/);
    expect(preview?.html).not.toContain("<img");
    expect(preview?.html).not.toMatch(/[]/);
  });
});
