import { describe, expect, it } from "vitest";
import { EMPTY_OVERRIDES } from "./content.ts";
import { type PublishInput, publish } from "./publish.ts";
import {
  aPreview,
  aProject,
  aPublishedVersion,
  aReview,
  aRevision,
  eligibleFacts,
  HASH,
  ids,
  T0,
} from "./test-fixtures.ts";

const T1 = "2026-10-15T00:00:00Z";
const ready = aRevision({ overrides: { ...EMPTY_OVERRIDES, contribution: "I wrote it." } });
const input = (patch: Partial<PublishInput> = {}): PublishInput => ({
  project: aProject({ latestRevision: 1 }),
  latest: ready,
  review: aReview(),
  preview: aPreview(),
  current: null,
  revision: 1,
  expectedVersion: 0,
  previewHash: HASH,
  authorization: eligibleFacts({ checkedAt: T1 }),
  now: T1,
  ...patch,
});

describe("publish (Contract spec §6.4)", () => {
  it("creates version 1 from the previewed bytes with the eligibility snapshot", () => {
    expect(publish(input())).toEqual({
      ok: true,
      value: {
        project: aProject({ latestRevision: 1, state: "published", currentVersion: 1 }),
        version: aPublishedVersion({
          authorization: eligibleFacts({ checkedAt: T1 }),
          publishedAt: T1,
        }),
        created: true,
      },
    });
  });

  it("republishes an author-withdrawn project at the next version", () => {
    const project = aProject({
      latestRevision: 1,
      state: "withdrawn",
      withdrawReason: "author",
      withdrawnAt: T0,
      currentVersion: 1,
    });
    const result = publish(input({ project, expectedVersion: 1 }));
    expect(result).toMatchObject({
      ok: true,
      value: {
        project: { state: "published", currentVersion: 2, withdrawReason: null, withdrawnAt: null },
        version: { version: 2, siteKey: `sites/${ids.project}/v2/` },
      },
    });
  });

  it("is a no-op for the revision that is already current", () => {
    const project = aProject({ latestRevision: 1, state: "published", currentVersion: 1 });
    const current = aPublishedVersion();
    expect(publish(input({ project, current, expectedVersion: 1 }))).toEqual({
      ok: true,
      value: { project, version: current, created: false },
    });
  });

  it("refuses each failed condition on its own", () => {
    expect(publish(input({ revision: 2 }))).toMatchObject({ code: "stale-revision" });
    expect(publish(input({ latest: { ...ready, flags: ["highlight-missing:x"] } }))).toMatchObject({
      code: "needs-review-flags",
    });
    expect(publish(input({ latest: aRevision() }))).toMatchObject({
      code: "contribution-missing",
    });
    expect(publish(input({ review: null }))).toMatchObject({ code: "not-reviewed" });
    expect(publish(input({ review: aReview({ revision: 2 }) }))).toMatchObject({
      code: "not-reviewed",
    });
    expect(publish(input({ expectedVersion: 1 }))).toMatchObject({ code: "stale-publication" });
    expect(publish(input({ preview: null }))).toMatchObject({ code: "preview-mismatch" });
    expect(publish(input({ previewHash: "c".repeat(64) }))).toMatchObject({
      code: "preview-mismatch",
    });
    expect(publish(input({ preview: aPreview({ revision: 2 }) }))).toMatchObject({
      code: "preview-mismatch",
    });
  });

  it("refuses an eligibility check for another repository or user", () => {
    const project = aProject({ latestRevision: 1 });
    expect(
      publish(input({ project, authorization: eligibleFacts({ githubRepoId: 999 }) })),
    ).toMatchObject({ code: "invalid-input", detail: "authorization is for another repository" });
  });

  it("refuses a project withdrawn for any reason but the author's, or purged", () => {
    for (const withdrawReason of ["repository", "operator", "account-deleted"] as const) {
      const project = aProject({
        latestRevision: 1,
        state: "withdrawn",
        withdrawReason,
        withdrawnAt: T0,
      });
      expect(publish(input({ project }))).toMatchObject({ code: "invalid-transition" });
    }
  });
});

describe("records from another project (final review I8)", () => {
  const elsewhere = { projectId: ids.other };
  const foreign = { ok: false, code: "invalid-input", detail: "records from another project" };

  it("refuses another project's revision, review, preview or current version", () => {
    expect(publish(input({ latest: { ...ready, ...elsewhere } }))).toEqual(foreign);
    expect(publish(input({ review: aReview(elsewhere) }))).toEqual(foreign);
    expect(publish(input({ preview: aPreview(elsewhere) }))).toEqual(foreign);
    const project = aProject({ latestRevision: 1, state: "published", currentVersion: 1 });
    const current = aPublishedVersion(elsewhere);
    expect(publish(input({ project, current, expectedVersion: 1 }))).toEqual(foreign);
  });

  it("stops the purge clock when an author-withdrawn project is published again", () => {
    const project = aProject({
      latestRevision: 1,
      state: "withdrawn",
      withdrawReason: "author",
      withdrawnAt: T0,
      unavailableSince: T0,
      currentVersion: 1,
    });
    expect(publish(input({ project, expectedVersion: 1 }))).toMatchObject({
      value: { project: { state: "published", unavailableSince: null } },
    });
  });
});
