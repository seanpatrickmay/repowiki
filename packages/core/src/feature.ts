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

    // Lineage <-> status, both ways (issue #53). create opens the lineage and appears once; a
    // rename keeps the old title as an alias; merge, split and retire end a feature's life, so at
    // most one of them appears and the status must say the same thing.
    feature.lineage.forEach((event, index) => {
      if (event.kind === "create" && index > 0) {
        ctx.addIssue({
          code: "custom",
          message: "create may only be the first lineage event",
          path: ["lineage", index],
        });
      }
      if (event.kind === "rename" && !feature.aliases.includes(event.fromTitle)) {
        ctx.addIssue({
          code: "custom",
          message: `rename lineage requires "${event.fromTitle}" in aliases`,
          path: ["aliases"],
        });
      }
    });
    const endings = feature.lineage.filter(
      (e) => e.kind === "merge" || e.kind === "split" || e.kind === "retire",
    );
    if (endings.length > 1) {
      ctx.addIssue({
        code: "custom",
        message: "lineage may contain at most one merge, split, or retire event",
        path: ["lineage"],
      });
    }
    const ending = endings[0];
    const status = feature.status;
    const statusIssue = (message: string) =>
      ctx.addIssue({ code: "custom", message, path: ["status"] });
    if (status.kind === "redirect") {
      if (ending?.kind !== "merge" || ending.into !== status.to) {
        statusIssue("redirect status requires a merge lineage event into its target");
      }
    } else if (status.kind === "disambiguation") {
      const targets = new Set(status.to);
      const matches =
        ending?.kind === "split" &&
        new Set(ending.into).size === targets.size &&
        ending.into.every((t) => targets.has(t));
      if (!matches) statusIssue("disambiguation status requires a matching split lineage event");
    } else if (status.kind === "retired") {
      if (ending?.kind !== "retire") statusIssue("retired status requires a retire lineage event");
    } else if (ending !== undefined) {
      const expected = { merge: "redirect", split: "disambiguation", retire: "retired" }[
        ending.kind
      ];
      statusIssue(`a ${ending.kind} lineage event requires ${expected} status`);
    }
  });
export type Feature = z.infer<typeof Feature>;
