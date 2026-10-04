import { SectionKey } from "@repowiki/core";
import { z } from "zod";

/**
 * A claim as the write call returns it. `cite` holds references the pack taught the model:
 * "path:12-30" for lines of a file at the page's sha, or "commit:abc1234" for a commit. Kind and
 * final ids come from the page assembly, so the model cannot get them wrong.
 */
export const DraftClaim = z.object({
  id: z.string(),
  text: z.string(),
  cite: z.array(z.string()),
  supports: z.array(z.string()),
  hook: z.boolean(),
});
export type DraftClaim = z.infer<typeof DraftClaim>;

export const DraftSection = z.object({ key: SectionKey, claims: z.array(DraftClaim) });
export type DraftSection = z.infer<typeof DraftSection>;

/** The diagram the model picks: candidate node ids from the pack and labelled candidate edges. */
export const DraftDiagram = z.object({
  nodes: z.array(z.string()),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
});
export type DraftDiagram = z.infer<typeof DraftDiagram>;

/** What one write call returns: the page's sections, then its diagram. */
export const PageDraft = z.object({ sections: z.array(DraftSection), diagram: DraftDiagram });
export type PageDraft = z.infer<typeof PageDraft>;

/** The retry call's answer: corrected versions of the claims that failed, under their old ids. */
export const ClaimFixes = z.object({ claims: z.array(DraftClaim) });
export type ClaimFixes = z.infer<typeof ClaimFixes>;
