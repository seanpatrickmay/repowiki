import { z } from "zod";
import { Feature, FeatureId } from "./feature.ts";
import { GitSha } from "./primitives.ts";

/** "path" for file-level members, "path#symbol" for symbol-level members. */
export const MemberId = z.string().min(1);

export const Membership = z.object({ featureId: FeatureId, weight: z.number().gt(0).lte(1) });
export type Membership = z.infer<typeof Membership>;

export const Manifest = z
  .object({
    sha: GitSha,
    features: z.array(Feature),
    membership: z.record(MemberId, Membership),
  })
  .superRefine((manifest, ctx) => {
    const byId = new Map<string, Feature>();
    manifest.features.forEach((feature, index) => {
      if (byId.has(feature.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate feature id ${feature.id}`,
          path: ["features", index],
        });
      }
      byId.set(feature.id, feature);
    });

    manifest.features.forEach((feature, index) => {
      const targets =
        feature.status.kind === "redirect"
          ? [feature.status.to]
          : feature.status.kind === "disambiguation"
            ? feature.status.to
            : [];
      for (const target of targets) {
        if (!byId.has(target)) {
          ctx.addIssue({
            code: "custom",
            message: `unknown target ${target}`,
            path: ["features", index, "status"],
          });
        }
      }
    });

    for (const [member, { featureId }] of Object.entries(manifest.membership)) {
      if (byId.get(featureId)?.status.kind !== "active") {
        ctx.addIssue({
          code: "custom",
          message: `${member} belongs to ${featureId}, which is not an active feature`,
          path: ["membership", member],
        });
      }
    }
  });
export type Manifest = z.infer<typeof Manifest>;
