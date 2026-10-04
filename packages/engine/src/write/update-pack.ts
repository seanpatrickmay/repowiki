import type { Claim, Manifest, Revision, SectionKey } from "@repowiki/core";
import type { CommitInfo, FileChange, RepoIndex } from "../index/index.ts";
import { estimateTokens } from "../manifest/index.ts";
import { sourceLines } from "../verify/index.ts";
import { type DiagramCandidates, diagramCandidates, renderCandidates } from "./diagram.ts";
import {
  CHARS_PER_TOKEN,
  clean,
  clip,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  FULL_SOURCE_SHARE,
  numbered,
  signatureLines,
} from "./pack.ts";
import { featureFiles } from "./prompt.ts";

/** A claim of the current page after the move to the new commit (freshness's remapClaims). */
export interface PlannedClaim {
  key: SectionKey;
  /** Fresh: its citations at the new commit. Otherwise as stored. */
  claim: Claim;
  /** fresh: kept as it is; stale: rewritten by the update; stale-kept: left marked out of date. */
  status: "fresh" | "stale" | "stale-kept";
  /** Why a stale claim is stale. */
  reasons: string[];
}

/** What an update does to one page (spec §6.1 step 5): freshness plans it, write carries it out. */
export interface PageRewrite {
  featureId: string;
  /** The page's current revision. */
  revision: Revision;
  /** Its claims after the move, in page order. */
  claims: readonly PlannedClaim[];
  /** Code no claim describes (coverage gaps). */
  gaps: readonly { path: string; symbol: string; startLine: number; endLine: number }[];
  /** The feature's files this update changed (diffCommits entries). */
  changed: readonly FileChange[];
  /** This update's commits that touched the feature's files, newest first. */
  commits: readonly CommitInfo[];
  /** True when the feature gained or lost a file: its diagram is drawn again. */
  membershipChanged: boolean;
}

/** One update call's user turn, and what the answer is checked against. */
export interface UpdatePack {
  featureId: string;
  text: string;
  /** Estimated tokens of `text`. */
  tokens: number;
  /** Ids of the claims the call rewrites: the stale body claims and stale leads. */
  targets: string[];
  /** The sections a new claim may go in. */
  open: SectionKey[];
  /** The diagram's candidates when it is drawn again, else null. */
  candidates: DiagramCandidates | null;
}

const SECTION_TITLES: Record<SectionKey, string> = {
  lead: "Lead",
  overview: "Overview",
  "how-it-works": "How it works",
  "data-flow": "Data flow",
  history: "History",
  "known-limitations": "Known limitations",
};
const MAX_COMMITS = 40;
const MAX_GAPS = 20;
const MAX_LISTED_FILES = 40;
const MAX_SUBJECT_LENGTH = 120;

/** The first `max` lines, then "- and N more". */
const capped = (lines: readonly string[], max: number): string[] =>
  lines.length <= max ? [...lines] : [...lines.slice(0, max), `- and ${lines.length - max} more`];

/** A claim's line in the pack's copy of the page: id, mark, text and where it points. */
function claimLine(planned: PlannedClaim): string {
  const { claim } = planned;
  const where =
    planned.key === "lead"
      ? claim.supports.length > 0
        ? ` (summarizes ${claim.supports.map(clean).join(", ")})`
        : ""
      : ` (cites ${claim.citations
          .map((c) =>
            c.kind === "code"
              ? `${clean(c.path)}:${c.startLine}-${c.endLine}`
              : `commit:${c.sha.slice(0, 7)}`,
          )
          .join(", ")})`;
  const mark =
    planned.status === "stale"
      ? `STALE (${planned.reasons.map(clean).join("; ")}): `
      : planned.status === "stale-kept"
        ? "(marked out of date earlier) "
        : "";
  return `- [${clean(claim.id)}] ${mark}${clean(claim.text)}${where}`;
}

/**
 * Builds one update call's pack (spec §6.1 step 5): the page as it stands with its stale claims
 * marked, the update's commits and changed files, what to write (the stale ids; the gaps, which
 * open how-it-works to new claims; the commits, which open history), and the source at the new
 * commit of the feature's changed files and gap files, heaviest first, within `budgetTokens`
 * as a page's pack fills it (full source under 70%, then signatures, then listed). The diagram's
 * candidates come last when the feature's files changed.
 */
export function buildUpdatePack(input: {
  rewrite: PageRewrite;
  manifest: Manifest;
  index: RepoIndex;
  sources: ReadonlyMap<string, string>;
  budgetTokens?: number;
}): UpdatePack {
  const { rewrite, manifest, index, sources } = input;
  const feature = manifest.features.find((f) => f.id === rewrite.featureId);
  if (feature === undefined) throw new Error(`${rewrite.featureId} is not in the manifest`);
  const targets = rewrite.claims.filter((c) => c.status === "stale").map((c) => c.claim.id);
  const open: SectionKey[] = [
    ...(rewrite.gaps.length > 0 ? ["how-it-works" as const] : []),
    ...(rewrite.commits.length > 0 ? ["history" as const] : []),
  ];
  const files = featureFiles(manifest, rewrite.featureId);
  const candidates = rewrite.membershipChanged
    ? diagramCandidates(rewrite.featureId, manifest, index, files)
    : null;

  const page: string[] = [];
  for (const key of Object.keys(SECTION_TITLES) as SectionKey[]) {
    const claims = rewrite.claims.filter((c) => c.key === key);
    if (claims.length > 0) page.push(`### ${SECTION_TITLES[key]}`, ...claims.map(claimLine));
  }
  const commits = rewrite.commits.slice(0, MAX_COMMITS).map((c) => {
    const pr = c.pr === null ? "" : ` (PR #${c.pr})`;
    return `- commit:${c.sha.slice(0, 7)} ${clean(c.date.slice(0, 10))} ${clip(clean(c.subject), MAX_SUBJECT_LENGTH)}${pr}`;
  });
  const changed = rewrite.changed.map((c) =>
    c.status === "renamed"
      ? `- ${clean(c.oldPath ?? "")} -> ${clean(c.newPath ?? "")} (renamed)`
      : `- ${clean(c.newPath ?? c.oldPath ?? "")} (${c.status})`,
  );
  const todo: string[] = [];
  if (targets.length > 0) {
    todo.push(
      `- Rewrite each claim marked STALE, under its id and in its section: ${targets.map(clean).join(", ")}.`,
    );
  }
  if (rewrite.gaps.length > 0) {
    const gaps = rewrite.gaps
      .slice(0, MAX_GAPS)
      .map((g) => `${clean(g.path)}:${g.startLine}-${g.endLine} (${clean(g.symbol)})`);
    const more =
      rewrite.gaps.length > MAX_GAPS ? `, and ${rewrite.gaps.length - MAX_GAPS} more` : "";
    todo.push(
      `- New code no claim describes: ${gaps.join(", ")}${more}. Add how-it-works claims for what a reader needs, under new ids, or none.`,
    );
  }
  if (rewrite.commits.length > 0) {
    todo.push(
      "- Add history claims for the commits above that changed what the feature does, each citing one of them, under new ids, or none.",
    );
  }
  if (candidates !== null)
    todo.push("- The feature's files changed: pick its diagram from the candidates below.");

  const head = [
    `# Page: ${clean(feature.title)} (${clean(feature.id)})`,
    `Aliases: ${feature.aliases.map(clean).join(", ") || "(none)"}`,
    `## Current page\n${page.join("\n")}`,
    `## Commits since the last revision (newest first)\n${commits.join("\n") || "(none)"}`,
    `## Files of this feature that changed\n${capped(changed, MAX_LISTED_FILES).join("\n") || "(none)"}`,
    `## What to write\n${todo.join("\n") || "- Nothing is stale: return no claims."}`,
  ].join("\n\n");
  const tail = [
    ...(candidates === null
      ? []
      : [`## Diagram candidates\n${renderCandidates(candidates, clean)}`]),
    "Write the update.",
  ].join("\n\n");

  // The feature's changed files and gap files at the new commit, heaviest first.
  const wanted = new Set([
    ...rewrite.changed.flatMap((c) => (c.newPath === null ? [] : [c.newPath])),
    ...rewrite.gaps.map((g) => g.path),
  ]);
  const order = [
    ...files.filter((f) => wanted.has(f)),
    ...[...wanted].filter((f) => !files.includes(f)).sort(),
  ];
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const budgetChars = (input.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS) * CHARS_PER_TOKEN;
  const sourceHeading = `## Source at ${index.sha.slice(0, 7)}`;
  let used = head.length + tail.length + sourceHeading.length + 6;
  const blocks: string[] = [];
  const listed: string[] = [];
  for (const path of order) {
    const text = sources.get(path);
    const file = byPath.get(path);
    if (text === undefined || file === undefined || file.skipped !== null) {
      listed.push(path);
      continue;
    }
    const lines = sourceLines(text);
    const width = String(lines.length).length;
    const full = `### ${clean(path)} (${lines.length} lines)\n${numbered(
      lines,
      lines.map((_, i) => i + 1),
      width,
    )}`;
    if (used + 2 + full.length <= budgetChars * FULL_SOURCE_SHARE) {
      blocks.push(full);
      used += full.length + 2;
      continue;
    }
    const numbers = [
      ...new Set(file.symbols.flatMap((s) => signatureLines(lines, s, file.language))),
    ].sort((a, b) => a - b);
    const signatures = `### ${clean(path)} (${lines.length} lines; signatures only)\n${numbered(lines, numbers, width)}`;
    if (numbers.length > 0 && used + 2 + signatures.length <= budgetChars) {
      blocks.push(signatures);
      used += signatures.length + 2;
      continue;
    }
    listed.push(path);
  }
  const others =
    listed.length === 0
      ? []
      : [
          `## Other changed files (not shown)\n${capped(
            listed.map((p) => `- ${clean(p)}`),
            MAX_LISTED_FILES,
          ).join("\n")}`,
        ];
  const text = [head, sourceHeading, ...blocks, ...others, tail].join("\n\n");
  return {
    featureId: rewrite.featureId,
    text,
    tokens: estimateTokens(text),
    targets,
    open,
    candidates,
  };
}
