import { z } from "zod";
import { GitSha } from "./primitives.ts";

/** Permanent lowercase kebab-case slug. Never reused or renamed once assigned. */
export const FeatureId = z
  .string()
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
  });
export type Feature = z.infer<typeof Feature>;
