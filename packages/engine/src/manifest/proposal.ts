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
/** Longest list of problems sent back to the model; the rest are summarized as a count. */
export const MAX_REPORTED_PROBLEMS = 20;
const MAX_QUOTED_LENGTH = 80;

/**
 * A model-supplied string, safe to put in a retry prompt: JSON-escaped (so a newline cannot start
 * a forged bullet) and cut to 80 characters, with "…" inside the quotes when it was cut.
 */
function quote(text: string): string {
  const chars = [...text];
  if (chars.length <= MAX_QUOTED_LENGTH) return JSON.stringify(text);
  return JSON.stringify(`${chars.slice(0, MAX_QUOTED_LENGTH).join("")}…`);
}

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

/**
 * Every reason the proposal cannot become a manifest; empty when it can. At most
 * MAX_REPORTED_PROBLEMS are listed, then a final "and N more problems" entry.
 */
export function proposalProblems(
  proposal: ManifestProposal,
  clusters: readonly Cluster[],
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const feature of proposal.features) {
    if (!FeatureId.safeParse(feature.id).success || feature.id.length > MAX_FEATURE_ID_LENGTH) {
      problems.push(
        `feature id ${quote(feature.id)} is not a kebab-case slug of at most ${MAX_FEATURE_ID_LENGTH} characters`,
      );
    }
    if (ids.has(feature.id)) problems.push(`feature id ${quote(feature.id)} is used twice`);
    ids.add(feature.id);
    const title = feature.title.trim();
    if (title === "") problems.push(`feature ${quote(feature.id)} has an empty title`);
    else {
      if (titles.has(title.toLowerCase())) problems.push(`title ${quote(title)} is used twice`);
      titles.add(title.toLowerCase());
    }
    const aliases = cleanAliases(title, feature.aliases).length;
    if (aliases < MIN_ALIASES) {
      problems.push(
        `feature ${quote(feature.id)} has ${aliases} distinct aliases; give ${MIN_ALIASES} to ${MAX_ALIASES}`,
      );
    }
  }
  const known = new Set(clusters.map((c) => c.id));
  const assigned = new Set<string>();
  for (const { cluster, feature } of proposal.clusters) {
    if (!known.has(cluster)) problems.push(`cluster ${quote(cluster)} does not exist`);
    if (assigned.has(cluster)) problems.push(`cluster ${quote(cluster)} is assigned twice`);
    if (!ids.has(feature))
      problems.push(`cluster ${quote(cluster)} is assigned to unknown feature ${quote(feature)}`);
    assigned.add(cluster);
  }
  for (const id of known)
    if (!assigned.has(id)) problems.push(`cluster ${quote(id)} is not assigned`);
  if (problems.length <= MAX_REPORTED_PROBLEMS) return problems;
  const rest = problems.length - MAX_REPORTED_PROBLEMS;
  return [...problems.slice(0, MAX_REPORTED_PROBLEMS), `and ${rest} more problems`];
}
