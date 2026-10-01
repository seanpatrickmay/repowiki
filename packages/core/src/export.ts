import { z } from "zod";
import { FeatureId } from "./feature.ts";
import { Manifest } from "./manifest.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
import { Revision, RevisionReason } from "./revision.ts";
import { SCHEMA_VERSION } from "./version.ts";

export const HistoryEntry = z.object({
  id: z.string().min(1),
  sha: GitSha,
  commitDate: IsoDateTime,
  reason: RevisionReason,
  pr: z.int().positive().nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** Everything the reader site and agents consume. Pages are the current revision of each feature. */
export const WikiExport = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repo: z.string().min(1),
    head: GitSha,
    exportedAt: IsoDateTime,
    manifest: Manifest,
    pages: z.array(Revision),
    /** Oldest first, per feature. */
    history: z.record(FeatureId, z.array(HistoryEntry)),
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
  });
export type WikiExport = z.infer<typeof WikiExport>;
