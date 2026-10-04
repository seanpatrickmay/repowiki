import { type Claim, type CodeCitation, contentHash } from "@repowiki/core";
import type { FileChange } from "../index/index.ts";
import { citedLines, sourceLines, symbolAt } from "../verify/index.ts";
import { remapRange } from "./remap.ts";

/** What citations are moved against: the commit the wiki moves to and its files. */
export interface RemapContext {
  /** The sha the wiki moves to. */
  sha: string;
  /** diffCommits(repo, from, sha); called once per distinct citation sha. */
  changesSince(from: string): readonly FileChange[];
  /** Text of every readable file at `sha`. */
  sources: ReadonlyMap<string, string>;
  /** Indexed symbols of a file at `sha`, to name the symbol a moved range sits in. */
  symbolsOf(path: string): readonly { qualifiedName: string; startLine: number; endLine: number }[];
}

/**
 * A code citation after the move: `fresh` at the new sha (its lines may have moved, its path may
 * have changed with a rename), or `stale` with why, and the file's path at the new sha (null when
 * it was deleted).
 */
export type CitationFate = { fresh: CodeCitation } | { stale: string; path: string | null };

/**
 * Moves one code citation from its own sha to ctx.sha (spec §6.1 step 2): through the file's
 * rename and its hunks, then the cited lines are hashed again, and only a matching hash keeps it
 * fresh. A deleted, binary or unreadable file, or a changed range, makes it stale.
 */
export function remapCitation(citation: CodeCitation, ctx: RemapContext): CitationFate {
  const change = ctx.changesSince(citation.sha).find((c) => c.oldPath === citation.path);
  if (change?.status === "deleted") return { stale: "its file was deleted", path: null };
  const path = change?.newPath ?? citation.path;
  if (change?.binary) return { stale: "its file is now binary", path };
  const range =
    change === undefined
      ? { start: citation.startLine, end: citation.endLine }
      : remapRange({ start: citation.startLine, end: citation.endLine }, change.hunks);
  if (range === null) return { stale: "the cited lines changed", path };
  const text = ctx.sources.get(path);
  if (text === undefined || range.end > sourceLines(text).length) {
    return { stale: "its file cannot be read at this commit", path };
  }
  if (contentHash(citedLines(text, range.start, range.end)) !== citation.contentHash) {
    return { stale: "the cited lines changed", path };
  }
  return {
    fresh: {
      ...citation,
      path,
      startLine: range.start,
      endLine: range.end,
      sha: ctx.sha,
      symbol: symbolAt(ctx.symbolsOf(path), range.start, range.end),
    },
  };
}

/** A stored claim after the move, in its section. */
export interface RemappedClaim<K extends string = string, C extends Claim = Claim> {
  key: K;
  /** A fresh claim with its code citations at the new sha; any other claim exactly as stored. */
  claim: C;
  /**
   * `fresh`: every code citation still holds (a lead: nothing it supports went stale). `stale`:
   * a citation changed (a lead: it supports a stale claim), so the update rewrites it. `stale-kept`:
   * stale since an earlier update, and nothing it cites changed now, so it is left as it is.
   */
  status: "fresh" | "stale" | "stale-kept";
  /** Why it is stale: one line per changed citation, naming where it pointed. */
  reasons: string[];
}

/**
 * Every claim of a page (or of the project's article) after the move, in page order. A claim
 * marked stale by an earlier update is tried again only when a file it cites is among `touched`
 * (the paths, old or new, that changed in this update); otherwise it is `stale-kept`, so a claim
 * whose code is gone does not cost a call on every update. A lead claim is stale when it supports
 * a stale claim (spec §5 rule 2).
 */
export function remapClaims<K extends string, C extends Claim>(
  sections: readonly { key: K; claims: readonly C[] }[],
  ctx: RemapContext,
  touched: ReadonlySet<string>,
): RemappedClaim<K, C>[] {
  const body = new Map<string, RemappedClaim<K, C>>();
  const out: RemappedClaim<K, C>[] = [];
  for (const section of sections) {
    for (const claim of section.claims) {
      if (section.key === "lead") continue;
      const reasons: string[] = [];
      let wasTouched = false;
      const citations = claim.citations.map((citation) => {
        if (citation.kind !== "code") return citation;
        const fate = remapCitation(citation, ctx);
        const now = "fresh" in fate ? fate.fresh.path : fate.path;
        if (touched.has(citation.path) || (now !== null && touched.has(now))) wasTouched = true;
        if ("fresh" in fate) return fate.fresh;
        reasons.push(
          `${citation.path}:${citation.startLine}-${citation.endLine} at ${citation.sha.slice(0, 7)}: ${fate.stale}`,
        );
        return citation;
      });
      let remapped: RemappedClaim<K, C>;
      if (claim.staleSince !== null && !wasTouched) {
        remapped = { key: section.key, claim, status: "stale-kept", reasons };
      } else if (reasons.length > 0) {
        remapped = { key: section.key, claim, status: "stale", reasons };
      } else {
        remapped = {
          key: section.key,
          claim: { ...claim, citations, staleSince: null },
          status: "fresh",
          reasons,
        };
      }
      body.set(claim.id, remapped);
    }
  }
  for (const section of sections) {
    for (const claim of section.claims) {
      if (section.key !== "lead") {
        out.push(body.get(claim.id) as RemappedClaim<K, C>);
        continue;
      }
      const stale = claim.supports.filter((id) => body.get(id)?.status === "stale");
      out.push({
        key: section.key,
        claim,
        status: stale.length > 0 ? "stale" : claim.staleSince !== null ? "stale-kept" : "fresh",
        reasons: stale.length > 0 ? [`it summarizes ${stale.join(", ")}, which changed`] : [],
      });
    }
  }
  return out;
}
