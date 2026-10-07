import {
  type Claim,
  INFLIGHT_REASON_MAX_LENGTH,
  type InFlightEffect,
  inflightLine,
  type Revision,
} from "@repowiki/core";
import { type RemapContext, remapClaims } from "../freshness/index.ts";
import {
  DEFAULT_MAX_FILE_BYTES,
  diffTrees,
  type FileChange,
  GitError,
  type GitOptions,
  isSha,
  readSources,
} from "../index/index.ts";
import { firstLine, INFLIGHT_GIT, inflightGit } from "./heads.ts";
import { type ImpactContext, isAncestorIn, type PullChanges, pullChanges } from "./impact.ts";

/** A claim of a current page that a move of the wiki would mark stale, and the remap's reason. */
export interface StaleClaim {
  featureId: string;
  revisionId: string;
  claimId: string;
  reason: string;
}

/**
 * What `git merge-tree --write-tree` makes of the wiki's head and a pull request's head (R7), in
 * inflight.git, which reads attributes from no file or tree (R21): the tree the wiki would
 * describe if the pull request merged now, or "conflicts", or "unknown" for a git older than
 * 2.38, which has no --write-tree, and for a head that shares no history with the wiki's head (a
 * fork's unrelated root: exit 128, "refusing to merge unrelated histories"). Any other failure
 * (a missing object among them) is a GitError.
 */
export function mergeTree(
  dir: string,
  wikiHead: string,
  head: string,
): { merge: "clean"; tree: string } | { merge: "conflicts" | "unknown"; tree: null } {
  const out = inflightGit(dir, [
    "merge-tree",
    "--write-tree",
    "--no-messages",
    "--end-of-options",
    wikiHead,
    head,
  ]);
  const tree = out.stdout.split("\n")[0]?.trim() ?? "";
  if (out.status === 0 && isSha(tree)) return { merge: "clean", tree };
  // A conflict exits 1 with the conflicted tree on stdout and, with --no-messages, no stderr.
  if (out.status === 1 && isSha(tree) && out.stderr.trim() === "")
    return { merge: "conflicts", tree: null };
  if (out.status === 129) return { merge: "unknown", tree: null };
  if (out.status === 128 && /refusing to merge unrelated histories/.test(out.stderr))
    return { merge: "unknown", tree: null };
  throw new GitError(`git merge-tree failed in ${dir}: ${firstLine(out.stderr)}`);
}

/** Every code citation of a body claim, with the claim. */
function codeCitations(claim: Claim) {
  return claim.citations.flatMap((c) => (c.kind === "code" ? [c] : []));
}

/**
 * The claims of `pages` that moving the wiki from `from` to `to` (a commit or a tree, in `repo`)
 * would mark stale, by the update's own remap (remapClaims, spec §6.1 step 2): each citation is
 * moved from its own sha through that sha's diff to `to` and hashed again. Only claims the move
 * touches count: a body claim citing a file changed between `from` and `to`, and a lead that
 * summarizes one of them; a claim that was already failing at `from` is not the move's doing.
 * The same function measures a prediction (to = a merged tree) and an update (to = its commit).
 * `options` defaults to plain reads of `repo`: a caller in inflight.git passes INFLIGHT_GIT. Unlike
 * the update's page plan, a stale-kept lead on a page dirty for another reason is not predicted
 * stale: that is a page-level rewrite, not a claim this move makes stale.
 */
export async function staleClaims(
  repo: string,
  from: string,
  to: string,
  pages: readonly Revision[],
  options: GitOptions = {},
): Promise<StaleClaim[]> {
  const moved = diffTrees(repo, from, to, undefined, options);
  const touched = new Set(
    moved.flatMap((c) => [c.oldPath, c.newPath].filter((p): p is string => p !== null)),
  );
  // Each citation sha's diff to `to`, read once and only for the paths cited at that sha.
  const cited = new Map<string, Set<string>>();
  for (const page of pages)
    for (const section of page.sections)
      for (const claim of section.claims)
        for (const c of codeCitations(claim))
          cited.set(c.sha, (cited.get(c.sha) ?? new Set()).add(c.path));
  const diffs = new Map<string, readonly FileChange[]>([[from, moved]]);
  const changesSince = (sha: string): readonly FileChange[] => {
    let found = diffs.get(sha);
    if (found === undefined) {
      found = diffTrees(repo, sha, to, cited.get(sha), options);
      diffs.set(sha, found);
    }
    return found;
  };
  // The paths the cited files have at `to`, read in one pass.
  const now = (c: { sha: string; path: string }) => {
    const change = changesSince(c.sha).find((x) => x.oldPath === c.path);
    return change === undefined ? c.path : change.newPath;
  };
  const wanted = new Set<string>();
  for (const page of pages)
    for (const section of page.sections)
      for (const claim of section.claims)
        for (const c of codeCitations(claim)) {
          const path = now(c);
          if (path !== null) wanted.add(path);
        }
  const sources = await readSources(repo, to, DEFAULT_MAX_FILE_BYTES, { ...options, only: wanted });
  const ctx: RemapContext = { sha: to, changesSince, sources, symbolsOf: () => [] };
  const stale: StaleClaim[] = [];
  for (const page of pages) {
    const remapped = remapClaims(page.sections, ctx, touched);
    const touches = (claim: Claim) =>
      codeCitations(claim).some((c) => {
        const path = now(c);
        return touched.has(c.path) || (path !== null && touched.has(path));
      });
    const body = new Set(
      remapped
        .filter((r) => r.key !== "lead" && r.status === "stale" && touches(r.claim))
        .map((r) => r.claim.id),
    );
    for (const r of remapped) {
      if (r.status !== "stale") continue;
      if (r.key !== "lead" && body.has(r.claim.id)) {
        stale.push({
          featureId: page.featureId,
          revisionId: page.id,
          claimId: r.claim.id,
          reason: r.reasons.join("; "),
        });
      } else if (r.key === "lead") {
        const summarized = r.claim.supports.filter((id) => body.has(id));
        if (summarized.length > 0)
          stale.push({
            featureId: page.featureId,
            revisionId: page.id,
            claimId: r.claim.id,
            reason: `it summarizes ${summarized.join(", ")}, which changed`,
          });
      }
    }
  }
  return stale;
}

/**
 * The fallback when the merge conflicts or git cannot merge (R7): every body claim citing a file
 * the pull request changes, and every lead summarizing one, may change.
 */
export function fileLevelEffects(
  pages: readonly Revision[],
  changes: readonly FileChange[],
): InFlightEffect[] {
  const paths = new Set(
    changes.flatMap((c) => [c.oldPath, c.newPath].filter((p): p is string => p !== null)),
  );
  const effects: InFlightEffect[] = [];
  for (const page of pages) {
    const claims = page.sections.flatMap((s) => s.claims.map((claim) => ({ key: s.key, claim })));
    const body = new Set(
      claims
        .filter(
          ({ key, claim }) => key !== "lead" && codeCitations(claim).some((c) => paths.has(c.path)),
        )
        .map(({ claim }) => claim.id),
    );
    for (const { key, claim } of claims) {
      const summarized = key === "lead" ? claim.supports.filter((id) => body.has(id)) : [];
      if (key !== "lead" && !body.has(claim.id)) continue;
      if (key === "lead" && summarized.length === 0) continue;
      effects.push({
        featureId: page.featureId,
        revisionId: page.id,
        claimId: claim.id,
        reason:
          key === "lead"
            ? `it summarizes ${summarized.join(", ")}, which may change`
            : "the pull request changes a cited file",
        certain: false,
      });
    }
  }
  return effects;
}

/** A pull request's changed files, features, merge state and effects on the wiki (R7, R8). */
export interface PullImpact extends PullChanges {
  merge: "clean" | "conflicts" | "unknown";
  effects: InFlightEffect[];
  /** The wiki's head does not hold the fork point (R27): every effect only may change. */
  behind: boolean;
}

/**
 * Everything the snapshot says a fetched pull request would do (R7, R27): its own files and
 * features, from `fork` (the fork point; by default the merge base with the wiki's head) to its
 * head (pullChanges). When the wiki's head holds the fork point, the claims of `pages` (the
 * current pages of active features) it would make stale if it merged now, from the merged tree,
 * with a conflict or an old git falling back to fileLevelEffects. When it does not (the wiki is
 * behind the pull request's base), merging with the wiki's head would credit the base's newer
 * commits to the pull request, so no merge is tried and its effects are fileLevelEffects.
 */
export async function pullImpact(
  ctx: ImpactContext,
  head: string,
  pages: readonly Revision[],
  fork?: string,
): Promise<PullImpact> {
  const changes = await pullChanges(ctx, head, fork);
  const behind =
    changes.mergeBase !== null && !isAncestorIn(ctx.dir, changes.mergeBase, ctx.wikiHead);
  if (behind)
    return {
      ...changes,
      merge: "unknown",
      effects: fileLevelEffects(pages, changes.changes),
      behind,
    };
  const merged = mergeTree(ctx.dir, ctx.wikiHead, head);
  const effects =
    merged.tree === null
      ? fileLevelEffects(pages, changes.changes)
      : (await staleClaims(ctx.dir, ctx.wikiHead, merged.tree, pages, INFLIGHT_GIT)).map((s) => ({
          ...s,
          reason: inflightLine(s.reason, INFLIGHT_REASON_MAX_LENGTH),
          certain: true,
        }));
  return { ...changes, merge: merged.merge, effects, behind };
}
