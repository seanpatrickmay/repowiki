import type { Manifest } from "@repowiki/core";
import type { Store } from "../store/index.ts";
import type { BuildJournal } from "../write/index.ts";
import { type NarrativePlan, planNarratives } from "./due.ts";
import { type Refreshed, type RefreshInput, refreshPeople } from "./refresh.ts";
import { type PersonOutcome, type PersonRequest, personRequest } from "./write.ts";

export interface PrepareInput extends RefreshInput {
  /** The head's manifest: feature titles, links and the feature directory. */
  manifest: Manifest;
  /** False for --no-narrative: facts only, no request. */
  narrative: boolean;
  /** --only: the person ids whose due narratives are written; null for all. */
  only: ReadonlySet<string> | null;
}

export interface PreparedPeople {
  refreshed: Refreshed;
  plan: NarrativePlan;
  /** One request per due narrative, in rank order; empty with `narrative: false`. */
  requests: PersonRequest[];
  /** Narrative revisions deleted because their consent was withdrawn (planner ruling R18). */
  revoked: number;
}

/**
 * The People step up to its calls (spec v2 #6 §4, §9): the refresh (snapshot and registry stored
 * together, no call), the plan of due narratives, the deletion of narratives whose consent was
 * withdrawn, and the request of each due narrative. What a run then sends is the caller's to cap.
 */
export async function preparePeople(input: PrepareInput): Promise<PreparedPeople> {
  const refreshed = await refreshPeople(input);
  const { store } = input;
  const current = new Map(store.listCurrentPersonRevisions().map((r) => [r.personId, r]));
  const plan = planNarratives(refreshed, current, input.config, input.only);
  const revoked = store.transaction(() =>
    plan.revoked.reduce((n, id) => n + store.forgetPersonNarrative(id), 0),
  );
  const requests = input.narrative
    ? plan.due.flatMap(
        (d) =>
          personRequest(refreshed, d.personId, input.manifest, {
            parent: d.parent,
            append: d.append,
          }) ?? [],
      )
    : [];
  return { refreshed, plan, requests, revoked };
}

/**
 * Stores a settled People round and flushes its journal rows in one transaction (spec v2 #6
 * §8.4, the M4 I1 ruling), as storeArticle does for the About article: a row is forgotten once
 * its narrative is stored, or once the narrative failed. A refused revision rolls the whole round
 * back and forgets every answered row, so a rerun pays for the round again (the Task 24 review's
 * minor). Returns how many were stored.
 */
export function storeNarratives(
  store: Store,
  outcomes: readonly PersonOutcome[],
  journal: BuildJournal | undefined,
): number {
  const written = outcomes.flatMap((o) => (o.revision === null ? [] : [o.revision]));
  try {
    store.transaction(() => {
      for (const revision of written) store.putPersonRevision(revision);
      journal?.flush();
    });
  } catch (error) {
    store.transaction(() => journal?.flush());
    throw error;
  }
  return written.length;
}
