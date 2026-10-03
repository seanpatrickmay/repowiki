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

/** A path and a line or range, as the pack prints an edge's site or numbers a file's lines. */
const PATH_LINE = /^[^\s:]+:\d+(?:-\d+)?$/;
/** A `feature-id:` prefix, and what follows it. */
const ID_PREFIX = /^([a-z0-9]+(?:-[a-z0-9]+)*):\s*(.*)$/;
/** The example an edge-shaped citation gets when nothing in it reads as a path and a line. */
const GENERIC_EXAMPLE = "src/app.py:12";

/**
 * The problem for a citation copied from an edge rather than a line: one that holds " -> ", or
 * starts with a feature id of this build and a colon (unless that id is also a top-level file).
 * Its example is what follows the edge's feature ids, when that reads as a path and a line.
 * Null for any other citation.
 */
function edgeCitationProblem(cite: string, ctx: ArchitectureContext): string | null {
  const arrow = cite.lastIndexOf(" -> ");
  let rest = arrow < 0 ? cite.trim() : cite.slice(arrow + " -> ".length).trim();
  let stripped = false;
  for (;;) {
    const prefix = ID_PREFIX.exec(rest);
    const id = prefix?.[1];
    if (prefix === null || id === undefined || ctx.sources.has(id)) break;
    // After an arrow the edge's target is a feature id even when it has no page here.
    if (!ctx.pages.has(id) && (arrow < 0 || stripped)) break;
    rest = (prefix[2] ?? "").trim();
    stripped = true;
  }
  if (arrow < 0 && !stripped) return null;
  const example = PATH_LINE.test(rest) ? rest : GENERIC_EXAMPLE;
  return `citation ${quote(cite)} names an edge, not a line; cite only the path and line, e.g. ${quote(example)}`;
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
  // A citation copied from an edge is named as such, never resolved as a path.
  const edgeProblems = new Map(cite.map((c) => [c, edgeCitationProblem(c, ctx)]));
  const lines = cite.filter((c) => edgeProblems.get(c) === null);
  const resolved = resolveCitations(lines, ctx);
  const { citations } = resolved;
  const unresolved = resolved.unresolved || lines.length < cite.length;
  for (const c of cite) {
    const problem = edgeProblems.get(c);
    if (problem !== null && problem !== undefined) problems.push(problem);
  }
  problems.push(...resolved.problems);
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
