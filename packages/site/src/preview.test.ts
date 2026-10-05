import { describe, expect, it } from "vitest";
import { buildSiteModel } from "./model.ts";
import { inlineOptions, previewData, wikipediaPreviews } from "./preview.ts";
import { EXPONENTIAL_BACKOFF, fixtureExport, HOSTILE_TITLE } from "./test-fixtures.ts";

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

  it("computes each id's preview once per site and returns the same object after", () => {
    const fresh = buildSiteModel(fixtureExport(), null);
    const first = previewData(fresh, "deliverables");
    expect(previewData(fresh, "deliverables")).toBe(first);
    expect(first).toEqual(previewData(site, "deliverables"));
    expect(previewData(fresh, "ghost")).toBeNull();
    // Another site model gets its own previews, never this one's.
    const other = buildSiteModel({ ...fixtureExport(), repo: "other" }, null);
    expect(previewData(other, "deliverables")).not.toBe(first);
    expect(previewData(other, "deliverables")).toEqual(first);
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
    expect(preview?.html).not.toMatch(/[\uE000\uE001]/);
  });
});

describe("wikipediaPreviews", () => {
  const HASH = "bc5383acbe963e3deb31c1ff3a4b9a03";

  it("has one preview per title, under a hash of the normalized title", () => {
    expect([...wikipediaPreviews(site).keys()]).toEqual([HASH]);
    expect(wikipediaPreviews(site).get(HASH)).toEqual({
      title: "Exponential backoff",
      url: "https://en.wikipedia.org/wiki/Exponential_backoff",
      html: `<p>${EXPONENTIAL_BACKOFF.extract}</p><p class="preview-facts">From Wikipedia</p>`,
    });
  });

  it("is computed once per site", () => {
    expect(wikipediaPreviews(site)).toBe(wikipediaPreviews(site));
  });

  it("escapes the untrusted summary and keeps the title plain text", () => {
    const hostile = {
      title: "<b>T</b> & co",
      extract: `<img src=x onerror=alert(1)> "q" & 'p' ${String.fromCharCode(0xe000)}`,
      url: "https://en.wikipedia.org/wiki/T",
    };
    const other = buildSiteModel({ ...fixtureExport(), wikipedia: { T: hostile } }, null);
    const [preview] = [...wikipediaPreviews(other).values()];
    expect(preview?.title).toBe("<b>T</b> & co");
    expect(preview?.html).toBe(
      `<p>&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &#39;p&#39; ${String.fromCharCode(0xe000)}</p><p class="preview-facts">From Wikipedia</p>`,
    );
  });

  it("has no preview for a summary without text", () => {
    const empty = { ...EXPONENTIAL_BACKOFF, extract: " " };
    const other = buildSiteModel({ ...fixtureExport(), wikipedia: { X: empty } }, null);
    expect(wikipediaPreviews(other).size).toBe(0);
  });

  it("finds a title however the link spells it, and keeps prototype names out", () => {
    const ask = inlineOptions(site).wikipedia;
    expect(ask?.("Exponential backoff")).toBe(`wp:${HASH}`);
    expect(ask?.("exponential_backoff")).toBe(`wp:${HASH}`);
    expect(ask?.("  Exponential   backoff ")).toBe(`wp:${HASH}`);
    expect(ask?.("Linear backoff")).toBeNull();
    expect(ask?.("constructor")).toBeNull();
    expect(ask?.("__proto__")).toBeNull();
  });
});
