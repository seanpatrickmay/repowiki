import type { z } from "zod";

/** What the section rules read of a section: a Revision's and an Architecture's both fit. */
interface RuledSection {
  key: string;
  claims: readonly { id: string; supports: readonly string[] }[];
}

/**
 * The structure rules every revision's sections share (spec §5): the lead comes first, section
 * keys and claim ids are unique, and a lead claim supports only body claims that exist. The one
 * copy, called by Revision and by Architecture, so the two cannot drift.
 */
export function addSectionStructureIssues(
  sections: readonly RuledSection[],
  ctx: z.RefinementCtx,
): void {
  if (sections[0]?.key !== "lead") {
    ctx.addIssue({
      code: "custom",
      message: "the first section must be the lead",
      path: ["sections", 0],
    });
  }

  const keys = new Set<string>();
  const bodyClaimIds = new Set<string>();
  const allClaimIds = new Set<string>();
  sections.forEach((section, s) => {
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

  sections.forEach((section, s) => {
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
}

/** An update continues a chain, so it must name its parent. */
export function addUpdateParentIssue(
  revision: { reason: string; parentId: string | null },
  ctx: z.RefinementCtx,
): void {
  if (revision.reason === "update" && revision.parentId === null) {
    ctx.addIssue({
      code: "custom",
      message: "update revisions must have a parent",
      path: ["parentId"],
    });
  }
}
