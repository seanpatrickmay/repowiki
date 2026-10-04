import type { Manifest } from "@repowiki/core";
import {
  architectureClaim,
  bodyClaim,
  makeArchitecture,
  makeFeature,
  makeManifest,
  makeRevision,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  linkViolations,
  storedArchitectureLinkViolations,
  storedLinkViolations,
} from "./violations.ts";

/** A signals page written when deliverables was active, linking to it twice. */
const page = makeRevision({
  featureId: "signals",
  seeAlso: ["deliverables"],
  sections: [
    { key: "lead", claims: [makeRevision().sections[0]?.claims[0] ?? bodyClaim()] },
    {
      key: "overview",
      claims: [bodyClaim({ text: "Signals feed [[deliverables|deliverable tracking]]." })],
    },
  ],
});
const own = makeManifest();
/** The latest manifest: deliverables merged into tasks. */
const merged: Manifest = makeManifest({
  features: [
    makeFeature(),
    makeFeature({
      id: "deliverables",
      title: "Deliverables",
      status: { kind: "redirect", to: "tasks" },
    }),
    makeFeature({ id: "tasks", title: "Tasks" }),
  ],
});
const withPages = new Set(["signals", "tasks"]);

describe("storedLinkViolations", () => {
  it("judges a carried page against the manifest at its own sha, not the latest", () => {
    // The M4 check reports links the linker wrote correctly at the time.
    expect(linkViolations(page, merged)).toHaveLength(2);
    expect(storedLinkViolations(page, own, merged, withPages)).toEqual([]);
  });

  it("reports a link that names no feature of its own manifest once, with its claim id", () => {
    const crafted = makeRevision({
      featureId: "signals",
      sections: [
        page.sections[0] ?? { key: "lead", claims: [] },
        { key: "overview", claims: [bodyClaim({ text: "See [[nowhere]]." })] },
      ],
    });
    expect(storedLinkViolations(crafted, own, merged, withPages)).toEqual([
      'signals "c-1": a link to "nowhere" is not a feature id',
    ]);
  });

  it("reports a link whose target retired with no page since", () => {
    const retired = makeManifest({
      features: [
        makeFeature(),
        makeFeature({ id: "deliverables", title: "Deliverables", status: { kind: "retired" } }),
      ],
    });
    expect(storedLinkViolations(page, own, retired, new Set(["signals"]))).toEqual([
      'signals: See also lists "deliverables", which no longer leads to a page',
      'signals "c-1": a link to "deliverables" no longer leads to a page',
    ]);
    expect(storedLinkViolations(page, own, retired, new Set(["signals", "deliverables"]))).toEqual(
      [],
    );
  });
});

describe("storedArchitectureLinkViolations", () => {
  const article = (text: string, pages: string[]) =>
    makeArchitecture({
      sections: [{ key: "purpose", claims: [architectureClaim({ id: "a-1", text, pages })] }],
    });
  const retired = makeManifest({
    features: [
      makeFeature(),
      makeFeature({ id: "deliverables", title: "Deliverables", status: { kind: "retired" } }),
    ],
  });

  it("accepts a link and a named page that merged into a redirect, or that are active without a page", () => {
    const old = article("Signals feed [[deliverables]].", ["deliverables"]);
    expect(storedArchitectureLinkViolations(old, own, merged, withPages)).toEqual([]);
    expect(storedArchitectureLinkViolations(old, own, own, new Set())).toEqual([]);
  });

  it("reports a link and a named page that retired with no page, and accepts them with one", () => {
    const old = article("Signals feed [[deliverables]].", ["deliverables"]);
    expect(storedArchitectureLinkViolations(old, own, retired, new Set(["signals"]))).toEqual([
      'architecture "a-1": a link to "deliverables" no longer leads to a page',
      'architecture "a-1": names "deliverables", which no longer leads to a page',
    ]);
    expect(
      storedArchitectureLinkViolations(old, own, retired, new Set(["signals", "deliverables"])),
    ).toEqual([]);
  });

  it("reports a named page the latest manifest no longer holds, and a never-valid link once", () => {
    const gone = makeManifest({ features: [makeFeature()] });
    expect(
      storedArchitectureLinkViolations(
        article("See [[nowhere]].", ["deliverables"]),
        own,
        gone,
        withPages,
      ),
    ).toEqual([
      'architecture "a-1": a link to "nowhere" is not a feature id',
      'architecture "a-1": names "deliverables", which no longer leads to a page',
    ]);
  });
});
