import {
  INFLIGHT_MAX_FILES,
  type InFlightFeature,
  type InFlightFile,
  isInflightPath,
  type Manifest,
  type Membership,
  memberId,
  parseMemberId,
} from "@repowiki/core";
import { buildFileGraph, type FileGraph } from "../cluster/index.ts";
import { fallbackFeature, featureChurn, placeNewFiles } from "../freshness/index.ts";
import {
  diffTrees,
  type FileChange,
  GitError,
  indexRepo,
  isSha,
  type RepoIndex,
} from "../index/index.ts";
import { isTestFile } from "../link/index.ts";
import { firstLine, INFLIGHT_GIT, inflightGit } from "./heads.ts";

/** What a pull request's impact is computed against: the wiki's head in inflight.git (R7, R8). */
export interface ImpactContext {
  /** inflight.git: the documented repository's objects through alternates, plus the heads. */
  dir: string;
  wikiHead: string;
  /** The latest stored manifest, at the wiki's head. */
  manifest: Manifest;
  /** The drift baseline (Store.getDriftBaseline, else the manifest). */
  baseline: Manifest;
  /** Drift above this share would trigger a manifest revision (DEFAULT_DRIFT_THRESHOLD). */
  driftThreshold: number;
}

/** A pull request's changed files and what they do to each feature (R8). */
export interface PullChanges {
  /**
   * Where its own changes start: the fork point given (R27), else the merge base of the wiki's head
   * and the pull request's head; null when they share none.
   */
  mergeBase: string | null;
  /**
   * Every file the pull request changes, from that commit (else the wiki's head) to its head, less
   * those with an unsafe path.
   */
  changes: FileChange[];
  /** The first INFLIGHT_MAX_FILES of them by path, each with its feature. */
  files: InFlightFile[];
  /** Files beyond those listed: past the cap, or dropped for an unsafe path. */
  filesTruncated: number;
  /** Heaviest first. */
  features: InFlightFeature[];
}

/** The merge base of two commits in inflight.git, or null when they have none. */
export function mergeBase(dir: string, a: string, b: string): string | null {
  const out = inflightGit(dir, ["merge-base", "--end-of-options", a, b]);
  if (out.status === 1 && out.stderr.trim() === "") return null;
  const sha = out.stdout.trim();
  if (out.status !== 0 || !isSha(sha))
    throw new GitError(`git merge-base failed in ${dir}: ${firstLine(out.stderr)}`);
  return sha;
}

/** Whether `ancestor` is `descendant` or one of its ancestors, in inflight.git. */
export function isAncestorIn(dir: string, ancestor: string, descendant: string): boolean {
  const out = inflightGit(dir, [
    "merge-base",
    "--is-ancestor",
    "--end-of-options",
    ancestor,
    descendant,
  ]);
  if (out.status === 0 || out.status === 1) return out.status === 0;
  throw new GitError(`git merge-base --is-ancestor failed in ${dir}: ${firstLine(out.stderr)}`);
}

/**
 * A pull request's fork point (R27): merge-base(base oid, head), the commit GitHub diffs it from.
 * Null when GitHub gave no base oid, inflight.git does not hold that commit (its fetch failed), or
 * the two share no history.
 */
export function forkPoint(dir: string, baseOid: string | null, head: string): string | null {
  if (baseOid === null || !isSha(baseOid)) return null;
  const there = inflightGit(dir, ["cat-file", "-e", "--end-of-options", `${baseOid}^{commit}`]);
  return there.status === 0 ? mergeBase(dir, baseOid, head) : null;
}

/**
 * Lines added and removed per file between two objects (`git diff --numstat -z -M`), keyed by the
 * file's path at `to` (its old path when deleted). A binary file counts 0 and 0. Diff drivers and
 * textconv never run (R21).
 */
export function lineCounts(
  dir: string,
  from: string,
  to: string,
): Map<string, { additions: number; deletions: number }> {
  const out = inflightGit(dir, [
    "diff",
    "--numstat",
    "-z",
    "-M",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--end-of-options",
    from,
    to,
  ]);
  if (out.status !== 0) throw new GitError(`git diff failed in ${dir}: ${firstLine(out.stderr)}`);
  const counts = new Map<string, { additions: number; deletions: number }>();
  const tokens = out.stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens[i] ?? "";
    if (head === "") continue;
    // "added<TAB>removed<TAB>path": the path is all that follows the second tab, since a path
    // may hold a tab of its own (-z writes it raw).
    const first = head.indexOf("\t");
    const second = first === -1 ? -1 : head.indexOf("\t", first + 1);
    if (second === -1) continue;
    const added = head.slice(0, first);
    const removed = head.slice(first + 1, second);
    const path = head.slice(second + 1);
    const count = (n: string) => (/^\d+$/.test(n) ? Number(n) : 0);
    // A rename's entry ends in a tab; its old and new paths follow as tokens of their own.
    const key = path === "" ? (tokens[i + 2] ?? "") : path;
    if (path === "") i += 2;
    counts.set(key, { additions: count(added), deletions: count(removed) });
  }
  return counts;
}

/** Whether a change's paths are safe to store, show and prompt with (isInflightPath, R13). */
const safeChange = (change: FileChange): boolean =>
  [change.oldPath, change.newPath].every((path) => path === null || isInflightPath(path));

/** The path a change has at the head, or the one it had for a deletion. */
const pathOf = (change: FileChange): string => change.newPath ?? change.oldPath ?? "";

/** A file's feature in the manifest: its own, or its old path's for a rename or edit. */
function memberFeature(manifest: Manifest, change: FileChange): string | undefined {
  const of = (path: string | null) =>
    path === null ? undefined : manifest.membership[memberId(path)]?.featureId;
  return of(change.oldPath) ?? of(change.newPath);
}

/** The share of a file's edge weight that stays in `featureId`, at least 0.05, as nextMembership. */
function centrality(
  path: string,
  featureId: string,
  graph: FileGraph,
  featureOf: (path: string) => string | undefined,
): number {
  let inside = 0;
  let total = 0;
  for (const { a, b, weight } of graph.edges) {
    const other = a === path ? b : b === path ? a : null;
    if (other === null) continue;
    total += weight;
    if (featureOf(other) === featureId) inside += weight;
  }
  return Math.max(0.05, total === 0 ? 0 : inside / total);
}

/**
 * The manifest's membership as it would be once the pull request merged (R8): members of deleted
 * files leave, members of renamed files move with them, and each placed file joins with its
 * symbols, weighted as nextMembership weighs a new file (role times centrality). Symbols a
 * pull request adds to or removes from a file it edits are not counted: drift is a prediction.
 */
function membershipAfter(
  manifest: Manifest,
  changes: readonly FileChange[],
  placed: ReadonlyMap<string, string>,
  index: RepoIndex | null,
  graph: FileGraph | null,
  featureOf: (path: string) => string | undefined,
): Record<string, Membership> {
  const byPath = new Map<string, string[]>();
  for (const member of Object.keys(manifest.membership)) {
    const path = parseMemberId(member)?.path;
    if (path !== undefined) byPath.set(path, [...(byPath.get(path) ?? []), member]);
  }
  const after: Record<string, Membership> = { ...manifest.membership };
  for (const change of changes) {
    if (change.status !== "deleted" && change.status !== "renamed") continue;
    for (const member of byPath.get(change.oldPath ?? "") ?? []) {
      const entry = after[member];
      delete after[member];
      const symbol = parseMemberId(member)?.symbol ?? null;
      if (change.status === "renamed" && change.newPath !== null && entry !== undefined)
        after[symbol === null ? memberId(change.newPath) : memberId(change.newPath, symbol)] =
          entry;
    }
  }
  const files = new Map(index?.files.map((f) => [f.path, f]) ?? []);
  for (const [path, featureId] of placed) {
    const file = files.get(path);
    const role = file === undefined || file.language === null || isTestFile(path) ? 0.5 : 1;
    const share = graph === null ? 0.05 : centrality(path, featureId, graph, featureOf);
    const entry = { featureId, weight: Math.round(role * share * 1000) / 1000 };
    after[memberId(path)] = entry;
    for (const symbol of file?.symbols ?? []) after[symbol.id] = entry;
  }
  return after;
}

/**
 * The features a pull request touches, heaviest first (by changed lines, then files, then id),
 * with each one's churn after it would merge and whether that passes the drift threshold.
 */
function featuresOf(
  files: readonly InFlightFile[],
  churn: ReadonlyMap<string, number>,
  threshold: number,
): InFlightFeature[] {
  const byFeature = new Map<string, InFlightFeature>();
  for (const file of files) {
    if (file.featureId === null) continue;
    const feature = byFeature.get(file.featureId) ?? {
      featureId: file.featureId,
      files: 0,
      changedLines: 0,
      added: 0,
      removed: 0,
      churn: 0,
      drifts: false,
    };
    feature.files++;
    feature.changedLines += file.additions + file.deletions;
    if (file.status === "added") feature.added++;
    if (file.status === "deleted") feature.removed++;
    byFeature.set(file.featureId, feature);
  }
  for (const feature of byFeature.values()) {
    const value = churn.get(feature.featureId) ?? 0;
    feature.churn = Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
    feature.drifts = value > threshold;
  }
  return [...byFeature.values()].sort(
    (a, b) =>
      b.changedLines - a.changedLines ||
      b.files - a.files ||
      (a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0),
  );
}

/**
 * Which files a pull request changes and where they belong (R8): the diff from `fork` (R27; by
 * default the merge base of the wiki's head and its head) to its head, each file in its manifest
 * feature (a rename follows its old path), and every other file that exists at the head placed as
 * an update places a new file (placeNewFiles over an index built at the head, a disputed one by
 * fallbackFeature, never a call). The index is built only when some file needs placing. A file
 * the pull request deletes that the wiki's head lacks has no feature. A change whose path fails
 * isInflightPath (a control, tab, line-break or bidi character, a backslash, or over the cap) is
 * dropped before anything else sees it, and counted in filesTruncated.
 */
export async function pullChanges(
  ctx: ImpactContext,
  head: string,
  fork?: string,
): Promise<PullChanges> {
  const base = fork ?? mergeBase(ctx.dir, ctx.wikiHead, head);
  const from = base ?? ctx.wikiHead;
  const diffed = diffTrees(ctx.dir, from, head, undefined, INFLIGHT_GIT);
  const changes = diffed.filter(safeChange);
  const dropped = diffed.length - changes.length;
  const counts = lineCounts(ctx.dir, from, head);
  const unknown = changes.filter(
    (c) => c.newPath !== null && memberFeature(ctx.manifest, c) === undefined,
  );
  let index: RepoIndex | null = null;
  let graph: FileGraph | null = null;
  const placed = new Map<string, string>();
  if (unknown.length > 0) {
    index = await indexRepo(ctx.dir, head, { git: INFLIGHT_GIT });
    graph = buildFileGraph(index);
    const placement = placeNewFiles(ctx.manifest, index, changes);
    const known = (path: string) =>
      ctx.manifest.membership[memberId(path)]?.featureId ?? placement.decided.get(path);
    const disputed = new Map(placement.disputed.map((d) => [d.path, d.candidates]));
    for (const change of unknown) {
      const path = change.newPath as string;
      const candidates = disputed.get(path);
      const feature =
        placement.decided.get(path) ??
        (candidates === undefined ? undefined : fallbackFeature(path, candidates, graph, known));
      if (feature !== undefined) placed.set(path, feature);
    }
  }
  const all: InFlightFile[] = changes.map((change) => {
    const path = pathOf(change);
    const member = memberFeature(ctx.manifest, change);
    const inferred = change.newPath === null ? undefined : placed.get(change.newPath);
    const featureId = member ?? inferred ?? null;
    const lines = counts.get(path) ?? { additions: 0, deletions: 0 };
    return {
      path,
      oldPath: change.oldPath,
      status: change.status,
      ...lines,
      featureId,
      placement: member !== undefined ? "member" : inferred !== undefined ? "inferred" : "none",
    };
  });
  const featureOf = (path: string) =>
    ctx.manifest.membership[memberId(path)]?.featureId ?? placed.get(path);
  const churn = featureChurn(
    ctx.baseline,
    membershipAfter(ctx.manifest, changes, placed, index, graph, featureOf),
  );
  const byPath = (a: InFlightFile, b: InFlightFile) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  const files = [...all].sort(byPath);
  return {
    mergeBase: base,
    changes,
    files: files.slice(0, INFLIGHT_MAX_FILES),
    filesTruncated: Math.max(0, files.length - INFLIGHT_MAX_FILES) + dropped,
    features: featuresOf(all, churn, ctx.driftThreshold),
  };
}

/**
 * The features of a pull request whose head was not fetched (spec v2 #9 §5.1): GitHub's file
 * list, counting only paths that are manifest members, with no line counts and no drift.
 */
export function featuresFromPaths(manifest: Manifest, paths: readonly string[]): InFlightFeature[] {
  const files: InFlightFile[] = paths.flatMap((path) => {
    const featureId = manifest.membership[memberId(path)]?.featureId;
    return featureId === undefined
      ? []
      : [
          {
            path,
            oldPath: path,
            status: "modified" as const,
            additions: 0,
            deletions: 0,
            featureId,
            placement: "member" as const,
          },
        ];
  });
  return featuresOf(files, new Map(), Number.POSITIVE_INFINITY).map((f) => ({ ...f, churn: null }));
}
