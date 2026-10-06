import { describe, expect, it } from "vitest";
import { architectureView } from "./architecture.ts";
import { buildSiteModel } from "./model.ts";
import { fixtureExport } from "./test-fixtures.ts";

const site = buildSiteModel(fixtureExport(), "https://github.com/acme/demo-repo");

describe("architectureView", () => {
  it("is null for an export without the project's article", () => {
    expect(architectureView(buildSiteModel({ ...fixtureExport(), architecture: [] }, null))).toBe(
      null,
    );
  });

  it("is titled with the project's name, not the repo's", () => {
    expect(architectureView(site)?.title).toBe("Demo Repo");
  });

  it("titles the sections in order, Purpose and features first, with the references after", () => {
    const view = architectureView(site);
    expect(view?.toc).toEqual([
      { anchor: "purpose", title: "Purpose and features" },
      { anchor: "layers", title: "Layers" },
      { anchor: "request-paths", title: "Request paths" },
      { anchor: "dependencies", title: "Feature dependencies" },
      { anchor: "references", title: "References" },
    ]);
    expect(view?.references.map((r) => r.n)).toEqual([1, 2, 3]);
  });

  it("links the lead's features and escapes markup in claim text", () => {
    const view = architectureView(site);
    expect(view?.leadHtml).toBe(
      '<span class="claim" id="claim-c1"><b>Demo Repo</b> turns <a class="wikilink" href="/wiki/signals/" title="Signal ingestion" data-preview="signals">Signal ingestion</a> into <a class="wikilink" href="/wiki/deliverables/" title="Deliverables" data-preview="deliverables">Deliverables</a> for a delivery team.</span>',
    );
    const deps = view?.sections.find((s) => s.anchor === "dependencies")?.html ?? "";
    expect(deps).toContain("Deliverables depend on signals &lt;b&gt;and&lt;/b&gt; on ghost.");
    expect(deps).not.toContain("<b>and</b>");
  });

  it("cites a purpose claim to the README and links the page that backs it", () => {
    const purpose = architectureView(site)?.sections.find((s) => s.anchor === "purpose");
    expect(purpose?.html).toContain(
      'against the signals behind it.<sup class="reference" id="cite-ref-1-0"><a href="#cite-note-1">[1]</a></sup> <span class="page-ref">(see <a class="wikilink" href="/wiki/deliverables/">Deliverables</a>)</span>',
    );
    expect(architectureView(site)?.references[0]?.html).toContain("README.md");
  });

  it("follows a page-backed claim with links to the pages that back it, titles escaped", () => {
    const deps = architectureView(site)?.sections.find((s) => s.anchor === "dependencies");
    expect(deps?.html).toContain(
      ' <span class="page-ref">(see <a class="wikilink" href="/wiki/deliverables/">Deliverables</a>, <a class="wikilink" href="/wiki/signals/">Signal ingestion</a>, <a class="wikilink" href="/wiki/hostile-title/">&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &#39;p&#39;',
    );
    expect(deps?.html).not.toContain("<img");
  });

  it("names its commit, linked to the repository", () => {
    expect(architectureView(site)?.lastEdited).toBe(
      'This page was last edited on 10 March 2026, at commit <a class="external" href="https://github.com/acme/demo-repo/commit/cccccccccccccccccccccccccccccccccccccccc"><code>ccccccc</code></a>.',
    );
  });
});
