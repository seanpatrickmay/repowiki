import { describe, expect, it } from "vitest";
import { EMPTY_OVERRIDES, type Overrides } from "./content.ts";
import type { Result } from "./result.ts";
import { firstRevision, refreshRevision, reviewRevision, saveRevision } from "./revisions.ts";
import { aGeneration, aProject, aReview, aRevision, ids, T0 } from "./test-fixtures.ts";

const T1 = "2026-10-15T00:00:00Z";
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.value;
};
const edited: Overrides = {
  tagline: "My tagline",
  summary: "My summary",
  contribution: "I wrote it.",
  highlights: [{ featureId: "indexing", blurb: "Fast" }],
  hiddenFeatureIds: ["site"],
};

describe("draft revisions (Contract spec §6.3)", () => {
  it("start at revision 1 with empty overrides when the first generation lands", () => {
    expect(firstRevision(aProject(), aGeneration(), T0)).toEqual({
      ok: true,
      value: { project: aProject({ latestRevision: 1 }), revision: aRevision() },
    });
    expect(firstRevision(aProject({ latestRevision: 1 }), aGeneration(), T0)).toMatchObject({
      code: "invalid-transition",
    });
  });

  it("save the author's overrides as a new revision against the latest one only", () => {
    const project = aProject({ latestRevision: 1 });
    const saved = value(saveRevision(project, aRevision(), aGeneration(), 1, edited, T1));
    expect(saved.project.latestRevision).toBe(2);
    expect(saved.revision).toEqual(
      aRevision({ number: 2, overrides: edited, source: "author", createdAt: T1 }),
    );
    expect(saveRevision(project, aRevision(), aGeneration(), 0, edited, T1)).toEqual({
      ok: false,
      code: "stale-revision",
    });
  });

  it("refuse invalid overrides and features the wiki does not have", () => {
    const project = aProject({ latestRevision: 1 });
    expect(
      saveRevision(project, aRevision(), aGeneration(), 1, { ...edited, tagline: "<b>" }, T1),
    ).toMatchObject({ code: "invalid-input" });
    const unknown = { ...edited, hiddenFeatureIds: ["nowhere"] };
    expect(saveRevision(project, aRevision(), aGeneration(), 1, unknown, T1)).toMatchObject({
      code: "invalid-input",
      detail: "unknown feature nowhere",
    });
  });

  it("carry overrides through a refresh and flag what changed under them", () => {
    const project = aProject({ latestRevision: 2 });
    const latest = aRevision({ number: 2, overrides: edited, source: "author" });
    const previous = aGeneration();
    const next = aGeneration({
      id: ids.generation2,
      suggestions: { ...previous.suggestions, summary: "A new summary." },
      facts: { ...previous.facts, featureIds: ["verify", "site"] },
    });
    const refreshed = value(refreshRevision(project, latest, previous, next, T1));
    expect(refreshed.project.latestRevision).toBe(3);
    expect(refreshed.revision).toEqual(
      aRevision({
        number: 3,
        generationId: ids.generation2,
        overrides: edited,
        flags: ["suggestion-changed:summary", "highlight-missing:indexing"],
        source: "generation",
        createdAt: T1,
      }),
    );
  });

  it("raise no flag for a suggestion the author did not override, and keep old flags", () => {
    const project = aProject({ latestRevision: 1 });
    const latest = aRevision({ flags: ["hidden-missing:old"] });
    const previous = aGeneration();
    const next = aGeneration({
      id: ids.generation2,
      suggestions: { ...previous.suggestions, tagline: "Changed", contributionDraft: "Changed" },
    });
    expect(value(refreshRevision(project, latest, previous, next, T1)).revision.flags).toEqual([
      "hidden-missing:old",
    ]);
  });

  it("refuse a refresh that does not build on the latest revision's generation", () => {
    const project = aProject({ latestRevision: 1 });
    const other = aGeneration({ id: ids.generation2 });
    expect(refreshRevision(project, aRevision(), other, other, T1)).toMatchObject({
      code: "invalid-transition",
    });
    expect(
      refreshRevision(aProject({ latestRevision: 2 }), aRevision(), aGeneration(), other, T1),
    ).toMatchObject({ code: "stale-revision" });
  });

  it("review only the latest unflagged revision with a contribution statement", () => {
    const ready = aRevision({ overrides: { ...EMPTY_OVERRIDES, contribution: "I wrote it." } });
    expect(reviewRevision(ready, 1, T0)).toEqual({ ok: true, value: aReview() });
    expect(reviewRevision(ready, 2, T0)).toEqual({ ok: false, code: "stale-revision" });
    expect(reviewRevision({ ...ready, flags: ["hidden-missing:x"] }, 1, T0)).toMatchObject({
      code: "needs-review-flags",
    });
    expect(reviewRevision(aRevision(), 1, T0)).toMatchObject({ code: "contribution-missing" });
    const blank = aRevision({ overrides: { ...EMPTY_OVERRIDES, contribution: "  \n " } });
    expect(reviewRevision(blank, 1, T0)).toMatchObject({ code: "contribution-missing" });
  });
});

describe("records from another project (final review I8)", () => {
  const elsewhere = { projectId: ids.other };
  const project = aProject({ latestRevision: 1 });
  const foreign = { ok: false, code: "invalid-input", detail: "records from another project" };

  it("refuses a first revision from another project's generation", () => {
    expect(firstRevision(aProject(), aGeneration(elsewhere), T0)).toEqual(foreign);
  });

  it("refuses to save over another project's revision or generation", () => {
    expect(saveRevision(project, aRevision(elsewhere), aGeneration(), 1, edited, T1)).toEqual(
      foreign,
    );
    expect(saveRevision(project, aRevision(), aGeneration(elsewhere), 1, edited, T1)).toEqual(
      foreign,
    );
  });

  it("refuses a refresh with another project's revision or generations", () => {
    const next = aGeneration({ id: ids.generation2 });
    expect(refreshRevision(project, aRevision(elsewhere), aGeneration(), next, T1)).toEqual(
      foreign,
    );
    expect(
      refreshRevision(project, aRevision(), aGeneration(), { ...next, ...elsewhere }, T1),
    ).toEqual(foreign);
  });
});
