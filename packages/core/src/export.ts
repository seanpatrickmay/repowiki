import { z } from "zod";
import { Architecture } from "./architecture.ts";
import { FeatureId } from "./feature.ts";
import { Manifest } from "./manifest.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
import { Revision } from "./revision.ts";
import { SCHEMA_VERSION } from "./version.ts";
import { WikipediaSummary } from "./wikipedia.ts";

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
    /**
     * Summaries of the Wikipedia articles the pages link, by the canonical title their
     * [[wp:Title]] tokens name, for hover previews (F13). Added in schema version 3.
     */
    wikipedia: z.record(z.string().min(1), WikipediaSummary).default({}),
    /**
     * Every stored revision of the Architecture article (F27), oldest first; the last one is the
     * current article. Empty when the wiki has none. Added within schema version 3 with a default,
     * so every earlier schema-3 export still parses.
     */
    architecture: z.array(Architecture).default([]),
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

    const articleIds = new Set<string>();
    wiki.architecture.forEach((article, index) => {
      if (articleIds.has(article.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate architecture revision id ${article.id}`,
          path: ["architecture", index, "id"],
        });
      }
      articleIds.add(article.id);
      const parent = index === 0 ? null : (wiki.architecture[index - 1]?.id ?? null);
      if (article.parentId !== parent) {
        ctx.addIssue({
          code: "custom",
          message: `architecture revision ${article.id} must have parent ${parent}`,
          path: ["architecture", index, "parentId"],
        });
      }
    });
    const current = wiki.architecture.at(-1);
    const last = wiki.architecture.length - 1;
    current?.sections.forEach((section, s) => {
      section.claims.forEach((claim, c) => {
        for (const id of claim.pages) {
          if (!seen.has(id)) {
            ctx.addIssue({
              code: "custom",
              message: `architecture claim ${claim.id} names ${id}, which has no page`,
              path: ["architecture", last, "sections", s, "claims", c, "pages"],
            });
          }
        }
      });
    });
    current?.edges.forEach((edge, e) => {
      if (!seen.has(edge.from) || !seen.has(edge.to)) {
        ctx.addIssue({
          code: "custom",
          message: `architecture edge ${edge.from} -> ${edge.to} joins a feature with no page`,
          path: ["architecture", last, "edges", e],
        });
      }
    });
  });
export type WikiExport = z.infer<typeof WikiExport>;
