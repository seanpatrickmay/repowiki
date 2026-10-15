import { ATTESTATION_VERSION, EMPTY_OVERRIDES, Overrides } from "./content.ts";
import type { DraftRevision, Generation, Project, Review } from "./entities.ts";
import { ok, type Result, refused } from "./result.ts";

type Revised = Result<{ project: Project; revision: DraftRevision }>;

/** Whether any of `records` belongs to a project other than `project` (a caller bug or a leak). */
export function fromAnotherProject(
  project: Project,
  ...records: readonly ({ projectId: string } | null)[]
): boolean {
  return records.some((r) => r !== null && r.projectId !== project.id);
}

const foreign = () => refused("invalid-input", "records from another project");

const next = (project: Project, revision: DraftRevision): Revised =>
  ok({ project: { ...project, latestRevision: revision.number }, revision });

/** Revision 1, when a project's first generation lands (§6.3). */
export function firstRevision(project: Project, generation: Generation, now: string): Revised {
  if (fromAnotherProject(project, generation)) return foreign();
  if (project.latestRevision !== 0) return refused("invalid-transition");
  return next(project, {
    projectId: project.id,
    number: 1,
    generationId: generation.id,
    overrides: EMPTY_OVERRIDES,
    flags: [],
    source: "generation",
    createdAt: now,
  });
}

/**
 * A refresh landed: the latest overrides carry forward onto the new generation, flagged where
 * the generated text under an override changed or a highlighted feature disappeared (§6.3).
 */
export function refreshRevision(
  project: Project,
  latest: DraftRevision,
  previous: Generation,
  generation: Generation,
  now: string,
): Revised {
  if (fromAnotherProject(project, latest, previous, generation)) return foreign();
  if (latest.number !== project.latestRevision) return refused("stale-revision");
  if (latest.generationId !== previous.id) return refused("invalid-transition");
  const { overrides } = latest;
  const was = previous.suggestions;
  const is = generation.suggestions;
  const features = new Set(generation.facts.featureIds);
  const flags = [
    ...latest.flags,
    ...(overrides.tagline !== undefined && was.tagline !== is.tagline
      ? ["suggestion-changed:tagline"]
      : []),
    ...(overrides.summary !== undefined && was.summary !== is.summary
      ? ["suggestion-changed:summary"]
      : []),
    ...(overrides.contribution !== "" && was.contributionDraft !== is.contributionDraft
      ? ["suggestion-changed:contribution"]
      : []),
    ...overrides.highlights
      .filter((h) => !features.has(h.featureId))
      .map((h) => `highlight-missing:${h.featureId}`),
  ];
  return next(project, {
    projectId: project.id,
    number: latest.number + 1,
    generationId: generation.id,
    overrides,
    flags: [...new Set(flags)],
    source: "generation",
    createdAt: now,
  });
}

/** The author saves overrides made against `baseRevision`; saving clears every flag (§6.3). */
export function saveRevision(
  project: Project,
  latest: DraftRevision,
  generation: Generation,
  baseRevision: number,
  input: unknown,
  now: string,
): Revised {
  if (fromAnotherProject(project, latest, generation)) return foreign();
  if (baseRevision !== latest.number || latest.number !== project.latestRevision) {
    return refused("stale-revision");
  }
  if (generation.id !== latest.generationId) return refused("invalid-transition");
  const parsed = Overrides.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refused("invalid-input", `${issue?.path.join(".") || "overrides"}: ${issue?.message}`);
  }
  const features = new Set(generation.facts.featureIds);
  const unknown = parsed.data.highlights.map((h) => h.featureId).find((id) => !features.has(id));
  if (unknown !== undefined) return refused("invalid-input", `unknown feature ${unknown}`);
  return next(project, {
    projectId: project.id,
    number: latest.number + 1,
    generationId: latest.generationId,
    overrides: parsed.data,
    flags: [],
    source: "author",
    createdAt: now,
  });
}

/** The author attests to exactly the latest revision (§6.3, §8). */
export function reviewRevision(
  latest: DraftRevision,
  revision: number,
  now: string,
): Result<Review> {
  if (revision !== latest.number) return refused("stale-revision");
  if (latest.flags.length > 0) return refused("needs-review-flags");
  if (latest.overrides.contribution.trim() === "") return refused("contribution-missing");
  return ok({
    projectId: latest.projectId,
    revision,
    attestationVersion: ATTESTATION_VERSION,
    createdAt: now,
  });
}
