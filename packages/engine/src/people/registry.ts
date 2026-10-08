import { aliasSlug, PERSON_ID_MAX_LENGTH, type RegistryRow } from "@repowiki/core";
import { StoreError } from "../store/index.ts";
import type { IdentityGroup } from "./identities.ts";

/** What assignIds decided (spec v2 #6 R13). */
export interface Assigned {
  /** Each group's person id, in the groups' order; an excluded group's id stays private. */
  ids: string[];
  /** The whole registry to store: every row ever made, updated. */
  registry: RegistryRow[];
  /** Ids merged away, each pointing straight at the id that now holds its keys; sorted. */
  redirects: { from: string; to: string }[];
  /**
   * Ids whose group merged with another stored person or split from one: their narrative is due
   * whole (R25), not appended to.
   */
  regrouped: Set<string>;
}

/** Shared keys between a row and a group (or one of its identities). */
const shared = (keys: ReadonlySet<string>, row: RegistryRow): number =>
  row.keys.reduce((n, key) => n + (keys.has(key) ? 1 : 0), 0);

/** A new id from a display name (R13): its slug, or person-<n>, then -2, -3 on a collision. */
function newId(name: string, taken: Set<string>): string {
  const slug = aliasSlug(name);
  if (slug === "") {
    let n = 1;
    while (taken.has(`person-${n}`)) n++;
    return `person-${n}`;
  }
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${slug.slice(0, PERSON_ID_MAX_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

const isExcludedId = (id: string) => /^excluded-\d+$/.test(id);

/** A new excluded person's private id: excluded-<n>, the lowest free n. */
function excludedId(taken: Set<string>): string {
  let n = 1;
  while (taken.has(`excluded-${n}`)) n++;
  return `excluded-${n}`;
}

/**
 * Gives each identity group its permanent id against the stored registry (spec v2 #6 R13): a
 * stored person is matched by identity-key overlap, and stays with the group sharing the most of
 * its email keys, then login keys, then name keys, then holding most of the commits of its keys
 * (a split: the other group gets a new id); a group that holds two stored
 * people keeps the larger one's id (more of its commits, then more shared keys, then the oldest
 * row) and turns the other into a redirect (a merge). A people-file id replaces the group's id and leaves a redirect behind. New
 * ids come from the display name, in order of first commit. Excluded groups keep private rows
 * and no redirect points at them; nothing is ever deleted (wiki:people --forget does that).
 * Throws a StoreError when a people-file id is held by a stored row the group did not win (another
 * person's, an unmatched one's, or a retired id that redirects elsewhere).
 */
export function assignIds(
  groups: readonly IdentityGroup[],
  stored: readonly RegistryRow[],
): Assigned {
  const rows = stored.filter((row) => row.status !== "redirect");
  // A shared placeholder address counts for nothing: it is no evidence of who a row is.
  const groupKeys = groups.map((group) => {
    const placeholders = new Set(group.placeholderKeys);
    return new Set(group.keys.filter((k) => !placeholders.has(k)));
  });
  const emailKeys = groups.map((group) => new Set(group.emailKeys));
  const loginKeys = groups.map((group) => new Set(group.loginKeys));
  // Each stored person goes to the group sharing the most strong keys with it (spec v2 #6 R9's
  // "most shared keys"): emails first, then logins; name keys only break a tie, then commits
  // (the commits of the group's pairs sharing a key). So a group never takes a row it shares
  // only a name with while another group shares an email or a login with it.
  const winner = new Map<string, number>();
  /** Each stored person's commits in the group that won them: "the larger one" of a merge. */
  const weight = new Map<string, number>();
  for (const row of rows) {
    let best = -1;
    let bestScore: number[] = [];
    groups.forEach((group, g) => {
      const all = shared(groupKeys[g] as Set<string>, row);
      if (all === 0) return;
      const emails = shared(emailKeys[g] as Set<string>, row);
      const logins = shared(loginKeys[g] as Set<string>, row);
      const commits = group.identities
        .filter((pair) => shared(new Set(pair.keys.filter((k) => groupKeys[g]?.has(k))), row) > 0)
        .reduce((n, pair) => n + pair.allCommits, 0);
      const score = [emails, logins, all - emails - logins, commits];
      const better = score.findIndex((v, i) => v !== bestScore[i]);
      if (
        best === -1 ||
        (better !== -1 && (score[better] as number) > (bestScore[better] as number))
      ) {
        best = g;
        bestScore = score;
      }
    });
    if (best !== -1) {
      winner.set(row.id, best);
      weight.set(row.id, bestScore[3] as number);
    }
  }
  const won = groups.map((_, g) =>
    rows
      .filter((row) => winner.get(row.id) === g)
      .sort(
        (a, b) =>
          (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0) ||
          shared(groupKeys[g] as Set<string>, b) - shared(groupKeys[g] as Set<string>, a) ||
          a.order - b.order,
      ),
  );
  const taken = new Set(stored.map((row) => row.id));
  for (const group of groups) if (group.id !== null) taken.add(group.id);
  const redirectTo = new Map<string, string>();
  for (const row of stored)
    if (row.status === "redirect" && row.to !== null) redirectTo.set(row.id, row.to);
  const storedRow = new Map(stored.map((row) => [row.id, row]));
  // A private excluded-<n> id a visible group won: it was never published, so the group gets a
  // normal id in its place, with no redirect, and the private one goes (the round 2 ruling).
  const lifted = new Map<string, string>();
  const retiredPrivate = new Set<string>();
  const ids = groups.map((group, g) => {
    let id = won[g]?.[0]?.id ?? null;
    const unexcluded = id !== null && !group.excluded && group.id === null && isExcludedId(id);
    const retired = unexcluded ? id : null;
    if (unexcluded) id = null;
    if (group.id !== null && group.id !== id) {
      // A stored id is this group's to take only when it won that row, or the row is a retired
      // id redirecting to a row it won (taking an old id back).
      const holder = storedRow.get(group.id);
      const mine = (rowId: string | null) => (won[g] as RegistryRow[]).some((r) => r.id === rowId);
      if (
        holder !== undefined &&
        !mine(holder.id) &&
        !(holder.status === "redirect" && mine(holder.to))
      )
        throw new StoreError(
          `people file: the id ${group.id} is already another person's, or a retired id of one`,
        );
      if (id !== null) redirectTo.set(id, group.id);
      id = group.id;
    }
    // A new excluded person gets a private id, so no visible "-2" shows they hold the slug
    // (the final review's M1); a stored row keeps its id.
    id ??= group.excluded ? excludedId(taken) : newId(group.name, taken);
    taken.add(id);
    if (retired !== null) lifted.set(id, retired);
    return id;
  });
  groups.forEach((_, g) => {
    for (const absorbed of (won[g] as RegistryRow[]).slice(1))
      redirectTo.set(absorbed.id, ids[g] as string);
  });
  const active = new Map(groups.map((group, g) => [ids[g] as string, group]));
  for (const id of active.keys()) redirectTo.delete(id);
  // A private excluded-<n> id is never a redirect (the round 3 ruling): one a group won and no
  // longer holds (given a people-file id, or merged into a visible person) simply goes, and its
  // order passes to the id that took its keys.
  groups.forEach((_, g) => {
    for (const row of won[g] as RegistryRow[])
      if (isExcludedId(row.id) && row.id !== ids[g]) {
        redirectTo.delete(row.id);
        if (!lifted.has(ids[g] as string) && row === won[g]?.[0])
          lifted.set(ids[g] as string, row.id);
        retiredPrivate.add(row.id);
      }
  });
  for (const id of [...redirectTo.keys()]) if (isExcludedId(id)) redirectTo.delete(id);
  /** Where a redirect ends: an id a group holds now, or null for a cycle or a dead end. */
  const finalOf = (id: string): string | null => {
    const seen = new Set<string>();
    let at = id;
    while (redirectTo.has(at)) {
      if (seen.has(at)) return null;
      seen.add(at);
      at = redirectTo.get(at) as string;
    }
    return active.has(at) ? at : null;
  };

  let order = stored.reduce((n, row) => Math.max(n, row.order + 1), 0);
  const registry: RegistryRow[] = [];
  groups.forEach((group, g) => {
    const id = ids[g] as string;
    registry.push({
      id,
      order: storedRow.get(lifted.get(id) ?? id)?.order ?? order++,
      name: group.name,
      kind: group.kind,
      status: group.excluded ? "excluded" : "active",
      to: null,
      keys: group.keys,
    });
  });
  for (const [from] of redirectTo) {
    const to = finalOf(from);
    if (to === null) continue;
    const was = storedRow.get(from);
    registry.push({
      id: from,
      order: was?.order ?? order++,
      name: was?.name ?? (active.get(to) as IdentityGroup).name,
      kind: was?.kind ?? "human",
      status: "redirect",
      to,
      keys: [],
    });
  }
  // A stored person no group matches now (their commits left the history) keeps their row.
  const written = new Set([
    ...registry.map((row) => row.id),
    ...lifted.values(),
    ...retiredPrivate,
  ]);
  for (const row of stored) if (!written.has(row.id)) registry.push(row);
  registry.sort((a, b) => a.order - b.order);

  const regrouped = new Set<string>();
  groups.forEach((_, g) => {
    const id = ids[g] as string;
    const list = won[g] as RegistryRow[];
    if (list.length > 1) regrouped.add(id);
    const mine = groupKeys[g] as Set<string>;
    const split = list[0]?.keys.some(
      (key) => !mine.has(key) && groupKeys.some((other) => other.has(key)),
    );
    if (split === true) regrouped.add(id);
  });
  const redirects = registry
    .filter((row) => row.status === "redirect" && row.to !== null)
    .flatMap((row) => {
      const target = active.get(row.to as string);
      return target !== undefined && !target.excluded && target.kind === "human"
        ? [{ from: row.id, to: row.to as string }]
        : [];
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return { ids, registry, redirects, regrouped };
}
