import { z } from "zod";
import { FeatureId } from "./feature.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
import { addSectionStructureIssues, addUpdateParentIssue } from "./revision-rules.ts";
import { Section } from "./section.ts";

export const RevisionReason = z.enum(["build", "update", "manifest-change"]);
export type RevisionReason = z.infer<typeof RevisionReason>;

const count = z.int().nonnegative();

export const TokenUsage = z.object({ in: count, out: count, cacheRead: count, cacheWrite: count });
export type TokenUsage = z.infer<typeof TokenUsage>;

export const Infobox = z.object({
  files: count,
  loc: count,
  languages: z.array(z.string().min(1)),
  entryPoints: z.array(z.string().min(1)),
  firstCommitDate: IsoDateTime,
  lastCommitDate: IsoDateTime,
});
export type Infobox = z.infer<typeof Infobox>;

export const Revision = z
  .object({
    id: z.string().min(1),
    featureId: FeatureId,
    sha: GitSha,
    /** Date shown to readers: the commit's date, not when RepoWiki generated the page. */
    commitDate: IsoDateTime,
    generatedAt: IsoDateTime,
    parentId: z.string().min(1).nullable(),
    reason: RevisionReason,
    pr: z.int().positive().nullable(),
    model: z.string().min(1),
    tokens: TokenUsage,
    infobox: Infobox,
    /** Mermaid source for the data-flow diagram, or null when the page has none. */
    diagram: z.string().min(1).nullable(),
    seeAlso: z.array(FeatureId),
    sections: z.array(Section).min(1),
  })
  .superRefine((revision, ctx) => {
    addSectionStructureIssues(revision.sections, ctx);

    // manifest-change may be a feature's first page (create/split) or a later one, so either is valid.
    if (revision.reason === "build" && revision.parentId !== null) {
      ctx.addIssue({
        code: "custom",
        message: "build revisions have no parent",
        path: ["parentId"],
      });
    }
    addUpdateParentIssue(revision, ctx);
    if (revision.seeAlso.includes(revision.featureId)) {
      ctx.addIssue({
        code: "custom",
        message: "seeAlso cannot include the page itself",
        path: ["seeAlso"],
      });
    }
  });
export type Revision = z.infer<typeof Revision>;
