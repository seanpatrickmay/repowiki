import { ATTESTATION_VERSION, PortfolioContent } from "./content.ts";
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

/** The next revision, holding `content` made from `generation` (ADR-0012's generatedContent). */
function revise(project: Project, generation: Generation, content: unknown, now: string): Revised {
  const parsed = PortfolioContent.safeParse(content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refused("invalid-input", `${issue?.path.join(".") || "content"}: ${issue?.message}`);
  }
  const revision: DraftRevision = {
    projectId: project.id,
    number: project.latestRevision + 1,
    generationId: generation.id,
    content: parsed.data,
    createdAt: now,
  };
  return ok({ project: { ...project, latestRevision: revision.number }, revision });
}

/** Revision 1, when a project's first generation lands (§6.3). */
export function firstRevision(
  project: Project,
  generation: Generation,
  content: unknown,
  now: string,
): Revised {
  if (fromAnotherProject(project, generation)) return foreign();
  if (project.latestRevision !== 0) return refused("invalid-transition");
  return revise(project, generation, content, now);
}

/** A refresh landed: the next revision holds the new generation's content; nothing carries over. */
export function refreshRevision(
  project: Project,
  latest: DraftRevision,
  generation: Generation,
  content: unknown,
  now: string,
): Revised {
  if (fromAnotherProject(project, latest, generation)) return foreign();
  if (latest.number !== project.latestRevision) return refused("stale-revision");
  return revise(project, generation, content, now);
}

/** The author attests to exactly the latest revision (§6.3, ADR-0012). */
export function reviewRevision(
  latest: DraftRevision,
  revision: number,
  now: string,
): Result<Review> {
  if (revision !== latest.number) return refused("stale-revision");
  return ok({
    projectId: latest.projectId,
    revision,
    attestationVersion: ATTESTATION_VERSION,
    createdAt: now,
  });
}
