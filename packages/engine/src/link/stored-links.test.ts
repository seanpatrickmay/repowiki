import type { Manifest } from "@repowiki/core";
import { bodyClaim, makeFeature, makeManifest, makeRevision } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { linkViolations, storedLinkViolations } from "./violations.ts";

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

  it("still reports a link that names no feature of its own manifest", () => {
    const crafted = makeRevision({
      featureId: "signals",
      sections: [
        page.sections[0] ?? { key: "lead", claims: [] },
        { key: "overview", claims: [bodyClaim({ text: "See [[nowhere]]." })] },
      ],
    });
    expect(storedLinkViolations(crafted, own, merged, withPages)).toEqual([
      'signals "c-1": a link to "nowhere" is not a feature id',
      'signals: a link to "nowhere" no longer leads to a page',
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
      'signals: a link to "deliverables" no longer leads to a page',
    ]);
    expect(storedLinkViolations(page, own, retired, new Set(["signals", "deliverables"]))).toEqual(
      [],
    );
  });
});
