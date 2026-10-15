import { WikiExport } from "@repowiki/core";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { hostedExport } from "./hosted-export.ts";

const exp = WikiExport.parse(fixtureExport());

describe("the hosted export (spec 2 S10, S13; ADR-0012)", () => {
  it("keeps every page, link, history entry and the About article: nothing is hidden", () => {
    const out = hostedExport(exp);
    expect(out.manifest).toEqual(exp.manifest);
    expect(out.pages).toEqual(exp.pages);
    expect(out.history).toEqual(exp.history);
    expect(out.architecture).toEqual(exp.architecture);
  });

  it("drops People, work in flight, run costs and Wikipedia summaries", () => {
    const out = hostedExport(exp);
    expect(() => WikiExport.parse(out)).not.toThrow();
    expect(out.people).toBeNull();
    expect(out.inflight).toBeNull();
    expect(out.runs).toEqual([]);
    expect(out.wikipedia).toEqual({});
  });
});
