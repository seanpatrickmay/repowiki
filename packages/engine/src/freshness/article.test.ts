import type { Revision } from "@repowiki/core";
import {
  architectureClaim,
  leadClaim,
  makeArchitecture,
  makeFeature,
  makeManifest,
  makeRevision,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { articleDue } from "./article.ts";

const signals = makeRevision({ id: "signals-1", featureId: "signals" });
const deliverables = makeRevision({ id: "deliverables-1", featureId: "deliverables" });
const stored = new Map([signals, deliverables].map((r) => [r.id, r]));
const revisionOf = (id: string): Revision | null => stored.get(id) ?? null;
const article = makeArchitecture({ basis: ["deliverables-1", "signals-1"] });
const manifest = makeManifest();

/** `revision` as a new revision of its feature, with `lead` as its lead's text. */
const next = (revision: Revision, lead: string): Revision => ({
  ...revision,
  id: `${revision.featureId}-2`,
  parentId: revision.id,
  reason: "update",
  sections: revision.sections.map((s) =>
    s.key === "lead" ? { ...s, claims: [leadClaim({ text: lead })] } : s,
  ),
});

describe("articleDue", () => {
  it("carries the article forward while its basis still reads the same", () => {
    expect(articleDue(article, [deliverables, signals], manifest, revisionOf)).toBeNull();
    // A new revision whose lead is word for word the old one changes nothing the article says.
    const same = next(signals, signals.sections[0]?.claims[0]?.text ?? "");
    expect(articleDue(article, [deliverables, same], manifest, revisionOf)).toBeNull();
  });

  it("is due when there is no article and enough pages", () => {
    expect(articleDue(null, [deliverables, signals], manifest, revisionOf)).toBe("no article");
    expect(articleDue(null, [signals], manifest, revisionOf)).toBeNull();
  });

  it("is due when a backing page's lead changed", () => {
    const moved = next(signals, "**Signal ingestion** now drains signals in batches.");
    expect(articleDue(article, [deliverables, moved], manifest, revisionOf)).toBe("a lead changed");
  });

  it("is due when the features with a page changed", () => {
    const reports = makeRevision({ id: "reports-1", featureId: "reports" });
    const three = [deliverables, reports, signals];
    expect(articleDue(article, three, manifest, revisionOf)).toBe("features changed");
    const gone = makeArchitecture({ basis: ["deliverables-1", "missing-1", "signals-1"] });
    expect(articleDue(gone, [deliverables, signals], manifest, revisionOf)).toBe(
      "features changed",
    );
  });

  it("is due when a claim names a feature that retired or merged", () => {
    const naming = makeArchitecture({
      basis: ["deliverables-1", "signals-1"],
      sections: [
        ...article.sections,
        { key: "purpose", claims: [architectureClaim({ id: "a-9", pages: ["legacy"] })] },
      ],
    });
    const retired = makeManifest({
      features: [...manifest.features, makeFeature({ id: "legacy", status: { kind: "retired" } })],
    });
    expect(articleDue(naming, [deliverables, signals], retired, revisionOf)).toBe(
      "names an inactive feature",
    );
  });

  it("keeps the stored article as it is when fewer than two pages are left", () => {
    expect(articleDue(article, [signals], manifest, revisionOf)).toBeNull();
  });
});
