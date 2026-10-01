import { FeatureId } from "@repowiki/core";
import { z } from "zod";
import type { Cluster } from "../cluster/index.ts";

/**
 * What the manifest call returns: the features, then one assignment per cluster. Assigning each
 * cluster once (rather than listing clusters under features) keeps the model from putting a
 * cluster in two features. Structured output enforces the shape; proposalProblems checks the
 * rules a JSON schema cannot express, so a rejected answer can be sent back with reasons.
 */
export const ManifestProposal = z.object({
  features: z.array(z.object({ id: z.string(), title: z.string(), aliases: z.array(z.string()) })),
  clusters: z.array(
    z.object({ cluster: z.string(), feature: z.string(), role: z.enum(["core", "supporting"]) }),
  ),
});
export type ManifestProposal = z.infer<typeof ManifestProposal>;

export const MIN_ALIASES = 3;
export const MAX_ALIASES = 8;
export const MAX_FEATURE_ID_LENGTH = 40;

/** Trimmed, de-duplicated (case-insensitively), and never equal to the title. */
export function cleanAliases(title: string, aliases: readonly string[]): string[] {
  const seen = new Set([title.trim().toLowerCase()]);
  const out: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (trimmed === "" || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

/** Every reason the proposal cannot become a manifest; empty when it can. */
export function proposalProblems(
  proposal: ManifestProposal,
  clusters: readonly Cluster[],
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const feature of proposal.features) {
    if (!FeatureId.safeParse(feature.id).success || feature.id.length > MAX_FEATURE_ID_LENGTH) {
      problems.push(`feature id "${feature.id}" is not a kebab-case slug of at most 40 characters`);
    }
    if (ids.has(feature.id)) problems.push(`feature id "${feature.id}" is used twice`);
    ids.add(feature.id);
    const title = feature.title.trim();
    if (title === "") problems.push(`feature "${feature.id}" has an empty title`);
    if (titles.has(title.toLowerCase())) problems.push(`title "${title}" is used twice`);
    titles.add(title.toLowerCase());
    const aliases = cleanAliases(title, feature.aliases).length;
    if (aliases < MIN_ALIASES) {
      problems.push(
        `feature "${feature.id}" has ${aliases} distinct aliases; give ${MIN_ALIASES} to ${MAX_ALIASES}`,
      );
    }
  }
  const known = new Set(clusters.map((c) => c.id));
  const assigned = new Set<string>();
  for (const { cluster, feature } of proposal.clusters) {
    if (!known.has(cluster)) problems.push(`cluster ${cluster} does not exist`);
    if (assigned.has(cluster)) problems.push(`cluster ${cluster} is assigned twice`);
    if (!ids.has(feature))
      problems.push(`cluster ${cluster} is assigned to unknown feature "${feature}"`);
    assigned.add(cluster);
  }
  for (const id of known) if (!assigned.has(id)) problems.push(`cluster ${id} is not assigned`);
  return problems;
}
