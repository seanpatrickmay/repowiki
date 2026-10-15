import type {
  DraftRevision,
  EligibilityFacts,
  Preview,
  Project,
  PublishedVersion,
  Review,
} from "./entities.ts";
import { ok, type Result, refused } from "./result.ts";
import { fromAnotherProject } from "./revisions.ts";
import { siteKey } from "./urls.ts";

export interface PublishInput {
  project: Project;
  /** The project's latest revision. */
  latest: DraftRevision;
  /** The review of the revision being published, if any. */
  review: Review | null;
  /** The stored preview of the revision being published, if any. */
  preview: Preview | null;
  /** The project's current published version, if any. */
  current: PublishedVersion | null;
  /** What the author asked to publish, the version they saw, and the preview they saw. */
  revision: number;
  expectedVersion: number;
  previewHash: string;
  /** The live eligibility check the policy accepted (§7). */
  authorization: EligibilityFacts;
  now: string;
}

/**
 * Promote the exact previewed site of a reviewed revision to the next published version (§6.4).
 * Authorization is the policy's job and comes first; this checks the draft, version and bytes.
 */
export function publish(
  input: PublishInput,
): Result<{ project: Project; version: PublishedVersion; created: boolean }> {
  const { project, latest, review, preview, current, revision } = input;
  const republish = project.state === "withdrawn" && project.withdrawReason === "author";
  if (project.state !== "draft" && project.state !== "published" && !republish) {
    return refused("invalid-transition");
  }
  if (input.authorization.githubRepoId !== project.githubRepoId) {
    return refused("invalid-input", "authorization is for another repository");
  }
  if (fromAnotherProject(project, latest, review, preview, current)) {
    return refused("invalid-input", "records from another project");
  }
  if (
    project.state === "published" &&
    current !== null &&
    current.version === project.currentVersion &&
    current.revision === revision
  ) {
    return ok({ project, version: current, created: false });
  }
  if (revision !== latest.number || latest.number !== project.latestRevision) {
    return refused("stale-revision");
  }
  if (review === null || review.revision !== revision) return refused("not-reviewed");
  if (input.expectedVersion !== project.currentVersion) return refused("stale-publication");
  if (preview === null || preview.revision !== revision || preview.siteHash !== input.previewHash) {
    return refused("preview-mismatch");
  }
  const number = project.currentVersion + 1;
  const version: PublishedVersion = {
    projectId: project.id,
    version: number,
    revision,
    siteKey: siteKey(project.id, number),
    siteHash: preview.siteHash,
    authorization: input.authorization,
    publishedAt: input.now,
  };
  return ok({
    project: {
      ...project,
      state: "published",
      withdrawReason: null,
      withdrawnAt: null,
      unavailableSince: null,
      currentVersion: number,
    },
    version,
    created: true,
  });
}
