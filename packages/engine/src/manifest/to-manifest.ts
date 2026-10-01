import { Manifest, type Membership } from "@repowiki/core";
import type { Cluster, FileGraph } from "../cluster/index.ts";
import type { RepoIndex } from "../index/index.ts";
import { cleanAliases, MAX_ALIASES, type ManifestProposal } from "./proposal.ts";

const ROLE_FACTOR = { core: 1, supporting: 0.5 } as const;
/** The lowest centrality a member can have, so every weight stays above zero. */
const MIN_CENTRALITY = 0.05;

/** Longest list of unassigned paths named in the error. */
const MAX_LISTED_PATHS = 5;

const normalize = (text: string): string => text.trim().toLowerCase();

/**
 * Turns an accepted proposal into a new manifest. Features no cluster was assigned to are left
 * out (they would be empty pages). Titles are trimmed and aliases cleaned; an alias that is another
 * kept feature's id or title, or one an earlier feature kept, is dropped (so [[link]] resolution
 * is unambiguous) before the cap at MAX_ALIASES. Every file and every
 * symbol is a member of its cluster's feature. A member's weight is its role factor (core 1,
 * supporting 0.5) times its centrality: the share of its edge weight that stays in its feature.
 * Throws if the proposal names a cluster that does not exist or leaves any indexed file in no
 * assigned cluster, rather than quietly leaving files out of the wiki.
 */
export function proposalToManifest(
  proposal: ManifestProposal,
  index: RepoIndex,
  graph: FileGraph,
  clusters: readonly Cluster[],
): Manifest {
  const filesOf = new Map(clusters.map((c) => [c.id, c.files]));
  const owner = new Map<string, { featureId: string; role: "core" | "supporting" }>();
  for (const { cluster, feature, role } of proposal.clusters) {
    const files = filesOf.get(cluster);
    if (files === undefined) throw new Error(`the proposal assigns unknown cluster "${cluster}"`);
    for (const file of files) owner.set(file, { featureId: feature, role });
  }
  const inside = new Map<string, number>();
  const total = new Map<string, number>();
  for (const { a, b, weight } of graph.edges) {
    const same = owner.get(a)?.featureId === owner.get(b)?.featureId;
    for (const file of [a, b]) {
      total.set(file, (total.get(file) ?? 0) + weight);
      if (same) inside.set(file, (inside.get(file) ?? 0) + weight);
    }
  }

  const membership: Record<string, Membership> = {};
  const unassigned: string[] = [];
  for (const file of index.files) {
    const assigned = owner.get(file.path);
    if (assigned === undefined) {
      unassigned.push(file.path);
      continue;
    }
    const all = total.get(file.path) ?? 0;
    const centrality = Math.max(MIN_CENTRALITY, all === 0 ? 0 : (inside.get(file.path) ?? 0) / all);
    const weight = Math.round(ROLE_FACTOR[assigned.role] * centrality * 1000) / 1000;
    const member = { featureId: assigned.featureId, weight };
    membership[file.id] = member;
    for (const symbol of file.symbols) membership[symbol.id] = member;
  }

  if (unassigned.length > 0) {
    const shown = unassigned.slice(0, MAX_LISTED_PATHS).join(", ");
    const rest = unassigned.length - MAX_LISTED_PATHS;
    throw new Error(
      `${unassigned.length} indexed files belong to no assigned cluster: ${shown}${rest > 0 ? ` and ${rest} more` : ""}`,
    );
  }

  const kept = proposal.features.filter((feature) =>
    proposal.clusters.some((c) => c.feature === feature.id),
  );
  // Names a [[link]] could resolve to: every kept feature's id and title, then aliases as kept.
  const taken = new Set(kept.flatMap((f) => [f.id.trim().toLowerCase(), normalize(f.title)]));
  const features = kept.map((feature) => {
    // A feature may list its own id as an alias, unless that is also another feature's title.
    const otherTitles = new Set(kept.filter((f) => f !== feature).map((f) => normalize(f.title)));
    const aliases = cleanAliases(feature.title, feature.aliases)
      .filter((alias) => {
        const name = normalize(alias);
        return name === normalize(feature.id) ? !otherTitles.has(name) : !taken.has(name);
      })
      .slice(0, MAX_ALIASES);
    for (const alias of aliases) taken.add(normalize(alias));
    return {
      id: feature.id,
      title: feature.title.trim(),
      aliases,
      status: { kind: "active" },
      lineage: [{ kind: "create", sha: index.sha }],
    };
  });

  return Manifest.parse({ sha: index.sha, features, membership });
}
