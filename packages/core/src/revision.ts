import { z } from "zod";
import { FeatureId } from "./feature.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
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
    if (revision.sections[0]?.key !== "lead") {
      ctx.addIssue({
        code: "custom",
        message: "the first section must be the lead",
        path: ["sections", 0],
      });
    }

    const keys = new Set<string>();
    const bodyClaimIds = new Set<string>();
    const allClaimIds = new Set<string>();
    revision.sections.forEach((section, s) => {
      if (keys.has(section.key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate section ${section.key}`,
          path: ["sections", s],
        });
      }
      keys.add(section.key);
      section.claims.forEach((claim, c) => {
        if (allClaimIds.has(claim.id)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate claim id ${claim.id}`,
            path: ["sections", s, "claims", c],
          });
        }
        allClaimIds.add(claim.id);
        if (section.key !== "lead") bodyClaimIds.add(claim.id);
      });
    });

    revision.sections.forEach((section, s) => {
      if (section.key !== "lead") return;
      section.claims.forEach((claim, c) => {
        for (const supported of claim.supports) {
          if (!bodyClaimIds.has(supported)) {
            ctx.addIssue({
              code: "custom",
              message: `lead claim ${claim.id} supports unknown body claim ${supported}`,
              path: ["sections", s, "claims", c, "supports"],
            });
          }
        }
      });
    });

    // manifest-change may be a feature's first page (create/split) or a later one, so either is valid.
    if (revision.reason === "build" && revision.parentId !== null) {
      ctx.addIssue({
        code: "custom",
        message: "build revisions have no parent",
        path: ["parentId"],
      });
    }
    if (revision.reason === "update" && revision.parentId === null) {
      ctx.addIssue({
        code: "custom",
        message: "update revisions must have a parent",
        path: ["parentId"],
      });
    }
    if (revision.seeAlso.includes(revision.featureId)) {
      ctx.addIssue({
        code: "custom",
        message: "seeAlso cannot include the page itself",
        path: ["seeAlso"],
      });
    }
  });
export type Revision = z.infer<typeof Revision>;
