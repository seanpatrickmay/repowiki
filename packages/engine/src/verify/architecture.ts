import {
  type ArchitectureClaim,
  ArchitectureSectionKey,
  architectureClaimViolations,
  FeatureId,
  MAX_CLAIM_PAGES,
} from "@repowiki/core";
import { z } from "zod";
import { claimTextProblems, quote, resolveCitations, type VerifyContext } from "./claims.ts";

/**
 * A claim of the Architecture article as the model returns it: `cite` as on a feature page, and
 * `pages`, the feature ids whose leads back it. Kind, hook and final ids come from the engine.
 */
export const ArchitectureDraftClaim = z.object({
  id: z.string(),
  text: z.string(),
  cite: z.array(z.string()),
  pages: z.array(z.string()),
  supports: z.array(z.string()),
});
export type ArchitectureDraftClaim = z.infer<typeof ArchitectureDraftClaim>;

export const ArchitectureDraftSection = z.object({
  key: ArchitectureSectionKey,
  claims: z.array(ArchitectureDraftClaim),
});
export type ArchitectureDraftSection = z.infer<typeof ArchitectureDraftSection>;

/** What the Architecture call returns. The diagram is the engine's, so the draft has none. */
export const ArchitectureDraft = z.object({ sections: z.array(ArchitectureDraftSection) });
export type ArchitectureDraft = z.infer<typeof ArchitectureDraft>;

/** The retry call's answer: corrected versions of the claims that failed, under their old ids. */
export const ArchitectureFixes = z.object({ claims: z.array(ArchitectureDraftClaim) });
export type ArchitectureFixes = z.infer<typeof ArchitectureFixes>;

/**
 * What an Architecture claim is checked against: the build's files and commits, its pages, and
 * the lines its pack showed.
 */
export interface ArchitectureContext extends VerifyContext {
  /** Ids of the active features with a page in this build: the only pages a claim may name. */
  pages: ReadonlySet<string>;
  /** Path to the lines the pack showed (ArchitecturePack.shown): the only lines a claim may cite. */
  shown: ReadonlyMap<string, ReadonlySet<number>>;
}

export type VerifiedArchitectureClaim =
  | { claim: ArchitectureClaim; problems: [] }
  | { claim: null; problems: string[] };

/**
 * Checks one draft claim of the Architecture article: its text as a feature page's claim text is
 * checked, every reference resolves at ctx.sha, every code citation's lines are lines the pack
 * showed (the article's writer saw nothing else of the code), every page it names is a feature id and a page of
 * this build (at most MAX_CLAIM_PAGES, each once), and the article's rules hold (core's
 * architectureClaimViolations): a body claim cites code or a commit or names a page, and a
 * request-path claim cites code or a commit, judged on the pages that are known. A lead claim's
 * citations and pages are stripped: its backing is its supports. Page ids are
 * model-written: they are trimmed, and a refused one appears only quote()d, in at most
 * MAX_CLAIM_PAGES problems.
 */
export function verifyArchitectureClaim(
  key: ArchitectureSectionKey,
  draft: ArchitectureDraftClaim,
  ctx: ArchitectureContext,
): VerifiedArchitectureClaim {
  const problems: string[] = [];
  const text = draft.text.trim();
  if (draft.id === "") problems.push("the claim has no id");
  problems.push(...claimTextProblems(text, ctx));
  // A lead claim rests on its supports alone: citations or pages it carries are dropped, not
  // refused, so the claim is kept when its supports hold.
  const cite = key === "lead" ? [] : draft.cite;
  const named = key === "lead" ? [] : draft.pages;
  const { citations, problems: unresolvable, unresolved } = resolveCitations(cite, ctx);
  problems.push(...unresolvable);
  for (const citation of citations) {
    if (citation.kind !== "code") continue;
    const { path, startLine, endLine } = citation;
    const lines = ctx.shown.get(path);
    for (let line = startLine; line <= endLine; line++) {
      if (lines?.has(line)) continue;
      problems.push(
        `the claim cites ${quote(path)} lines ${startLine}-${endLine}, which the pack did not show; cite only lines the pack numbers or gives for an edge, or name the feature page instead`,
      );
      break;
    }
  }
  const pages = [...new Set(named.map((id) => id.trim()))];
  const unknown = pages.filter((id) => !FeatureId.safeParse(id).success || !ctx.pages.has(id));
  const known = pages.filter((id) => !unknown.includes(id));
  for (const id of unknown.slice(0, MAX_CLAIM_PAGES)) {
    problems.push(`the claim names ${quote(id)}, which is not a feature page of this wiki`);
  }
  if (pages.length > MAX_CLAIM_PAGES) {
    problems.push(`the claim names more than ${MAX_CLAIM_PAGES} pages; name the closest ones`);
  }
  const claim: ArchitectureClaim = {
    id: draft.id,
    text: text === "" ? "-" : text,
    kind: "fact",
    citations,
    supports: key === "lead" ? draft.supports : [],
    pages: known.slice(0, MAX_CLAIM_PAGES),
    staleSince: null,
    hook: false,
  };
  if (key !== "lead" && draft.supports.length > 0) {
    problems.push("only lead claims may support other claims");
  }
  // The rules need every reference resolved, but not every page: they are judged on the known
  // pages, so the retry round hears about a missing citation or support alongside a bad page.
  if (!unresolved) problems.push(...architectureClaimViolations(key, claim));
  return problems.length === 0 ? { claim, problems: [] } : { claim: null, problems };
}
