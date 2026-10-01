import { z } from "zod";
import { Feature, FeatureId } from "./feature.ts";
import { parseMemberId } from "./member-id.ts";
import { GitSha, RepoPath } from "./primitives.ts";

/** A memberId(): an encoded repo path, optionally "#" and a non-empty symbol. */
export const MemberId = z
  .string()
  .min(1)
  .refine((id) => {
    const parsed = parseMemberId(id);
    return parsed !== null && RepoPath.safeParse(parsed.path).success;
  }, "member id must be memberId(path) or memberId(path, symbol) for a valid repo path");

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

    // Validate lineage merge/split targets exist
    manifest.features.forEach((feature, index) => {
      for (const [lineageIndex, event] of feature.lineage.entries()) {
        if (event.kind === "merge") {
          if (!byId.has(event.into)) {
            ctx.addIssue({
              code: "custom",
              message: `merge target ${event.into} does not exist`,
              path: ["features", index, "lineage", lineageIndex, "into"],
            });
          }
        } else if (event.kind === "split") {
          for (const target of event.into) {
            if (!byId.has(target)) {
              ctx.addIssue({
                code: "custom",
                message: `split target ${target} does not exist`,
                path: ["features", index, "lineage", lineageIndex, "into"],
              });
            }
          }
        }
      }
    });

    // Detect redirect cycles
    const detectCycle = (startId: string, visited: Set<string>): boolean => {
      if (visited.has(startId)) return true; // cycle detected
      const feature = byId.get(startId);
      if (!feature) return false; // doesn't exist
      if (feature.status.kind !== "redirect") return false; // not a redirect
      visited.add(startId);
      return detectCycle(feature.status.to, visited);
    };

    manifest.features.forEach((feature, index) => {
      if (feature.status.kind === "redirect") {
        if (detectCycle(feature.id, new Set())) {
          ctx.addIssue({
            code: "custom",
            message: `redirect cycle detected starting from ${feature.id}`,
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
