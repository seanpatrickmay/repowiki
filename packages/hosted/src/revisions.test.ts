import { describe, expect, it } from "vitest";
import type { Result } from "./result.ts";
import { firstRevision, refreshRevision, reviewRevision } from "./revisions.ts";
import { aContent, aGeneration, aProject, aReview, aRevision, ids, T0 } from "./test-fixtures.ts";

const T1 = "2026-10-15T00:00:00Z";
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.value;
};
const fresh = aContent({ summary: "A new summary.", highlights: [] });

describe("draft revisions (Contract spec §6.3, ADR-0012)", () => {
  it("start at revision 1 with the generated content when the first generation lands", () => {
    expect(firstRevision(aProject(), aGeneration(), aContent(), T0)).toEqual({
      ok: true,
      value: { project: aProject({ latestRevision: 1 }), revision: aRevision() },
    });
    expect(
      firstRevision(aProject({ latestRevision: 1 }), aGeneration(), aContent(), T0),
    ).toMatchObject({ code: "invalid-transition" });
  });

  it("refuse content the Contract does not allow", () => {
    const markup = aContent({ contribution: "<b>me</b>" });
    expect(firstRevision(aProject(), aGeneration(), markup, T0)).toMatchObject({
      code: "invalid-input",
    });
    const blank = aContent({ contribution: "  " });
    expect(firstRevision(aProject(), aGeneration(), blank, T0)).toMatchObject({
      code: "invalid-input",
    });
  });

  it("take a refresh's own content and carry nothing forward", () => {
    const project = aProject({ latestRevision: 2 });
    const next = aGeneration({ id: ids.generation2 });
    const refreshed = value(refreshRevision(project, aRevision({ number: 2 }), next, fresh, T1));
    expect(refreshed.project.latestRevision).toBe(3);
    expect(refreshed.revision).toEqual(
      aRevision({ number: 3, generationId: ids.generation2, content: fresh, createdAt: T1 }),
    );
    expect(
      refreshRevision(aProject({ latestRevision: 2 }), aRevision(), next, fresh, T1),
    ).toMatchObject({ code: "stale-revision" });
  });

  it("review only the latest revision, with attestation 2", () => {
    expect(reviewRevision(aRevision(), 1, T0)).toEqual({ ok: true, value: aReview() });
    expect(reviewRevision(aRevision(), 2, T0)).toEqual({ ok: false, code: "stale-revision" });
  });
});

describe("records from another project (final review I8)", () => {
  const elsewhere = { projectId: ids.other };
  const project = aProject({ latestRevision: 1 });
  const foreign = { ok: false, code: "invalid-input", detail: "records from another project" };

  it("refuses a first revision from another project's generation", () => {
    expect(firstRevision(aProject(), aGeneration(elsewhere), aContent(), T0)).toEqual(foreign);
  });

  it("refuses a refresh with another project's revision or generation", () => {
    const next = aGeneration({ id: ids.generation2 });
    expect(refreshRevision(project, aRevision(elsewhere), next, fresh, T1)).toEqual(foreign);
    expect(refreshRevision(project, aRevision(), { ...next, ...elsewhere }, fresh, T1)).toEqual(
      foreign,
    );
  });
});
