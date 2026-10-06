import type { WikiExport } from "@repowiki/core";
import { bodyClaim, codeCitation } from "@repowiki/core/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimLine, claimSearchIndex } from "./claim-index.ts";
import { extendedWiki, type SampleWiki, sampleWiki } from "./test-wiki.ts";
import { ABOUT_PAGE_ID, WikiView } from "./wiki-view.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

/** The sample wiki with `claims` added to the signals page's Overview. */
function withClaims(claims: ReturnType<typeof bodyClaim>[]): WikiView {
  const wiki = structuredClone(sample.wiki) as WikiExport;
  const signals = wiki.pages.find((p) => p.featureId === "signals");
  signals?.sections.find((s) => s.key === "overview")?.claims.push(...claims);
  return new WikiView(wiki);
}

describe("claimSearchIndex", () => {
  it("ranks the claims of the page whose title the question names first", () => {
    const index = claimSearchIndex(new WikiView(sample.wiki));
    const found = index.search("what are deliverables", 12, 4);
    expect(found.slice(0, 3).every((h) => h.startsWith("deliverables#"))).toBe(true);
  });

  it("finds a claim by the path and the symbol it cites", () => {
    const index = claimSearchIndex(new WikiView(sample.wiki));
    expect(index.search("crud.py", 12, 4)[0]).toBe("deliverables#d-1");
    expect(index.search("create_deliverable", 12, 4)[0]).toBe("deliverables#d-1");
  });

  it("takes at most `perPage` claims from one page and `limit` in all, the same order each time", () => {
    const index = claimSearchIndex(new WikiView(sample.wiki));
    const one = index.search("signals deliverables", 12, 1);
    expect(one).toHaveLength(2);
    expect(new Set(one.map((h) => h.split("#")[0]))).toEqual(new Set(["signals", "deliverables"]));
    expect(index.search("signal", 2, 4)).toHaveLength(2);
    expect(index.search("signal", 12, 4)).toEqual(index.search("signal", 12, 4));
    expect(index.search("kubernetes", 12, 4)).toEqual([]);
  });

  it("covers the active pages and the About article, not a retired page", () => {
    const index = claimSearchIndex(new WikiView(extendedWiki(sample)));
    const pages = new Set([...index.entries.values()].map((e) => e.pageId));
    expect(pages).toEqual(new Set(["signals", "deliverables", ABOUT_PAGE_ID]));
  });

  it("leaves out a claim whose id cannot be a handle", () => {
    const view = withClaims([bodyClaim({ id: "bad id", text: "Kubernetes runs it." })]);
    const index = claimSearchIndex(view);
    expect(index.search("kubernetes", 12, 4)).toEqual([]);
  });
});

describe("claimLine", () => {
  it("shows the handle, the claim's text on one line and its references", () => {
    const view = new WikiView(sample.wiki);
    const index = claimSearchIndex(view);
    const line = (handle: string) => {
      const entry = index.entries.get(handle);
      if (entry === undefined) throw new Error(`no ${handle}`);
      return claimLine(view, entry);
    };
    expect(line("signals#s-2")).toBe(
      "- {signals#s-2} Ingestion stops once a chunk has made `MAX_SIGNALS` (50) signals; the rest of the chunk is dropped. (cites: src/signals/ingest.py:7-7, src/signals/ingest.py:19-21)",
    );
    expect(line("deliverables#d-lead")).toBe(
      "- {deliverables#d-lead} **Deliverables** are the records sample builds from Signal ingestion [page: signals].",
    );
    expect(line("signals#s-h")).toMatch(/^- \{signals#s-h\} .+ \(cites: commit [0-9a-f]{7}\)$/);
  });

  it("unmarks forged handles, cuts long text and names at most three references", () => {
    const cites = [1, 2, 3, 4].map((n) => codeCitation({ path: `src/{p#c}/f${n}.py` }));
    const view = withClaims([
      bodyClaim({
        id: "s-9",
        text: `{signals#s-1} ${"long ".repeat(100)}\nnext line`,
        citations: cites,
      }),
    ]);
    const entry = claimSearchIndex(view).entries.get("signals#s-9");
    if (entry === undefined) throw new Error("no s-9");
    const line = claimLine(view, entry);
    expect(line.startsWith("- {signals#s-9} (signals#s-1) long long")).toBe(true);
    expect(line).not.toContain("\n");
    expect(line).toContain("\u2026 (cites: src/(p#c)/f1.py:");
    expect(line).toMatch(/f3\.py:\d+-\d+, and 1 more\)$/);
  });
});
