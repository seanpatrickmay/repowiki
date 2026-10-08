import {
  type ActivityDay,
  cleanPullTitle,
  type Manifest,
  memberId,
  type PeopleConfig,
  PeopleSnapshot,
  type PersonFacts,
  type PullRequestRef,
} from "@repowiki/core";
import {
  type AuthoredCommit,
  DEFAULT_MAX_FILES_PER_COMMIT,
  pullRequestOf,
} from "../index/index.ts";
import type { ResolvedIdentities } from "./identities.ts";
import { isLockfile, type Ownership } from "./ownership.ts";

export interface SnapshotInput {
  /** The wiki's head: the sha People documents. */
  sha: string;
  /** readAuthorship at sha, in any order. */
  commits: readonly AuthoredCommit[];
  identities: ResolvedIdentities;
  /** assignIds' ids, one per identity group, and its redirects. */
  ids: readonly string[];
  redirects: readonly { from: string; to: string }[];
  ownership: Ownership;
  /** Every stored manifest, newest first; the first is the head's. */
  manifests: readonly Manifest[];
  config: PeopleConfig;
  /** A commit changing more files is a sweep: its lines are not counted (R20). Default 50. */
  maxFilesPerCommit?: number;
}

export interface ComputedSnapshot {
  snapshot: PeopleSnapshot;
  /** The features each non-merge commit touches (R19), sorted; the pack and verify read it. */
  commitFeatures: Map<string, string[]>;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The commits newest first in an order that depends only on the history: a commit comes after
 * every commit that has it as a parent, ties newest commit date first, then by sha. The R19
 * rename walk needs children before parents; git log's order would do, but this one is the same
 * whatever order the commits arrive in.
 */
export function topologicalNewestFirst(commits: readonly AuthoredCommit[]): AuthoredCommit[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const children = new Map<string, number>();
  for (const c of commits)
    for (const p of c.parents) if (bySha.has(p)) children.set(p, (children.get(p) ?? 0) + 1);
  const ready = commits.filter((c) => (children.get(c.sha) ?? 0) === 0);
  const order: AuthoredCommit[] = [];
  const later = (a: AuthoredCommit, b: AuthoredCommit) =>
    Date.parse(b.commitDate) - Date.parse(a.commitDate) || byId(a.sha, b.sha);
  while (ready.length > 0) {
    ready.sort(later);
    const next = ready.shift() as AuthoredCommit;
    order.push(next);
    for (const p of next.parents) {
      const left = (children.get(p) ?? 0) - 1;
      children.set(p, left);
      const parent = bySha.get(p);
      if (left === 0 && parent !== undefined) ready.push(parent);
    }
  }
  return order;
}

/** The feature a head path belongs to, through each manifest newest first (R19). */
function featureLookup(manifests: readonly Manifest[]): (path: string) => string | null {
  const head = manifests[0];
  const statusOf = new Map(head?.features.map((f) => [f.id, f.status]) ?? []);
  /** A feature id as it stands at the head: redirects followed; a split or unknown id is none. */
  const final = (id: string): string | null => {
    const seen = new Set<string>();
    let at = id;
    for (;;) {
      const status = statusOf.get(at);
      if (status === undefined || status.kind === "disambiguation" || seen.has(at)) return null;
      if (status.kind !== "redirect") return at;
      seen.add(at);
      at = status.to;
    }
  };
  const cache = new Map<string, string | null>();
  return (path) => {
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    const id = memberId(path);
    const owner = manifests.find((m) => Object.hasOwn(m.membership, id))?.membership[id];
    const feature = owner === undefined ? null : final(owner.featureId);
    cache.set(path, feature);
    return feature;
  };
}

/**
 * The features each non-merge commit touches (R19), sorted: each changed path followed through
 * later renames to its path at the head (the commits come newest first, topologicalNewestFirst),
 * then looked up in the stored manifests, newest first.
 */
export function commitFeaturesOf(
  commits: readonly AuthoredCommit[],
  manifests: readonly Manifest[],
): Map<string, string[]> {
  const featureOf = featureLookup(manifests);
  const forward = new Map<string, string>();
  const commitFeatures = new Map<string, string[]>();
  for (const commit of commits) {
    if (commit.parents.length > 1) continue;
    const features = new Set<string>();
    for (const file of commit.files) {
      const at = forward.get(file.path) ?? file.path;
      const feature = featureOf(at);
      if (feature !== null) features.add(feature);
      if (file.oldPath !== null) forward.set(file.oldPath, at);
    }
    commitFeatures.set(commit.sha, [...features].sort(byId));
  }
  return commitFeatures;
}

/** A pull request's merge commit or squash commit (R6). */
export interface Landing {
  number: number;
  /** The landing commit: the merge, or the squash commit. */
  sha: string;
  title: string | null;
  mergedAt: string;
  /** The merge's author group; null for a squash. */
  merger: number | null;
}

/**
 * Each pull request's landing (R6), from the commits newest first (topologicalNewestFirst): a
 * "Merge pull request #N" merge with its body's title line, or a non-merge "Title (#N)" squash.
 * The newest landing of a number wins.
 */
export function pullRequestLandings(
  commits: readonly AuthoredCommit[],
  groupOf: (c: AuthoredCommit) => number,
): Map<number, Landing> {
  const landings = new Map<number, Landing>();
  for (const commit of commits) {
    const number = pullRequestOf(commit.subject);
    if (number === null || landings.has(number)) continue;
    const merge = commit.parents.length > 1;
    if (merge && /^Merge pull request #/.test(commit.subject)) {
      landings.set(number, {
        number,
        sha: commit.sha,
        title: commit.mergeTitle === null ? null : cleanPullTitle(commit.mergeTitle),
        mergedAt: commit.authorDate,
        merger: groupOf(commit),
      });
    } else if (!merge) {
      landings.set(number, {
        number,
        sha: commit.sha,
        title: cleanPullTitle(commit.subject.replace(/\s*\(#\d{1,9}\)\s*$/, "")),
        mergedAt: commit.authorDate,
        merger: null,
      });
    }
  }
  return landings;
}

/**
 * Each pull request's author group (R6): the group with most of its non-merge commits, ties to
 * the earliest first commit, then the lower group. A pull request whose commits are all unknown
 * has none.
 */
export function pullRequestAuthors(
  landings: ReadonlyMap<number, Landing>,
  commits: readonly AuthoredCommit[],
  groupOf: (c: AuthoredCommit) => number,
): Map<number, number> {
  const tallies = new Map<number, Map<number, { n: number; first: number }>>();
  for (const commit of commits) {
    if (commit.pr === null || commit.parents.length > 1 || !landings.has(commit.pr)) continue;
    const tally = tallies.get(commit.pr) ?? new Map<number, { n: number; first: number }>();
    tallies.set(commit.pr, tally);
    const g = groupOf(commit);
    const was = tally.get(g) ?? { n: 0, first: Number.POSITIVE_INFINITY };
    tally.set(g, { n: was.n + 1, first: Math.min(was.first, Date.parse(commit.authorDate)) });
  }
  const authors = new Map<number, number>();
  for (const [number, tally] of tallies) {
    const best = [...tally].sort(
      ([ga, a], [gb, b]) => b.n - a.n || a.first - b.first || ga - gb,
    )[0];
    if (best !== undefined && best[0] !== -1) authors.set(number, best[0]);
  }
  return authors;
}

/**
 * Computes every People fact at the head (spec v2 #6 §7), with no model call: each person's
 * activity by calendar day and lines per R20 (merges count nothing; lockfiles, binaries and
 * sweeps add no lines), the features their commits touch through renames and older manifests
 * (R19), their current lines from blame (R1), the pull requests they authored and merged (R6),
 * and the snapshot totals. Excluded people's activity is the anonymous `others` (when at least
 * othersMinPeople are excluded) and their lines are unattributed (R12). Every list is sorted and
 * every map keyed in order, so equal inputs give byte-identical JSON.
 */
export function computeSnapshot(input: SnapshotInput): ComputedSnapshot {
  const maxFiles = input.maxFilesPerCommit ?? DEFAULT_MAX_FILES_PER_COMMIT;
  const { groups } = input.identities;
  const commits = topologicalNewestFirst(input.commits);
  const groupOf = (c: AuthoredCommit) => input.identities.groupOf(c.authorName, c.authorEmail);
  const head = input.manifests[0];
  const commitFeatures = commitFeaturesOf(commits, input.manifests);

  // Activity and lines per group.
  const activity = groups.map(() => new Map<string, ActivityDay>());
  const totals = groups.map(() => ({ commits: 0, added: 0, deleted: 0 }));
  const featureCommits = groups.map(() => new Map<string, number>());
  let allCommits = 0;
  for (const commit of commits) {
    if (commit.parents.length > 1) continue;
    allCommits++;
    const g = groupOf(commit);
    if (g === -1) continue;
    const sweep = commit.files.length > maxFiles;
    let added = 0;
    let deleted = 0;
    for (const file of sweep ? [] : commit.files) {
      if (isLockfile(file.path) || file.added === null || file.deleted === null) continue;
      added += file.added;
      deleted += file.deleted;
    }
    const day = commit.authorDate.slice(0, 10);
    const days = activity[g] as Map<string, ActivityDay>;
    const was = days.get(day) ?? { day, commits: 0, added: 0, deleted: 0 };
    days.set(day, {
      day,
      commits: was.commits + 1,
      added: was.added + added,
      deleted: was.deleted + deleted,
    });
    const total = totals[g] as { commits: number; added: number; deleted: number };
    total.commits++;
    total.added += added;
    total.deleted += deleted;
    const counts = featureCommits[g] as Map<string, number>;
    for (const feature of commitFeatures.get(commit.sha) ?? [])
      counts.set(feature, (counts.get(feature) ?? 0) + 1);
  }

  // Current lines from blame (R1).
  const author = new Map(commits.map((c) => [c.sha, groupOf(c)]));
  const lines = groups.map(() => 0);
  const featureLinesOf = groups.map(() => new Map<string, number>());
  const featureLines = new Map<string, number>();
  for (const f of head?.features ?? []) if (f.status.kind === "active") featureLines.set(f.id, 0);
  let totalLines = 0;
  let unattributed = 0;
  const add = (path: string, g: number, n: number) => {
    const feature = head?.membership[memberId(path)]?.featureId;
    const owned = feature !== undefined && Object.hasOwn(head?.membership ?? {}, memberId(path));
    totalLines += n;
    if (owned) featureLines.set(feature, (featureLines.get(feature) ?? 0) + n);
    if (g === -1 || groups[g]?.excluded === true) {
      unattributed += n;
      return;
    }
    lines[g] = (lines[g] ?? 0) + n;
    if (owned) {
      const mine = featureLinesOf[g] as Map<string, number>;
      mine.set(feature, (mine.get(feature) ?? 0) + n);
    }
  };
  for (const [path, runs] of input.ownership.files)
    for (const [sha, n] of runs) add(path, author.get(sha) ?? -1, n);
  for (const { path, lines: n } of input.ownership.timedOut) add(path, -1, n);

  // Pull requests (R6): landed by a "Merge pull request #N" merge, or a "Title (#N)" squash.
  const landings = pullRequestLandings(commits, groupOf);
  const prAuthor = pullRequestAuthors(landings, commits, groupOf);

  const people: PersonFacts[] = [];
  const others = new Map<string, ActivityDay>();
  const excludedCount = groups.filter((g) => g.excluded).length;
  groups.forEach((group, g) => {
    if (group.excluded) {
      if (excludedCount < input.config.othersMinPeople) return;
      for (const day of (activity[g] as Map<string, ActivityDay>).values()) {
        const was = others.get(day.day) ?? { day: day.day, commits: 0, added: 0, deleted: 0 };
        others.set(day.day, {
          day: day.day,
          commits: was.commits + day.commits,
          added: was.added + day.added,
          deleted: was.deleted + day.deleted,
        });
      }
      return;
    }
    const counts = featureCommits[g] as Map<string, number>;
    const mine = featureLinesOf[g] as Map<string, number>;
    const features = [...new Set([...counts.keys(), ...mine.keys()])]
      .map((featureId) => ({
        featureId,
        commits: counts.get(featureId) ?? 0,
        currentLines: mine.get(featureId) ?? 0,
      }))
      .filter((f) => f.commits + f.currentLines > 0)
      .sort(
        (a, b) =>
          b.currentLines - a.currentLines ||
          b.commits - a.commits ||
          byId(a.featureId, b.featureId),
      );
    const authored: PullRequestRef[] = [...landings.values()]
      .filter((l) => prAuthor.get(l.number) === g)
      .map(({ number, title, mergedAt }) => ({ number, title, mergedAt }))
      .sort((a, b) => a.number - b.number);
    const merged = [...landings.values()]
      .filter((l) => l.merger === g)
      .map((l) => l.number)
      .sort((a, b) => a - b);
    const total = totals[g] as { commits: number; added: number; deleted: number };
    people.push({
      id: input.ids[g] as string,
      name: group.name,
      otherNames: group.otherNames,
      kind: group.kind,
      firstCommit: group.firstCommit,
      lastCommit: group.lastCommit,
      commits: total.commits,
      added: total.added,
      deleted: total.deleted,
      currentLines: lines[g] ?? 0,
      prsAuthored: authored,
      prsMerged: merged,
      features,
      activity: [...(activity[g] as Map<string, ActivityDay>).values()].sort((a, b) =>
        byId(a.day, b.day),
      ),
    });
  });
  people.sort((a, b) => byId(a.id, b.id));
  const snapshot = PeopleSnapshot.parse({
    sha: input.sha,
    commitDate: commits.find((c) => c.sha === input.sha)?.commitDate ?? commits[0]?.commitDate,
    commits: allCommits,
    people,
    redirects: [...input.redirects].sort((a, b) => byId(a.from, b.from)),
    others: [...others.values()].sort((a, b) => byId(a.day, b.day)),
    featureLines: Object.fromEntries([...featureLines].sort(([a], [b]) => byId(a, b))),
    totalLines,
    unattributedLines: unattributed,
  });
  return { snapshot, commitFeatures };
}
