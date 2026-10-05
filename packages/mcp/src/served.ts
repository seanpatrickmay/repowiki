import type { WikiExport } from "@repowiki/core";
import { GitError, GitTimeoutError, isAncestor as gitIsAncestor } from "@repowiki/engine";
import { type AsOf, pageSearchIndex, type SearchIndex, viewAt, WikiView } from "@repowiki/query";
import { commitOf, GIT_TIMEOUT_MS } from "./git.ts";
import { createFreshness, type Freshness } from "./head-status.ts";

/** The most as-of views (each with its search index) one served wiki keeps (spec v2 #5 §4.2). */
export const MAX_AS_OF_VIEWS = 8;

/**
 * One loaded export as the six tools serve it: its view and search index, its freshness against
 * the compare commit, and its views at past points, all cached until the export is reloaded.
 */
export interface ServedWiki {
  wiki: WikiExport;
  view: WikiView;
  index: SearchIndex;
  freshness: Freshness;
  /** The documented repository's top level. */
  repo: string;
  /** Whether the compare commit was pinned with --compare-to. */
  pinned: boolean;
  /** One line when the last reload failed and this is the last good export; else null. */
  reloadProblem: string | null;
  /** The wiki as of a point, and its search index (at most MAX_AS_OF_VIEWS kept). */
  at(asOf: AsOf): { view: WikiView; index: SearchIndex };
  /**
   * isAncestor in the repository within GIT_TIMEOUT_MS, memoised: only git's answers are kept. A
   * commit it lacks is no one's ancestor (not kept); a timeout is thrown (a GitTimeoutError).
   */
  isAncestor(ancestor: string, descendant: string): boolean;
  /** The full sha of the one commit a hex prefix names, or null. */
  resolveCommit(prefix: string): string | null;
  /** The commit date (YYYY-MM-DD) the export records for the wiki's head, or null. */
  headDate: string | null;
}

export interface ServeOptions {
  repo: string;
  /** --compare-to's commit, resolved once at start; null follows the repository's HEAD. */
  pinned: string | null;
  reloadProblem?: string | null;
}

const keyOf = (asOf: AsOf) => (asOf.kind === "date" ? `d:${asOf.date}` : `c:${asOf.sha}`);

/** A loaded export, ready to serve: views, indexes and freshness are built as they are needed. */
export function serveWiki(wiki: WikiExport, options: ServeOptions): ServedWiki {
  const view = new WikiView(wiki);
  const ancestry = new Map<string, boolean>();
  const isAncestor = (a: string, b: string) => {
    const key = `${a}\0${b}`;
    const found = ancestry.get(key);
    if (found !== undefined) return found;
    let answer: boolean;
    try {
      answer = a === b || gitIsAncestor(options.repo, a, b, { timeoutMs: GIT_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof GitTimeoutError || !(error instanceof GitError)) throw error;
      return false;
    }
    ancestry.set(key, answer);
    return answer;
  };
  const views = new Map<string, { view: WikiView; index: SearchIndex }>();
  let index: SearchIndex | undefined;
  let freshness: Freshness | undefined;
  const revisions: readonly { sha: string; commitDate: string }[] = [
    ...Object.values(wiki.history).flat(),
    ...wiki.architecture,
  ];
  const atHead = revisions.find((r) => r.sha === wiki.head);
  return {
    wiki,
    view,
    repo: options.repo,
    pinned: options.pinned !== null,
    reloadProblem: options.reloadProblem ?? null,
    headDate: atHead?.commitDate.slice(0, 10) ?? null,
    get index() {
      index ??= pageSearchIndex(view);
      return index;
    },
    get freshness() {
      freshness ??= createFreshness({
        repo: options.repo,
        wikiHead: wiki.head,
        pinned: options.pinned,
      });
      return freshness;
    },
    at(asOf) {
      const key = keyOf(asOf);
      let found = views.get(key);
      if (found === undefined) {
        const then = viewAt(wiki, asOf, isAncestor);
        found = { view: then, index: pageSearchIndex(then) };
      } else {
        views.delete(key);
      }
      views.set(key, found);
      if (views.size > MAX_AS_OF_VIEWS) views.delete(views.keys().next().value as string);
      return found;
    },
    isAncestor,
    resolveCommit: (prefix) => commitOf(options.repo, prefix),
  };
}
