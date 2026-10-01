import { z } from "zod";
import { GitSha } from "./primitives.ts";

/** Feature ids become URL path segments and file names in the reader site, so they are capped. */
export const FEATURE_ID_MAX_LENGTH = 64;

/** Permanent lowercase kebab-case slug. Never reused or renamed once assigned. */
export const FeatureId = z
  .string()
  .max(FEATURE_ID_MAX_LENGTH, `feature ids are at most ${FEATURE_ID_MAX_LENGTH} characters`)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "feature ids are lowercase kebab-case slugs");
export type FeatureId = z.infer<typeof FeatureId>;

export const FeatureStatus = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("active") }),
  z.object({ kind: z.literal("redirect"), to: FeatureId }),
  z.object({ kind: z.literal("disambiguation"), to: z.array(FeatureId).min(2) }),
  z.object({ kind: z.literal("retired") }),
]);
export type FeatureStatus = z.infer<typeof FeatureStatus>;

export const LineageEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), sha: GitSha }),
  z.object({ kind: z.literal("rename"), sha: GitSha, fromTitle: z.string().min(1) }),
  z.object({ kind: z.literal("merge"), sha: GitSha, into: FeatureId }),
  z.object({ kind: z.literal("split"), sha: GitSha, into: z.array(FeatureId).min(2) }),
  z.object({ kind: z.literal("retire"), sha: GitSha }),
]);
export type LineageEvent = z.infer<typeof LineageEvent>;

export const Feature = z
  .object({
    id: FeatureId,
    title: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    status: FeatureStatus,
    lineage: z.array(LineageEvent).min(1),
  })
  .superRefine((feature, ctx) => {
    if (feature.lineage[0]?.kind !== "create") {
      ctx.addIssue({
        code: "custom",
        message: "lineage must start with create",
        path: ["lineage", 0],
      });
    }
    if (feature.status.kind === "redirect" && feature.status.to === feature.id) {
      ctx.addIssue({
        code: "custom",
        message: "a feature cannot redirect to itself",
        path: ["status"],
      });
    }

    // Disambiguation validation
    if (feature.status.kind === "disambiguation") {
      const targets = feature.status.to;
      if (targets.includes(feature.id)) {
        ctx.addIssue({
          code: "custom",
          message: "disambiguation cannot include self",
          path: ["status", "to"],
        });
      }
      if (new Set(targets).size !== targets.length) {
        ctx.addIssue({
          code: "custom",
          message: "disambiguation targets must be unique",
          path: ["status", "to"],
        });
      }
    }

    // Lineage validation
    for (const [index, event] of feature.lineage.entries()) {
      if (event.kind === "merge") {
        if (event.into === feature.id) {
          ctx.addIssue({
            code: "custom",
            message: "merge lineage cannot target self",
            path: ["lineage", index, "into"],
          });
        }
      } else if (event.kind === "split") {
        if (event.into.includes(feature.id)) {
          ctx.addIssue({
            code: "custom",
            message: "split lineage cannot include self",
            path: ["lineage", index, "into"],
          });
        }
        if (new Set(event.into).size !== event.into.length) {
          ctx.addIssue({
            code: "custom",
            message: "split targets must be unique",
            path: ["lineage", index, "into"],
          });
        }
      }
    }

    // Status-lineage correspondence
    if (feature.status.kind === "redirect") {
      const redirectTo = feature.status.to;
      const hasMerge = feature.lineage.some((e) => e.kind === "merge" && e.into === redirectTo);
      if (!hasMerge) {
        ctx.addIssue({
          code: "custom",
          message: "redirect status requires a merge lineage event",
          path: ["status"],
        });
      }
    }

    if (feature.status.kind === "disambiguation") {
      const targetSet = new Set(feature.status.to);
      const hasSplit = feature.lineage.some(
        (e) =>
          e.kind === "split" &&
          new Set(e.into).size === targetSet.size &&
          e.into.every((t) => targetSet.has(t)),
      );
      if (!hasSplit) {
        ctx.addIssue({
          code: "custom",
          message: "disambiguation status requires a matching split lineage event",
          path: ["status"],
        });
      }
    }
  });
export type Feature = z.infer<typeof Feature>;
