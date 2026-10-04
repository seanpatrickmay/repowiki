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
      'signals: See also lists "ghost", which has no page',
      'signals: See also lists "legacy-signals", which has no page',
      'signals "lead-1": a link to "nowhere" is not a feature id',
    ]);
  });

  it("reports a [[id]] token whose feature is retired or a redirect, but not an active one", () => {
    const revision = makeRevision();
    const lead = revision.sections[0];
    if (lead?.claims[0] === undefined) throw new Error("fixture has a lead");
    lead.claims[0].text = "[[legacy-signals]] [[retired-thing]] [[billing]] [[deliverables|d]]";
    expect(linkViolations(revision, linkManifest())).toEqual([
      'signals "lead-1": a link to "legacy-signals" is not an active feature id',
      'signals "lead-1": a link to "retired-thing" is not an active feature id',
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
      'signals "lead-1": a link to "../../etc" is not a feature id',
      'signals "lead-1": a link to "javascript:alert(1)" is not a feature id',
      'signals "lead-1": a link to "ghost" is not a feature id',
      'signals "lead-1": a link to "[[billing" is not a feature id',
      'signals "lead-1": a link to "Billing" is not a feature id',
    ]);
  });

  it("quotes a crafted target or claim id, escaping what would hide in a log line", () => {
    const revision = makeRevision({ seeAlso: ["gh\u202Eost"] });
    const lead = revision.sections[0];
    if (lead?.claims[0] === undefined) throw new Error("fixture has a lead");
    lead.claims[0].id = "lead\u202E-1";
    lead.claims[0].text = "[[a\u202Eb]]";
    expect(linkViolations(revision, linkManifest())).toEqual([
      'signals: See also lists "gh\\u202eost", which has no page',
      'signals "lead\\u202e-1": a link to "a\\u202eb" is not a feature id',
    ]);
  });
});
