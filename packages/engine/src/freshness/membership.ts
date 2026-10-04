import { posix } from "node:path";
import { type Manifest, type Membership, memberId } from "@repowiki/core";
import type { FileGraph } from "../cluster/index.ts";
import type { FileChange, RepoIndex } from "../index/index.ts";
import { isTestFile } from "../link/index.ts";
import type { LineRange } from "./remap.ts";

/** Where the new files of an update go (spec §6.1 step 3). */
export interface Placement {
  /** New path → feature id, for each new file whose signals agree. */
  decided: Map<string, string>;
  /** New files whose signals disagree or are silent, with the features in question, sorted. */
  disputed: { path: string; candidates: string[] }[];
}

/** Renamed files at the new sha, by new path → old path. */
export function renamesOf(changes: readonly FileChange[]): Map<string, string> {
  return new Map(
    changes.flatMap((c) =>
      c.status === "renamed" && c.oldPath !== null && c.newPath !== null
        ? [[c.newPath, c.oldPath] as const]
        : [],
    ),
  );
}

/** The features with the highest count, sorted; none for no counts. */
function strongest(counts: ReadonlyMap<string, number>): string[] {
  const top = Math.max(0, ...counts.values());
  return [...counts]
    .filter(([, n]) => n === top && n > 0)
    .map(([id]) => id)
    .sort();
}

/**
 * Puts every file that is new at the index's sha (neither a member of `previous` nor a renamed
 * member) in a feature by three signals, each read from the files that already have one: the
 * features of the files it imports or that import it, of the files it changed together with,
 * and of the files in its directory (else the nearest directory above that has any). When every
 * signal that has an opinion names the same one feature, that is its feature; when they disagree,
 * or none has one, the file is disputed between the features they name (all active features if
 * none), and the tie-break model decides. A renamed file keeps its old feature.
 */
export function placeNewFiles(
  previous: Manifest,
  index: RepoIndex,
  changes: readonly FileChange[],
): Placement {
  const renames = renamesOf(changes);
  const known = (path: string): string | undefined => {
    const old = renames.get(path) ?? path;
    return previous.membership[memberId(old)]?.featureId;
  };
  const active = previous.features
    .filter((f) => f.status.kind === "active")
    .map((f) => f.id)
    .sort();
  const byDir = new Map<string, string[]>();
  for (const file of index.files) {
    const dir = posix.dirname(file.path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), file.path]);
  }
  const tally = (paths: Iterable<[string, number]>): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const [path, weight] of paths) {
      const feature = known(path);
      if (feature !== undefined) counts.set(feature, (counts.get(feature) ?? 0) + weight);
    }
    return counts;
  };

  const placement: Placement = { decided: new Map(), disputed: [] };
  for (const file of index.files) {
    if (known(file.path) !== undefined) continue;
    const path = file.path;
    const imports = tally(
      index.imports.flatMap((e) =>
        e.from === path
          ? [[e.to, 1] as [string, number]]
          : e.to === path
            ? [[e.from, 1] as [string, number]]
            : [],
      ),
    );
    const together = tally(
      index.coChange.pairs.flatMap((p) =>
        p.a === path
          ? [[p.b, p.count] as [string, number]]
          : p.b === path
            ? [[p.a, p.count] as [string, number]]
            : [],
      ),
    );
    let dir = posix.dirname(path);
    let directory = tally((byDir.get(dir) ?? []).map((p) => [p, 1]));
    while (directory.size === 0 && dir !== ".") {
      dir = posix.dirname(dir);
      directory = tally((byDir.get(dir) ?? []).map((p) => [p, 1]));
    }
    const named = [...new Set([imports, together, directory].flatMap(strongest))].sort();
    const candidates = named.length > 0 ? named : active;
    if (candidates.length === 1) placement.decided.set(path, candidates[0] as string);
    else if (candidates.length > 1) placement.disputed.push({ path, candidates });
  }
  return placement;
}

const ROUND = 1000;
/** The lowest centrality a member can have, as in the manifest step (spec §5 rule 8). */
const MIN_CENTRALITY = 0.05;

/**
 * The membership at the index's sha, before any manifest operation: every file and symbol
 * `previous` already held keeps its feature and weight (a renamed file and its symbols move with
 * it); a deleted file and a removed symbol leave; a new symbol of a known file joins as its file
 * does; a new file joins the feature `placed` gives it, weighted by its role (0.5 for a test or a
 * file with no parsed language, else 1) times its centrality (spec §5 rule 8), the share of its
 * edge weight in `graph` that stays in its feature, at least 0.05. Throws for a new file with no
 * place: placeNewFiles and the tie-break leave none.
 */
export function nextMembership(
  previous: Manifest,
  index: RepoIndex,
  changes: readonly FileChange[],
  graph: FileGraph,
  placed: ReadonlyMap<string, string>,
): Record<string, Membership> {
  const renames = renamesOf(changes);
  const fileFeature = new Map<string, string>();
  for (const file of index.files) {
    const old = renames.get(file.path) ?? file.path;
    const feature = previous.membership[memberId(old)]?.featureId ?? placed.get(file.path);
    if (feature === undefined) throw new Error(`no feature for the new file ${file.path}`);
    fileFeature.set(file.path, feature);
  }
  const inside = new Map<string, number>();
  const total = new Map<string, number>();
  for (const { a, b, weight } of graph.edges) {
    const same = fileFeature.get(a) === fileFeature.get(b);
    for (const path of [a, b]) {
      total.set(path, (total.get(path) ?? 0) + weight);
      if (same) inside.set(path, (inside.get(path) ?? 0) + weight);
    }
  }

  const membership: Record<string, Membership> = {};
  for (const file of index.files) {
    const old = renames.get(file.path) ?? file.path;
    const featureId = fileFeature.get(file.path) as string;
    let entry = previous.membership[memberId(old)];
    if (entry === undefined) {
      const all = total.get(file.path) ?? 0;
      const centrality = Math.max(
        MIN_CENTRALITY,
        all === 0 ? 0 : (inside.get(file.path) ?? 0) / all,
      );
      const role = file.language === null || isTestFile(file.path) ? 0.5 : 1;
      entry = { featureId, weight: Math.round(role * centrality * ROUND) / ROUND };
    }
    membership[file.id] = entry;
    for (const symbol of file.symbols) {
      membership[symbol.id] = previous.membership[memberId(old, symbol.qualifiedName)] ?? entry;
    }
  }
  return membership;
}

/** Code at the new sha that no claim describes (spec §6.1 step 3). */
export interface Gap {
  path: string;
  symbol: string;
  startLine: number;
  endLine: number;
}

/**
 * The coverage gaps of each feature, in path and line order: top-level exported symbols of
 * non-test source files that are new at the index's sha (not members of `previous`, under their
 * old path for a renamed file) and that no fresh citation overlaps. `cited` holds every fresh
 * code citation's range at the new sha, by path.
 */
export function coverageGaps(
  previous: Manifest,
  index: RepoIndex,
  changes: readonly FileChange[],
  membership: Readonly<Record<string, Membership>>,
  cited: ReadonlyMap<string, readonly LineRange[]>,
): Map<string, Gap[]> {
  const renames = renamesOf(changes);
  const gaps = new Map<string, Gap[]>();
  for (const file of index.files) {
    if (file.language === null || isTestFile(file.path)) continue;
    const old = renames.get(file.path) ?? file.path;
    for (const symbol of file.symbols) {
      if (!symbol.exported || symbol.qualifiedName.includes(".")) continue;
      if (previous.membership[memberId(old, symbol.qualifiedName)] !== undefined) continue;
      const covered = (cited.get(file.path) ?? []).some(
        (r) => r.start <= symbol.endLine && r.end >= symbol.startLine,
      );
      const featureId = membership[symbol.id]?.featureId;
      if (covered || featureId === undefined) continue;
      gaps.set(featureId, [
        ...(gaps.get(featureId) ?? []),
        {
          path: file.path,
          symbol: symbol.qualifiedName,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
        },
      ]);
    }
  }
  return gaps;
}
