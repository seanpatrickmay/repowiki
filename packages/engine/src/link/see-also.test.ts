import { makeRevision } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { featureNeighbours, seeAlsoFor } from "./see-also.ts";
import { linkManifest } from "./test-manifest.ts";
import { linkViolations } from "./violations.ts";

const graph = {
  nodes: [],
  edges: [
    { a: "src/deliverables/crud.py", b: "src/signals/ingest.py", weight: 1 },
    { a: "src/deliverables/api.py", b: "src/signals/score.py", weight: 0.5 },
    { a: "src/billing/invoice.py", b: "src/signals/ingest.py", weight: 1.5 },
    { a: "src/signals/ingest.py", b: "src/signals/score.py", weight: 9 },
    { a: "src/signals/ingest.py", b: "untracked/x.py", weight: 9 },
  ],
};

describe("seeAlsoFor", () => {
  it("lists neighbours by combined edge weight, heaviest first", () => {
    const neighbours = featureNeighbours(graph, linkManifest());
    expect(neighbours.get("signals")).toEqual(
      new Map([
        ["deliverables", 1.5],
        ["billing", 1.5],
      ]),
    );
    expect(seeAlsoFor("signals", neighbours, linkManifest())).toEqual(["billing", "deliverables"]);
    expect(seeAlsoFor("signals", neighbours, linkManifest(), 1)).toEqual(["billing"]);
  });

  it("never lists an id that is not an active feature (spec §8)", () => {
    const neighbours = new Map([
      [
        "signals",
        new Map([
          ["legacy-signals", 5],
          ["ghost", 4],
          ["signals", 3],
          ["billing", 1],
        ]),
      ],
    ]);
    expect(seeAlsoFor("signals", neighbours, linkManifest())).toEqual(["billing"]);
    expect(seeAlsoFor("ghost", neighbours, linkManifest())).toEqual([]);
  });
});

describe("linkViolations", () => {
  it("passes a revision whose links all name pages", () => {
    expect(linkViolations(makeRevision(), linkManifest())).toEqual([]);
  });

  it("reports See also ids without a page and [[id]] tokens outside the manifest", () => {
    const revision = makeRevision({ seeAlso: ["ghost", "legacy-signals", "billing"] });
    const lead = revision.sections[0];
    if (lead?.claims[0] === undefined) throw new Error("fixture has a lead");
    lead.claims[0].text = "Links [[nowhere]], [[wp:Cron]], [[billing|bills]] and `[[skip]]`.";
    expect(linkViolations(revision, linkManifest())).toEqual([
      "signals: See also lists ghost, which has no page",
      "signals: See also lists legacy-signals, which has no page",
      "signals lead-1: [[nowhere]] is not a feature id",
    ]);
  });

  it("reports every token the site would render that names no feature", () => {
    const revision = makeRevision();
    const lead = revision.sections[0];
    if (lead?.claims[0] === undefined) throw new Error("fixture has a lead");
    lead.claims[0].text = [
      "[[../../etc]]",
      "[[javascript:alert(1)]]",
      "[[ghost|x]]b]]",
      "[[billing|a]]b]]",
      "[[[[billing]]]]",
      "[[Billing|y`z`]]",
      "`[[inside]]`",
    ].join(" ");
    expect(linkViolations(revision, linkManifest())).toEqual([
      "signals lead-1: [[../../etc]] is not a feature id",
      "signals lead-1: [[javascript:alert(1)]] is not a feature id",
      "signals lead-1: [[ghost]] is not a feature id",
      "signals lead-1: [[[[billing]] is not a feature id",
      "signals lead-1: [[Billing]] is not a feature id",
    ]);
  });
});
