import {
  IsoDateTime,
  Manifest,
  type Membership,
  memberId,
  parseMemberId,
  type Revision,
} from "@repowiki/core";
import { buildFileGraph, type FileGraph } from "../cluster/index.ts";
import {
  type CommitInfo,
  diffCommits,
  type FileChange,
  GitError,
  isAncestor,
  pullRequestOf,
  type RepoIndex,
  reachableCommits,
} from "../index/index.ts";
import type { Store } from "../store/index.ts";
import type { PageRewrite } from "../write/index.ts";
import { driftedFeatures, featureChurn } from "./drift.ts";
import {
  coverageGaps,
  nextMembership,
  type Placement,
  placeNewFiles,
  renamesOf,
} from "./membership.ts";
import type { LineRange } from "./remap.ts";
import { type RemapContext, remapClaims } from "./stale.ts";

export class UpdateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface UpdateInput {
  /** The documented repository: diffs and ancestry are read from it with git plumbing. */
  repo: string;
  /** The index at the commit the wiki moves to. */
  index: RepoIndex;
  /** Text of every readable file at that commit. */
  sources: ReadonlyMap<string, string>;
  /** Every commit reachable from it, newest first. */
  history: readonly CommitInfo[];
  /** The file graph at that commit; built from the index when absent. */
  graph?: FileGraph;
}

/** What an update starts from, read with no LLM call (spec §6.1 steps 1-3). */
export interface UpdatePlan {
  /** The wiki's head, and the commit it moves to. */
  from: string;
  to: string;
  /** The PR `to` merged ("Merge pull request #N", or a squash's "(#N)"), or null. */
  pr: number | null;
  /** `to`'s commit date: the date readers see on its revisions. */
  commitDate: string;
  /** Every file that differs between `from` and `to`. */
  changes: FileChange[];
  /** Their paths, old and new. */
  touched: Set<string>;
  /** Commits reachable from `to` and not from `from`, newest first. */
  commits: CommitInfo[];
  /** The latest stored manifest, and the drift baseline. */
  previous: Manifest;
  baseline: Manifest;
  graph: FileGraph;
  /** Where the new files go, before any tie-break. */
  placement: Placement;
}

/**
 * Reads what an update needs before any call: the store's head and manifests, the diff from the
 * head to index.sha, the commits since, the PR index.sha merged, and where its new files go.
 * Refuses (UpdateError) a store with no wiki, a commit the wiki is already at, and one the head
 * is not an ancestor of: an update only moves forward along history.
 */
export function planUpdate(
  store: Store,
  input: UpdateInput,
  now: () => Date = () => new Date(),
): UpdatePlan {
  const { repo, index, history } = input;
  const to = index.sha;
  const from = store.getHead();
  const previous = store.getLatestManifest();
  if (from === null || previous === null)
    throw new UpdateError("the store has no wiki yet; run wiki:build first");
  if (from === to) throw new UpdateError(`the wiki is already at ${to}`);
  if (!isAncestor(repo, from, to)) {
    throw new UpdateError(
      `${from} is not an ancestor of ${to}; an update only moves forward along history`,
    );
  }
  const changes = diffCommits(repo, from, to);
  const reached = reachableCommits(repo, from);
  const head = history.find((c) => c.sha === to);
  return {
    from,
    to,
    pr: pullRequestOf(head?.subject ?? ""),
    commitDate: IsoDateTime.safeParse(head?.date).success
      ? (head?.date as string)
      : now().toISOString(),
    changes,
    touched: new Set(
      changes.flatMap((c) => [c.oldPath, c.newPath].filter((p): p is string => p !== null)),
    ),
    commits: history.filter((c) => !reached.has(c.sha)),
    previous,
    baseline: store.getDriftBaseline() ?? previous,
    graph: input.graph ?? buildFileGraph(index),
    placement: placeNewFiles(previous, index, changes),
  };
}

/**
 * The membership at `to` once every new file has a feature (`placed`: the decided ones and the
 * tie-break's), as the previous manifest moved to `to`, and each feature's churn against the
 * baseline, with the active features over `threshold` (spec §6.1 step 4). Throws an UpdateError
 * for a new file `placed` does not give a feature.
 */
export function measureDrift(
  plan: UpdatePlan,
  index: RepoIndex,
  placed: ReadonlyMap<string, string>,
  threshold: number,
): {
  membership: Record<string, Membership>;
  manifest: Manifest;
  churn: Map<string, number>;
  drifted: string[];
} {
  // Every file must have a feature by now; nextMembership would throw a bare Error for one that
  // has none (a disputed file the tie-break has not placed yet), so say it as an UpdateError.
  const renames = renamesOf(plan.changes);
  for (const file of index.files) {
    const old = renames.get(file.path) ?? file.path;
    if (plan.previous.membership[memberId(old)] === undefined && !placed.has(file.path)) {
      throw new UpdateError(
        `no feature for the new file ${file.path}: it is not placed yet, so drift cannot be measured`,
      );
    }
  }
  const membership = nextMembership(plan.previous, index, plan.changes, plan.graph, placed);
  const manifest = Manifest.parse({ ...plan.previous, sha: plan.to, membership });
  const churn = featureChurn(plan.baseline, membership);
  return { membership, manifest, churn, drifted: driftedFeatures(manifest, churn, threshold) };
}

/** A feature's member files in a manifest. */
function filesOf(manifest: Manifest, featureId: string): Set<string> {
  const files = new Set<string>();
  for (const [member, entry] of Object.entries(manifest.membership)) {
    const parsed = parseMemberId(member);
    if (entry.featureId === featureId && parsed !== null && parsed.symbol === null)
      files.add(parsed.path);
  }
  return files;
}

/** Which pages an update rewrites, writes whole, or carries forward (spec §6.1 step 5). */
export interface PagePlan {
  /** Dirty pages: a stale claim, a coverage gap or a changed member file. */
  rewrites: PageRewrite[];
  /**
   * Active features written whole: changed by the manifest's operations, pending (a manifest-change
   * write of theirs failed in an earlier update), or with no page yet.
   */
  whole: string[];
  /** The pending ones among them (Store.getPendingWhole), sorted. */
  pending: string[];
  /** Active features whose page carries forward unchanged, sorted. */
  carried: string[];
  /** The current page of every feature that has one. */
  pages: Map<string, Revision>;
}

/**
 * Plans the pages of an update against `manifest`, the manifest at `to` (after any operations,
 * whose changed features are `affected`): every active feature's current page has its claims
 * moved to `to` (diffs from each citation's own sha are read once each, memoized here because
 * `remapCitation` asks per citation; a sha git cannot diff aborts the plan with an UpdateError
 * naming it, since its citations cannot be moved), the coverage gaps are
 * found against every fresh citation, and a page is dirty when a claim went stale, it has a gap,
 * or one of its member files (before or after) changed. A feature `affected`, or pending in the
 * store, is written whole instead, and so is one with no page. Features that are not active keep
 * their pages as they are.
 */
export function planPages(
  plan: UpdatePlan,
  store: Store,
  input: UpdateInput,
  manifest: Manifest,
  affected: ReadonlySet<string>,
): PagePlan {
  const { index, sources, repo } = input;
  const symbols = new Map(index.files.map((f) => [f.path, f.symbols]));
  const diffs = new Map<string, readonly FileChange[]>([[plan.from, plan.changes]]);
  const ctx: RemapContext = {
    sha: plan.to,
    changesSince: (sha) => {
      let found = diffs.get(sha);
      if (found === undefined) {
        try {
          found = diffCommits(repo, sha, plan.to);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          throw new UpdateError(
            `a stored citation names ${sha}, which git cannot diff against ${plan.to}; rebuild the wiki`,
            { cause: error },
          );
        }
        diffs.set(sha, found);
      }
      return found;
    },
    sources,
    symbolsOf: (path) => symbols.get(path) ?? [],
  };
  const active = manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id);
  const pages = new Map(store.listCurrentRevisions().map((r) => [r.featureId, r]));
  const pending = new Set(store.getPendingWhole().filter((id) => active.includes(id)));
  const writtenWhole = (id: string) => affected.has(id) || pending.has(id) || !pages.has(id);
  const planned = new Map(
    active.flatMap((id) => {
      const page = pages.get(id);
      return page === undefined
        ? []
        : [[id, remapClaims(page.sections, ctx, plan.touched)] as const];
    }),
  );
  const cited = new Map<string, LineRange[]>();
  for (const claims of planned.values()) {
    for (const { claim, status } of claims) {
      if (status !== "fresh") continue;
      for (const c of claim.citations) {
        if (c.kind === "code")
          cited.set(c.path, [...(cited.get(c.path) ?? []), { start: c.startLine, end: c.endLine }]);
      }
    }
  }
  const gaps = coverageGaps(plan.previous, index, plan.changes, manifest.membership, cited);
  const rewrites: PageRewrite[] = [];
  const carried: string[] = [];
  for (const featureId of active) {
    const revision = pages.get(featureId);
    const claims = planned.get(featureId);
    if (revision === undefined || claims === undefined || writtenWhole(featureId)) continue;
    const current = filesOf(manifest, featureId);
    const before = filesOf(plan.previous, featureId);
    const mine = (path: string | null) => path !== null && (current.has(path) || before.has(path));
    const changed = plan.changes.filter((c) => mine(c.newPath) || mine(c.oldPath));
    const featureGaps = gaps.get(featureId) ?? [];
    if (
      !claims.some((c) => c.status === "stale") &&
      featureGaps.length === 0 &&
      changed.length === 0
    ) {
      carried.push(featureId);
      continue;
    }
    rewrites.push({
      featureId,
      revision,
      claims,
      gaps: featureGaps,
      changed,
      commits: plan.commits.filter((c) => c.files.some(mine)),
      membershipChanged: current.size !== before.size || [...current].some((p) => !before.has(p)),
    });
  }
  const whole = active.filter(writtenWhole);
  return { rewrites, whole, pending: [...pending].sort(), carried: carried.sort(), pages };
}

/** The feature of a file that already has one: a member of the previous manifest, or decided. */
export function knownFeature(plan: UpdatePlan): (path: string) => string | undefined {
  return (path) =>
    plan.previous.membership[memberId(path)]?.featureId ?? plan.placement.decided.get(path);
}
