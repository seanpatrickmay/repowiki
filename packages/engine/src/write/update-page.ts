import { type Claim, type Manifest, Revision, type SectionKey } from "@repowiki/core";
import type { CommitInfo, RepoIndex } from "../index/index.ts";
import { linkViolations, seeAlsoFor } from "../link/index.ts";
import { diagramProblems } from "../verify/index.ts";
import { renderDiagram } from "./diagram.ts";
import { computeInfobox, createClaimLinker, pageSections, SECTION_ORDER } from "./page.ts";
import type { RewriteOutcome } from "./rewrite.ts";
import type { PageRewrite } from "./update-pack.ts";

/** Everything an update revision is made from once the page's answers are verified. */
export interface UpdateParts {
  rewrite: PageRewrite;
  outcome: RewriteOutcome;
  /** At the new commit. */
  index: RepoIndex;
  manifest: Manifest;
  /** Every commit reachable from the new commit, newest first. */
  history: readonly CommitInfo[];
  commitDate: string;
  generatedAt: string;
  /** The PR the new commit merged (spec §6.2), or null. */
  pr: number | null;
  reason: "update" | "manifest-change";
  neighbours: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Normalized Wikipedia title → canonical title, or null for plain text. */
  wikipedia: ReadonlyMap<string, string | null>;
}

export type AssembledUpdate =
  | { revision: Revision; diagramProblems: string[] }
  | { revision: null; why: string };

/** The page's claims by section, in page order. */
function bySection(claims: readonly { key: SectionKey; claim: Claim }[]): Map<SectionKey, Claim[]> {
  return new Map(
    SECTION_ORDER.map((key) => [key, claims.filter((c) => c.key === key).map((c) => c.claim)]),
  );
}

/**
 * The update revision of one page (spec §6.1 steps 5-6), or why there is none. Every claim the
 * update did not rewrite stays word for word (a fresh one with its citations moved to the new
 * commit); a stale claim is replaced by its verified rewrite, or kept as stored and marked
 * `staleSince` the new commit (§6.3: never dropped); new claims go at the end of their section.
 * Sections are ordered and renumbered as on a build, and every claim goes through the page linker
 * against the new manifest, so a link to a feature that was merged follows it. If that leaves no
 * lead or no body, the page keeps its old claims, the stale ones marked. The diagram is drawn
 * again from the answer when the feature's files changed, else kept. A page whose answers
 * changed nothing gets no revision ("nothing changed"): it carries forward.
 */
export function assembleUpdate(parts: UpdateParts): AssembledUpdate {
  const { rewrite, outcome, index, manifest } = parts;
  const sha = index.sha;
  const kept = new Set(outcome.keptStale);
  const marked = (claim: Claim): Claim => ({ ...claim, staleSince: claim.staleSince ?? sha });
  const rewritten = rewrite.claims.map(({ key, claim, status }) => {
    if (status !== "stale") return { key, claim };
    const replacement = outcome.replaced.get(claim.id);
    return {
      key,
      claim: replacement !== undefined && !kept.has(claim.id) ? replacement : marked(claim),
    };
  });
  const newlyMarked = rewrite.claims.some(
    (c) => c.status === "stale" && c.claim.staleSince === null && kept.has(c.claim.id),
  );
  const fallback = rewrite.claims.map(({ key, claim, status }) => ({
    key,
    claim: status === "stale" ? marked(claim) : claim,
  }));

  const link = createClaimLinker(manifest, rewrite.featureId, parts.wikipedia);
  const assemble = (claims: readonly { key: SectionKey; claim: Claim }[]) => {
    const ordered = pageSections(bySection(claims));
    if (ordered === null) return null;
    let blank = false;
    const linked = ordered.map((s) => ({
      key: s.key,
      claims: s.claims.flatMap((c) => {
        const out = link(c);
        if (out.text.trim() !== "") return [out];
        blank = true;
        return [];
      }),
    }));
    return blank ? pageSections(new Map(linked.map((s) => [s.key, s.claims]))) : linked;
  };
  const sections = assemble([...rewritten, ...outcome.added]) ?? assemble(fallback);
  if (sections === null) return { revision: null, why: "no lead or no body claim is left" };

  let diagram = rewrite.revision.diagram;
  let refused: string[] = [];
  if (outcome.diagram !== null && outcome.pack.candidates !== null) {
    diagram = renderDiagram(outcome.diagram, outcome.pack.candidates);
    refused = diagram === null ? [] : diagramProblems(diagram);
    if (refused.length > 0) diagram = null;
  }
  const changed =
    outcome.replaced.size > 0 ||
    outcome.added.length > 0 ||
    newlyMarked ||
    diagram !== rewrite.revision.diagram;
  if (!changed) return { revision: null, why: "nothing changed" };

  const parsed = Revision.safeParse({
    id: `${rewrite.featureId}-${sha.slice(0, 12)}`,
    featureId: rewrite.featureId,
    sha,
    commitDate: parts.commitDate,
    generatedAt: parts.generatedAt,
    parentId: rewrite.revision.id,
    reason: parts.reason,
    pr: parts.pr,
    model: outcome.model ?? rewrite.revision.model,
    tokens: outcome.tokens,
    infobox: computeInfobox(rewrite.featureId, manifest, index, parts.history, parts.commitDate),
    diagram,
    seeAlso: seeAlsoFor(rewrite.featureId, parts.neighbours, manifest),
    sections,
  });
  if (!parsed.success) {
    return {
      revision: null,
      why: `the revision does not match the schema at ${parsed.error.issues[0]?.path.join(".")}`,
    };
  }
  // The linker makes this unreachable; it stays as the last word on spec §8.
  const violations = linkViolations(parsed.data, manifest);
  if (violations.length > 0)
    return { revision: null, why: `links to nowhere: ${violations.join("; ")}` };
  return { revision: parsed.data, diagramProblems: refused };
}
