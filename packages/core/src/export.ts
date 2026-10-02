import { z } from "zod";
import { FeatureId } from "./feature.ts";
import { Manifest } from "./manifest.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
import { Revision } from "./revision.ts";
import { SCHEMA_VERSION } from "./version.ts";

/** Everything the reader site and agents consume. Pages are the current revision of each feature. */
export const WikiExport = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repo: z.string().min(1),
    head: GitSha,
    exportedAt: IsoDateTime,
    manifest: Manifest,
    pages: z.array(Revision),
    /** Every stored revision body per feature, oldest first; the last one is the feature's page. */
    history: z.record(FeatureId, z.array(Revision)),
  })
  .superRefine((wiki, ctx) => {
    const known = new Set(wiki.manifest.features.map((f) => f.id));
    const seen = new Set<string>();
    wiki.pages.forEach((page, index) => {
      if (seen.has(page.featureId)) {
        ctx.addIssue({
          code: "custom",
          message: `two pages for ${page.featureId}`,
          path: ["pages", index],
        });
      }
      seen.add(page.featureId);
      if (!known.has(page.featureId)) {
        ctx.addIssue({
          code: "custom",
          message: `${page.featureId} is not in the manifest`,
          path: ["pages", index],
        });
      }
      if (wiki.history[page.featureId]?.at(-1)?.id !== page.id) {
        ctx.addIssue({
          code: "custom",
          message: `history for ${page.featureId} must end with page ${page.id}`,
          path: ["history", page.featureId],
        });
      }
    });

    for (const [featureId, revisions] of Object.entries(wiki.history)) {
      if (!seen.has(featureId)) {
        ctx.addIssue({
          code: "custom",
          message: `history for ${featureId} has no page`,
          path: ["history", featureId],
        });
      }
      revisions.forEach((revision, index) => {
        if (revision.featureId !== featureId) {
          ctx.addIssue({
            code: "custom",
            message: `history for ${featureId} holds revision ${revision.id} of ${revision.featureId}`,
            path: ["history", featureId, index],
          });
        }
        const parent = index === 0 ? null : (revisions[index - 1]?.id ?? null);
        if (revision.parentId !== parent) {
          ctx.addIssue({
            code: "custom",
            message: `revision ${revision.id} must have parent ${parent}`,
            path: ["history", featureId, index, "parentId"],
          });
        }
      });
    }
  });
export type WikiExport = z.infer<typeof WikiExport>;
