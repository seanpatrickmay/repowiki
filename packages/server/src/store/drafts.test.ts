import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../app.ts";
import { generatedProject, testDeps } from "../routes/test-app.ts";
import { previewOf, reviewOf, savePreview, saveReview, saveVersion, versionOf } from "./drafts.ts";

let deps: Deps;
let projectId: string;
const AT = "2026-10-14T12:00:00.000Z";
const HASH = "a".repeat(64);

beforeEach(async () => {
  deps = await testDeps();
  ({ projectId } = await generatedProject(deps));
});
afterEach(async () => deps.db.close());

describe("reviews, previews and versions (spec 2 §5)", () => {
  it("keeps the first review of a revision", async () => {
    await saveReview(deps.db, { projectId, revision: 1, attestationVersion: 1, createdAt: AT });
    const later = "2026-10-14T13:00:00.000Z";
    await saveReview(deps.db, { projectId, revision: 1, attestationVersion: 1, createdAt: later });
    expect(await reviewOf(deps.db, projectId, 1)).toMatchObject({ createdAt: AT });
    expect(await reviewOf(deps.db, projectId, 2)).toBeNull();
  });

  it("replaces a revision's preview with its newest build", async () => {
    const preview = {
      projectId,
      revision: 1,
      siteKey: `previews/${projectId}/r1/x/`,
      siteHash: HASH,
      createdAt: AT,
    };
    await savePreview(deps.db, preview);
    await savePreview(deps.db, { ...preview, siteKey: `previews/${projectId}/r1/y/` });
    expect((await previewOf(deps.db, projectId, 1))?.siteKey).toBe(`previews/${projectId}/r1/y/`);
  });

  it("never overwrites a published version", async () => {
    const authorization = {
      checkedAt: AT,
      githubUserId: 1,
      githubRepoId: 2,
      fullName: "a/b",
      visibility: "public" as const,
      isFork: false,
      permission: "admin" as const,
      authoredCommits: 1,
      indexedFiles: null,
      tokenValid: true,
    };
    const version = {
      projectId,
      version: 1,
      revision: 1,
      siteKey: `sites/${projectId}/v1/`,
      siteHash: HASH,
      authorization,
      publishedAt: AT,
    };
    await saveVersion(deps.db, version);
    await expect(saveVersion(deps.db, { ...version, revision: 2 })).rejects.toThrow();
    expect(await versionOf(deps.db, projectId, 1)).toMatchObject({ revision: 1 });
  });
});
