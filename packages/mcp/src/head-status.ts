import type { Claim, CodeCitation } from "@repowiki/core";
import {
  type CitationFate,
  DEFAULT_MAX_FILE_BYTES,
  diffCommits,
  type FileChange,
  GitError,
  type RemapContext,
  remapCitation,
} from "@repowiki/engine";
import { count, cut, oneLine, SECTION_TITLES } from "@repowiki/query";
import { fileAt } from "./code.ts";
import { commitOf, GIT_TIMEOUT_MS, gitOutput } from "./git.ts";

/**
 * Where the repository stands against the wiki (spec v2 #5 §5): the compare commit, how far it is
 * from the wiki's head each way, and every path that differs between the two (old and new paths
 * of a rename, since renames are not paired here). `known` is false when the repository lacks the
 * wiki's head, has no HEAD, or a git call of the comparison failed (`problem` says why); then
 * nothing is compared.
 */
export interface HeadStatus {
  compare: string | null;
  wikiHead: string;
  known: boolean;
  /** Commits in the compare commit's history that the wiki's head lacks. */
  ahead: number;
  /** Commits in the wiki head's history that the compare commit lacks (a compare commit behind it). */
  behind: number;
  changedFiles: ReadonlySet<string>;
  /** The changed paths that are new at the compare commit. */
  addedFiles: ReadonlySet<string>;
  /** One line saying why freshness is unknown, when a git call failed (spec v2 #5 R16). */
  problem?: string;
}

/**
 * A claim whose code moved since the wiki's commit: `changed` when a citation is stale by
 * remapCitation (the next wiki:update would rewrite the claim), with one reason per citation;
 * `moved` when every citation still holds but some sit at other lines or another path. A reason
 * reads "<path>:<start>-<end>: <why>", the range as cited.
 */
export type ClaimMark =
  | { kind: "changed"; reasons: string[] }
  | { kind: "moved"; citations: number };

/** Where a cited range is at the compare commit, for cited_code. */
export type CitationNow =
  | { kind: "unchanged" | "moved"; path: string; startLine: number; endLine: number }
  | { kind: "changed"; path: string }
  | { kind: "deleted" }
  | { kind: "unknown"; why: string };

/** The most per-revision mark sets kept (spec v2 #5 §4.2). */
export const MAX_CACHED_MARKS = 256;

export interface Freshness {
  /** The status against the compare commit as of now (HEAD is re-resolved unless pinned). */
  status(): HeadStatus;
  /**
   * Each marked claim of a revision's sections, by claim id; empty when the status is unknown.
   * When computing them fails, the status turns unknown (with its problem) for that compare commit.
   */
  marks(
    revisionId: string,
    sections: readonly { key: string; claims: readonly Claim[] }[],
  ): ReadonlyMap<string, ClaimMark>;
  /** Where one code citation is at the compare commit. */
  citationNow(citation: CodeCitation): CitationNow;
}

export interface FreshnessOptions {
  repo: string;
  wikiHead: string;
  /** The compare commit: a sha pinned by --compare-to, or null for the repository's HEAD. */
  pinned: string | null;
}

/**
 * A lead's reason, by the sections of the changed claims it summarizes (one key per claim):
 * read_page shows no claim ids, so it names where the marked claims are.
 */
function leadReason(keys: readonly string[]): string {
  const titles = [...new Set(keys)].map((k) => SECTION_TITLES[k] ?? k);
  const where =
    titles.length <= 2
      ? titles.join(" and ")
      : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
  return `it summarizes ${count(keys.length, "claim")} below that changed, in ${where}`;
}

/** A Map that forgets its least recently used entry past `max`. */
function lru<V>(max: number) {
  const map = new Map<string, V>();
  return {
    get(key: string, make: () => V): V {
      const found = map.get(key);
      if (found !== undefined) {
        map.delete(key);
        map.set(key, found);
        return found;
      }
      const value = make();
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value as string);
      return value;
    },
  };
}

/**
 * Freshness for one loaded wiki (spec v2 #5 R7): the head status, cached per compare sha, and
 * per-claim marks computed as wiki:update computes staleness, with the engine's remapCitation
 * (so "marked" means exactly "stale at the next update"), cached per (compare sha, revision).
 * A citation whose file no change touched between its commit and the compare commit holds
 * there unchanged, so it is not remapped (its stored hash held when it was cited). Reads only
 * git objects. A git failure (a timeout, too much output, a missing object) never escapes: freshness
 * is unknown against that compare commit, with a one-line problem, for the rest of the session,
 * so a slow repository is not asked again on every call (R7 "serve, mark, never refuse").
 */
export function createFreshness(options: FreshnessOptions): Freshness {
  const { repo, wikiHead } = options;
  const statuses = lru<HeadStatus>(8);
  const changes = lru<readonly FileChange[]>(64);
  const markSets = lru<ReadonlyMap<string, ClaimMark>>(MAX_CACHED_MARKS);
  const present = new Map<string, boolean>();
  /** Whether the repository holds commit `sha`; asked once per sha. */
  const holds = (sha: string) => {
    let found = present.get(sha);
    if (found === undefined) {
      found = commitOf(repo, sha) === sha;
      present.set(sha, found);
    }
    return found;
  };
  /** Why freshness failed against a compare commit, kept for the session (the last 8). */
  const failures = new Map<string, string>();
  const failed = (compare: string, error: unknown): string => {
    if (!(error instanceof GitError)) throw error;
    const problem = cut(oneLine(error.message), 300);
    failures.set(compare, problem);
    if (failures.size > 8) failures.delete(failures.keys().next().value as string);
    return problem;
  };
  const unknownAt = (compare: string | null, problem?: string): HeadStatus => ({
    compare,
    wikiHead,
    known: false,
    ahead: 0,
    behind: 0,
    changedFiles: new Set(),
    addedFiles: new Set(),
    ...(problem === undefined ? {} : { problem }),
  });

  /** rev-list and diff-tree from the wiki's head to the compare commit. */
  const compute = (compare: string): HeadStatus => {
    const [behind = "0", ahead = "0"] = gitOutput(repo, [
      "rev-list",
      "--left-right",
      "--count",
      "--end-of-options",
      `${wikiHead}...${compare}`,
    ])
      .toString("utf8")
      .trim()
      .split(/\s+/);
    const tokens = gitOutput(repo, [
      "diff-tree",
      "-r",
      "--name-status",
      "-z",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--end-of-options",
      wikiHead,
      compare,
    ])
      .toString("utf8")
      .split("\0");
    const changedFiles = new Set<string>();
    const addedFiles = new Set<string>();
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const path = tokens[i + 1] as string;
      changedFiles.add(path);
      if (tokens[i] === "A") addedFiles.add(path);
    }
    return {
      compare,
      wikiHead,
      known: true,
      ahead: Number(ahead),
      behind: Number(behind),
      changedFiles,
      addedFiles,
    };
  };

  const statusAt = (compare: string | null): HeadStatus => {
    if (compare === null || !holds(wikiHead)) return unknownAt(compare);
    const problem = failures.get(compare);
    if (problem !== undefined) return unknownAt(compare, problem);
    try {
      return statuses.get(compare, () => compute(compare));
    } catch (error) {
      return unknownAt(compare, failed(compare, error));
    }
  };

  /** The status against the compare commit as of now; a git that cannot run is a problem too. */
  const current = (): HeadStatus => {
    try {
      return statusAt(options.pinned ?? commitOf(repo, "HEAD"));
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return unknownAt(null, cut(oneLine(error.message), 300));
    }
  };

  /**
   * diffCommits from a citation's commit to the compare commit, for the cited paths only (renames
   * still paired over the whole tree): a wiki far behind HEAD changes hundreds of files, and
   * diffing each for hunks would take seconds. Memoised per commit pair and path set.
   */
  const changesSince = (compare: string, paths: ReadonlySet<string>) => {
    const key = [...paths].sort().join("\0");
    return (from: string) =>
      changes.get(`${from}\0${compare}\0${key}`, () =>
        holds(from) ? diffCommits(repo, from, compare, paths, { timeoutMs: GIT_TIMEOUT_MS }) : [],
      );
  };

  /** The fate of each citation that a change touched, keyed by the citation object. */
  const fates = (compare: string, citations: readonly CodeCitation[]) => {
    const since = changesSince(compare, new Set(citations.map((c) => c.path)));
    const touched = citations.filter(
      (c) => !holds(c.sha) || since(c.sha).some((x) => x.oldPath === c.path),
    );
    const paths = new Set<string>();
    for (const c of touched) {
      const change = since(c.sha).find((x) => x.oldPath === c.path);
      if (change?.newPath !== null) paths.add(change?.newPath ?? c.path);
    }
    const sources = new Map<string, string>();
    for (const path of paths) {
      // wiki:update's own limit: a file it would not read is one whose claims it calls stale.
      const file = fileAt(repo, compare, path, DEFAULT_MAX_FILE_BYTES);
      if ("text" in file) sources.set(path, file.text);
    }
    const ctx: RemapContext = { sha: compare, changesSince: since, sources, symbolsOf: () => [] };
    return new Map<CodeCitation, CitationFate>(touched.map((c) => [c, remapCitation(c, ctx)]));
  };

  return {
    status: current,

    marks(revisionId, sections) {
      const status = current();
      const compare = status.compare;
      if (!status.known || compare === null) return new Map();
      try {
        return markSets.get(`${compare}\0${revisionId}`, () => {
          const claims = sections.flatMap((s) => s.claims.map((claim) => ({ key: s.key, claim })));
          // A lead's own citations are never remapped: its mark comes from the claims it supports.
          const code = claims.flatMap(({ key, claim }) =>
            key !== "lead" && claim.staleSince === null
              ? claim.citations.flatMap((c) => (c.kind === "code" ? [c] : []))
              : [],
          );
          const fate = fates(compare, code);
          const marks = new Map<string, ClaimMark>();
          for (const { key, claim } of claims) {
            if (key === "lead" || claim.staleSince !== null) continue;
            const reasons: string[] = [];
            let moved = 0;
            for (const c of claim.citations) {
              if (c.kind !== "code") continue;
              const f = fate.get(c);
              if (f === undefined) continue;
              if ("stale" in f) {
                reasons.push(`${c.path}:${c.startLine}-${c.endLine}: ${f.stale}`);
              } else if (
                f.fresh.path !== c.path ||
                f.fresh.startLine !== c.startLine ||
                f.fresh.endLine !== c.endLine
              ) {
                moved++;
              }
            }
            if (reasons.length > 0) marks.set(claim.id, { kind: "changed", reasons });
            else if (moved > 0) marks.set(claim.id, { kind: "moved", citations: moved });
          }
          // A lead claim summarizes the claims it supports: it is changed when one of them is
          // (spec §5 rule 2).
          const sectionOf = new Map(claims.map(({ key, claim }) => [claim.id, key]));
          for (const { key, claim } of claims) {
            if (key !== "lead" || claim.staleSince !== null) continue;
            const changed = claim.supports.filter((id) => marks.get(id)?.kind === "changed");
            if (changed.length > 0) {
              const keys = changed.map((id) => sectionOf.get(id) ?? "");
              marks.set(claim.id, { kind: "changed", reasons: [leadReason(keys)] });
            }
          }
          return marks;
        });
      } catch (error) {
        failed(compare, error);
        return new Map();
      }
    },

    citationNow(citation) {
      const status = current();
      const compare = status.compare;
      if (!status.known || compare === null) {
        return {
          kind: "unknown",
          why: status.problem ?? "the repository does not hold the wiki's commit",
        };
      }
      let fate: CitationFate | undefined;
      try {
        fate = fates(compare, [citation]).get(citation);
      } catch (error) {
        return { kind: "unknown", why: failed(compare, error) };
      }
      const { path, startLine, endLine } = citation;
      if (fate === undefined) return { kind: "unchanged", path, startLine, endLine };
      if ("fresh" in fate) {
        const { fresh } = fate;
        const same =
          fresh.path === path && fresh.startLine === startLine && fresh.endLine === endLine;
        return {
          kind: same ? "unchanged" : "moved",
          path: fresh.path,
          startLine: fresh.startLine,
          endLine: fresh.endLine,
        };
      }
      return fate.path === null ? { kind: "deleted" } : { kind: "changed", path: fate.path };
    },
  };
}
