import type { InFlight, Revision } from "@repowiki/core";
import {
  pullRequestOf,
  reachableCommits,
  readHistory,
  type Store,
  staleClaims,
} from "@repowiki/engine";
import type { ModelConfig } from "@repowiki/llm";
import { parseInflightArgs } from "./inflight-cli.ts";
import { refreshOffline } from "./inflight-run.ts";
import { problemLine } from "./wiki-cli.ts";

/** What the hook needs from before an update moved the store: its head, snapshot and pages. */
export interface BeforeUpdate {
  from: string;
  inflight: InFlight | null;
  pages: Revision[];
}

/**
 * The store as it stands before an update, when GitHub was ever read; else null. It never
 * throws: a store the update itself will refuse (a damaged page) is the update's error to
 * report, and the hook then has nothing to compare.
 */
export function beforeUpdate(store: Store): BeforeUpdate | null {
  try {
    const from = store.getHead();
    if (from === null || store.getGitHubSnapshot() === null) return null;
    return { from, inflight: store.getInFlight(), pages: store.listCurrentRevisions() };
  } catch {
    return null;
  }
}

/** Pull requests merged between `from` and `to`, by their merge commits' subjects (pullRequestOf). */
export function mergedBetween(repo: string, from: string, to: string): Set<number> {
  const before = reachableCommits(repo, from);
  return new Set(
    readHistory(repo, to)
      .filter((commit) => !before.has(commit.sha))
      .flatMap((commit) => {
        const n = pullRequestOf(commit.subject);
        return n === null ? [] : [n];
      }),
  );
}

/**
 * Commits on `to`'s first-parent line after `from` that no pull request brought in: a direct
 * commit, or a merge whose subject names no pull request (R22: such a range is not comparable).
 */
export function outsidePulls(repo: string, from: string, to: string): number {
  const before = reachableCommits(repo, from);
  const bySha = new Map(readHistory(repo, to).map((commit) => [commit.sha, commit]));
  let outside = 0;
  for (let c = bySha.get(to); c !== undefined && !before.has(c.sha); ) {
    if (pullRequestOf(c.subject) === null) outside++;
    c = bySha.get(c.parents[0] ?? "");
  }
  return outside;
}

const key = (c: { featureId: string; claimId: string }) => `${c.featureId}/${c.claimId}`;

/**
 * R22's comparison for one update: the merged pull request's certain predicted stale claims,
 * from a snapshot derived against the update's starting head, against the claims the move from
 * `from` to `to` makes stale on the pages as they were (staleClaims). Only an update that merged
 * exactly one pull request, counting every merge in the range, snapshot or not, and holds no
 * commit outside a merged pull request (`outside`, outsidePulls), is comparable;
 * else "not comparable" with why, as for a pull request predicted against a wiki behind its base
 * (R27: its effects were file-level). "not compared" with why for a replay, a snapshot derived
 * elsewhere, or a merged pull request the snapshot does not hold or could not work out.
 */
export async function compareLine(
  repo: string,
  before: BeforeUpdate,
  to: string,
  merged: ReadonlySet<number>,
  replay: boolean,
  outside = 0,
): Promise<string> {
  if (replay) return "Predictions not compared: a replay moves through several merges.";
  const snapshot = before.inflight;
  if (snapshot === null || snapshot.wikiHead !== before.from)
    return "Predictions not compared: no snapshot was derived against this update's starting head.";
  if (merged.size === 0)
    return "Predictions not comparable: no pull request merged in this update.";
  if (merged.size > 1) {
    const list = [...merged]
      .sort((a, b) => a - b)
      .map((n) => `#${n}`)
      .join(", ");
    return `Predictions not comparable: ${merged.size} pull requests merged in this update (${list}), so each one's stale claims would count against the others.`;
  }
  const [number] = [...merged];
  if (outside > 0)
    return `Predictions not comparable: ${outside} ${outside === 1 ? "commit" : "commits"} in this update came in outside any merged pull request, so their stale claims would count against #${number}.`;
  const pull = snapshot.pulls.find((p) => p.number === number);
  if (pull === undefined) return `Predictions not compared: #${number} is not in the snapshot.`;
  if (pull.head !== "fetched")
    return `Predictions not compared: #${pull.number}'s impact was not computed.`;
  if (pull.behind)
    return `Predictions not comparable: #${pull.number} was predicted against a wiki behind its base.`;
  const predicted = new Set(pull.effects.filter((e) => e.certain).map(key));
  const actual = new Set((await staleClaims(repo, before.from, to, before.pages)).map(key));
  const both = [...predicted].filter((k) => actual.has(k)).length;
  return `Pull request #${pull.number} merged: ${predicted.size} claims predicted stale, ${actual.size} made stale, ${both} in both.`;
}

/** What the hook works on: the documented repository, its out dir, store and models. */
export interface HookContext {
  repo: string;
  out: string;
  repoName: string;
  store: Store;
  models: ModelConfig;
  log: (line: string) => void;
}

/**
 * The offline half of a refresh after wiki:update, or once at the end of wiki:replay (R4, C14):
 * the pull requests merged since `before` dropped, every other one re-derived against the new
 * head from the stored GitHub data and inflight.git, with no network and no call, and R22's
 * comparison. Returns the update summary's "Work in flight" section; empty when GitHub was never
 * read. Any failure is a warning line, never a failed update. The caller writes the export.
 */
export async function inflightAfterUpdate(
  ctx: HookContext,
  before: BeforeUpdate,
  to: string,
  replay: boolean,
): Promise<string[]> {
  try {
    if (ctx.store.getGitHubSnapshot() === null) return [];
    const merged = mergedBetween(ctx.repo, before.from, to);
    const outside = replay ? 0 : outsidePulls(ctx.repo, before.from, to);
    const compared = await compareLine(ctx.repo, before, to, merged, replay, outside);
    const args = parseInflightArgs([ctx.repo, "--offline"]);
    const result = await refreshOffline({ ...ctx, args, log: () => {} }, merged);
    if (result.kind !== "done") return [];
    const dropped = [...merged].filter((n) => before.inflight?.pulls.some((p) => p.number === n));
    return [
      "## Work in flight",
      "",
      `Re-derived ${result.inflight.pulls.length} open pull requests against ${to.slice(0, 7)} with no network and no call${dropped.length === 0 ? "" : `; dropped ${dropped.map((n) => `#${n}`).join(", ")} (merged)`}.`,
      "",
      compared,
      "",
    ];
  } catch (err) {
    const why = problemLine(err instanceof Error ? err.message : String(err));
    ctx.log(`warning: work in flight not re-derived: ${why}`);
    return ["## Work in flight", "", `Not re-derived: ${why}`, ""];
  }
}
