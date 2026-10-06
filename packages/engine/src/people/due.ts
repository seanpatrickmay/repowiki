import type { PeopleConfig, PersonRevision } from "@repowiki/core";
import { wantsNarrative } from "./identities.ts";
import { ancestorsOf } from "./pack.ts";
import type { Refreshed } from "./refresh.ts";

/** Why a narrative is written this run (R25). */
export type DueReason = "missing" | "newer" | "regrouped";

export interface DueNarrative {
  personId: string;
  reason: DueReason;
  /** The person's current revision, or null. */
  parent: PersonRevision | null;
  /** True for "newer": the chronicle is appended; otherwise the narrative is written whole. */
  append: boolean;
  /** Non-merge commits: the rank (R26 takes due narratives in this order). */
  commits: number;
}

/** What the People step does with each person's narrative this run. */
export interface NarrativePlan {
  /** Due and eligible, in rank order (commits descending, then id), within maxNarratives. */
  due: DueNarrative[];
  /** Eligible, with a current narrative that is not due: carried word for word. */
  carried: string[];
  /** Eligible but past maxNarratives in rank: not written; a stored narrative is carried. */
  overCap: string[];
  /** Due but left out by --only. */
  skipped: string[];
  /**
   * People with a stored narrative who no longer get one (consent withdrawn, or under
   * minCommits after a split): their revisions are deleted (planner ruling R18). Excluded people
   * are not here: their revisions stay until --forget (spec v2 #6 §9).
   */
  revoked: string[];
}

/**
 * Which narratives are due (spec v2 #6 R15, R25): among the humans who want one (wantsNarrative),
 * ranked by commits, the first maxNarratives; each is due when it has no narrative, when its
 * identity group changed (written whole), or when the person has a non-merge commit its basis
 * does not reach (appended). A basis no longer in the history makes the narrative due whole.
 */
export function planNarratives(
  refreshed: Refreshed,
  current: ReadonlyMap<string, PersonRevision>,
  config: PeopleConfig,
  only: ReadonlySet<string> | null = null,
): NarrativePlan {
  const { groups } = refreshed.identities;
  const ids = refreshed.assigned.ids;
  const facts = new Map(refreshed.snapshot.people.map((p) => [p.id, p]));
  const plan: NarrativePlan = { due: [], carried: [], overCap: [], skipped: [], revoked: [] };
  const eligible: { id: string; group: number; commits: number }[] = [];
  groups.forEach((group, g) => {
    const id = ids[g] as string;
    if (group.excluded || facts.get(id)?.kind !== "human") return;
    if (wantsNarrative(group, config)) eligible.push({ id, group: g, commits: group.commits });
    else if (current.has(id)) plan.revoked.push(id);
  });
  eligible.sort((a, b) => b.commits - a.commits || (a.id < b.id ? -1 : 1));
  const known = new Set(refreshed.commits.map((c) => c.sha));
  eligible.forEach(({ id, group, commits }, rank) => {
    if (rank >= config.maxNarratives) {
      plan.overCap.push(id);
      return;
    }
    const parent = current.get(id) ?? null;
    let reason: DueReason | null;
    if (parent === null) reason = "missing";
    else if (refreshed.assigned.regrouped.has(id) || !known.has(parent.basis)) reason = "regrouped";
    else {
      const covered = ancestorsOf(refreshed.commits, parent.basis);
      const newer = refreshed.commits.some(
        (c) =>
          c.parents.length <= 1 &&
          !covered.has(c.sha) &&
          refreshed.identities.groupOf(c.authorName, c.authorEmail) === group,
      );
      reason = newer ? "newer" : null;
    }
    if (reason === null) plan.carried.push(id);
    else if (only !== null && !only.has(id)) plan.skipped.push(id);
    else plan.due.push({ personId: id, reason, parent, append: reason === "newer", commits });
  });
  plan.revoked.sort();
  return plan;
}
