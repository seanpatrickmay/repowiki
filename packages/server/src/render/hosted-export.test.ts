import { WikiExport } from "@repowiki/core";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { hostedExport } from "./hosted-export.ts";

const exp = WikiExport.parse(fixtureExport());

/** Every way an id could still be named: a quoted value, a link token, a path segment. */
function traces(out: WikiExport, id: string): string[] {
  const text = JSON.stringify(out);
  return [`"${id}"`, `[[${id}]]`, `[[${id}|`, `/wiki/${id}/`].filter((t) => text.includes(t));
}

describe("the hosted export (spec 2 S10, S13; Contract §8; M14e A4)", () => {
  for (const hidden of ["deliverables", "signals"]) {
    it(`is a valid export with no trace of ${hidden}, manifest included`, () => {
      const out = hostedExport(exp, [hidden]);
      expect(() => WikiExport.parse(out)).not.toThrow();
      expect(out.pages.map((p) => p.featureId)).not.toContain(hidden);
      expect(Object.keys(out.history)).not.toContain(hidden);
      expect(out.manifest.features.map((f) => f.id)).not.toContain(hidden);
      expect(traces(out, hidden)).toEqual([]);
    });
  }

  it("drops what pointed only at a hidden feature: its redirects and a disambiguation left with one", () => {
    const out = hostedExport(exp, ["signals"]);
    const ids = out.manifest.features.map((f) => f.id);
    expect(ids).not.toContain("legacy-signals");
    expect(ids).not.toContain("reports");
    expect(Object.values(out.manifest.membership).map((m) => m.featureId)).not.toContain("signals");
  });

  it("removes the hidden feature from the About article's claims, edges, basis and diagram", () => {
    const out = hostedExport(exp, ["deliverables"]);
    const article = out.architecture.at(-1);
    expect(article).toBeDefined();
    expect(article?.edges.some((e) => e.from === "deliverables" || e.to === "deliverables")).toBe(
      false,
    );
    expect(article?.basis).not.toContain("deliverables-1");
    expect(article?.diagram ?? "").not.toContain("Deliverables");
    const claims = article?.sections.flatMap((s) => s.claims) ?? [];
    expect(claims.flatMap((c) => c.pages)).not.toContain("deliverables");
  });

  it("keeps a linked page's words when its link goes, and drops it from See also", () => {
    const out = hostedExport(exp, ["deliverables"]);
    const signals = out.pages.find((p) => p.featureId === "signals");
    expect(JSON.stringify(signals)).toContain("deliverable records");
    expect(signals?.seeAlso).not.toContain("deliverables");
  });

  it("drops People, work in flight, run costs and Wikipedia summaries", () => {
    const out = hostedExport(exp, []);
    expect(out.people).toBeNull();
    expect(out.inflight).toBeNull();
    expect(out.runs).toEqual([]);
    expect(out.wikipedia).toEqual({});
    expect(out.pages).toHaveLength(exp.pages.length);
    expect(out.architecture).toEqual(exp.architecture);
  });
});
