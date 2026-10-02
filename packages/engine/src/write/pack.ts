import type { Manifest } from "@repowiki/core";
import type { CommitInfo, IndexedSymbol, RepoIndex } from "../index/index.ts";
import { estimateTokens } from "../manifest/index.ts";
import { REVERT_SUBJECT, SKIPPED_TEST, sourceLines, TODO_MARKER } from "../verify/index.ts";
import { type DiagramCandidates, diagramCandidates, renderCandidates } from "./diagram.ts";
import { featureFiles } from "./prompt.ts";

export interface PackInput {
  featureId: string;
  manifest: Manifest;
  index: RepoIndex;
  /** Text of every readable file at the index's sha. */
  sources: ReadonlyMap<string, string>;
  /** Every commit reachable from the sha, newest first. */
  history: readonly CommitInfo[];
  /** This feature's neighbours and their combined edge weights. */
  neighbours: ReadonlyMap<string, number>;
  /** Token budget for the pack (spec §7.2: contextBudgetTokens). */
  budgetTokens: number;
}

/** One write call's context (spec §7.2): the user message, plus what verify and diagrams need. */
export interface ContextPack {
  featureId: string;
  text: string;
  /** Estimated tokens of `text`. */
  tokens: number;
  /** How each member file is shown: in full, as signatures, or only listed. */
  shown: { path: string; mode: "full" | "signatures" | "listed" }[];
  /** All of the feature's commits, newest first; the pack lists the newest 40 of them. */
  commits: CommitInfo[];
  candidates: DiagramCandidates;
}

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 30_000;
/** Full source is included until this share of the budget is used (spec §7.2). */
export const FULL_SOURCE_SHARE = 0.7;
const MAX_COMMITS = 40;
const MAX_EVIDENCE = 30;
const MAX_NEIGHBOURS = 8;
const MAX_LINE_LENGTH = 300;
const MAX_SUBJECT_LENGTH = 120;
const MAX_EVIDENCE_LENGTH = 160;

/**
 * Characters that can forge or hide structure in a prompt, other than tab: control characters
 * (C0, DEL, C1, so newline too), line and paragraph separators, and every format character
 * (bidi embeddings, overrides and isolates U+202A-E and U+2066-9, the byte order mark, zero-width
 * spaces) except ZWJ and ZWNJ, which emoji sequences and several scripts need.
 */
const UNSAFE = /(?![\t‌‍])[\p{Cc}\p{Zl}\p{Zp}\p{Cf}‪-‮⁦-⁩]/gu;

/** A repository- or model-derived string, safe to put in the prompt: unsafe characters become U+FFFD. */
const clean = (text: string): string => text.replace(UNSAFE, "�");

/** The first `max` UTF-16 units of `text`, without half of a surrogate pair at the end. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Source lines prefixed with their numbers; over-long lines are cut, unsafe characters kept out,
 * and the "\r" of a CRLF line dropped. `lines` is verify's `sourceLines`, so a number is the line
 * a citation of it resolves.
 */
function numbered(lines: readonly string[], numbers: readonly number[], width: number): string {
  return numbers
    .map((n) => {
      const raw = (lines[n - 1] ?? "").replace(/\r$/, "");
      const line = raw.length > MAX_LINE_LENGTH ? `${clip(raw, MAX_LINE_LENGTH)}…` : raw;
      return `${String(n).padStart(width)}| ${clean(line)}`;
    })
    .join("\n");
}

/**
 * The lines that show a symbol's signature: from its first line (decorators included) up to the
 * line that opens its body, at most 4, then a Python docstring's lines (at most 6) or the JSDoc
 * block right above it (at most 12).
 */
export function signatureLines(lines: readonly string[], symbol: IndexedSymbol): number[] {
  const out: number[] = [];
  const at = (n: number) => (lines[n - 1] ?? "").trimEnd();
  let end = symbol.startLine;
  for (let n = symbol.startLine; n <= Math.min(symbol.endLine, symbol.startLine + 3); n++) {
    end = n;
    const text = at(n).replace(/#.*$/, "");
    if (/[:{]\s*$/.test(text) || /=>\s*\{?\s*$/.test(text) || text.endsWith(";")) break;
  }
  if (
    at(symbol.startLine - 1)
      .trim()
      .endsWith("*/")
  ) {
    let start = symbol.startLine - 1;
    while (start > 1 && start > symbol.startLine - 12 && !at(start).trim().startsWith("/**"))
      start--;
    if (at(start).trim().startsWith("/**"))
      for (let n = start; n < symbol.startLine; n++) out.push(n);
  }
  for (let n = symbol.startLine; n <= end; n++) out.push(n);
  const doc = at(end + 1).trim();
  if (end + 1 <= symbol.endLine && /^[rbuRBU]?("""|''')/.test(doc)) {
    const quote = /("""|''')/.exec(doc)?.[1] ?? '"""';
    const oneLine = doc.indexOf(quote) !== doc.lastIndexOf(quote);
    for (let n = end + 1; n <= Math.min(symbol.endLine, end + 6); n++) {
      out.push(n);
      if (oneLine || (n > end + 1 && at(n).includes(quote))) break;
    }
  }
  return out;
}

/** The feature's commits: every commit that touched one of its member files, newest first. */
function featureCommits(files: readonly string[], history: readonly CommitInfo[]): CommitInfo[] {
  const mine = new Set(files);
  return history.filter((c) => c.files.some((path) => mine.has(path)));
}

/**
 * Builds the context pack for one feature page (spec §7.2). Member files go in by membership
 * weight: in full while the pack is under 70% of its budget, then as signatures and docstrings
 * while it is under the budget, then by path only. The pack also lists the feature's commits,
 * the TODO/FIXME lines, skipped tests and reverting commits that can back a known limitation,
 * the neighbouring features, and the diagram candidates.
 */
export function buildPack(input: PackInput): ContextPack {
  const { featureId, manifest, index, sources } = input;
  const feature = manifest.features.find((f) => f.id === featureId);
  if (feature === undefined) throw new Error(`${featureId} is not in the manifest`);
  const files = featureFiles(manifest, featureId);
  const indexed = new Map(index.files.map((f) => [f.path, f]));
  const commits = featureCommits(files, input.history);
  const candidates = diagramCandidates(featureId, manifest, index, files);

  const titleOf = new Map(manifest.features.map((f) => [f.id, f.title]));
  const neighbours = [...input.neighbours]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, MAX_NEIGHBOURS)
    .map(
      ([id, weight]) =>
        `${clean(id)} (${clean(titleOf.get(id) ?? id)}, ${Math.round(weight * 100) / 100})`,
    );

  const evidence: string[] = [];
  for (const path of files) {
    for (const [i, line] of sourceLines(sources.get(path) ?? "").entries()) {
      if (evidence.length >= MAX_EVIDENCE) break;
      if (TODO_MARKER.test(line) || SKIPPED_TEST.test(line)) {
        evidence.push(
          `- ${clean(path)}:${i + 1}: ${clip(clean(line.trim()), MAX_EVIDENCE_LENGTH)}`,
        );
      }
    }
  }
  for (const commit of commits) {
    if (evidence.length < MAX_EVIDENCE && REVERT_SUBJECT.test(commit.subject)) {
      evidence.push(
        `- commit:${commit.sha.slice(0, 7)} ${clip(clean(commit.subject), MAX_SUBJECT_LENGTH)}`,
      );
    }
  }
  const commitLines = commits.slice(0, MAX_COMMITS).map((c) => {
    const pr = c.pr === null ? "" : ` (PR #${c.pr})`;
    return `- commit:${c.sha.slice(0, 7)} ${clean(c.date.slice(0, 10))} ${clip(clean(c.subject), MAX_SUBJECT_LENGTH)}${pr}`;
  });
  const more = commits.length - commitLines.length;

  const head = [
    `# Page: ${clean(feature.title)} (${clean(feature.id)})`,
    `Aliases: ${feature.aliases.map(clean).join(", ") || "(none)"}`,
    `Neighbouring features: ${neighbours.join(", ") || "(none)"}`,
  ].join("\n");
  const tail = [
    `## Commits that touched this feature (newest first)\n${commitLines.join("\n") || "(none)"}${more > 0 ? `\n- and ${more} older commits` : ""}`,
    `## Evidence for known limitations\n${evidence.join("\n") || "(none)"}`,
    `## Diagram candidates\n${renderCandidates(candidates, clean)}`,
    "Write the page.",
  ].join("\n\n");

  const budgetChars = input.budgetTokens * 2.5;
  let used = head.length + tail.length;
  const blocks: string[] = [];
  const shown: ContextPack["shown"] = [];
  const listed: string[] = [];
  for (const path of files) {
    const text = sources.get(path);
    const file = indexed.get(path);
    if (text === undefined || file === undefined || file.skipped !== null) {
      listed.push(path);
      shown.push({ path, mode: "listed" });
      continue;
    }
    const lines = sourceLines(text);
    const width = String(lines.length).length;
    const full = [
      `### ${clean(path)} (${lines.length} lines)`,
      ...(lines.length === 0
        ? []
        : [
            numbered(
              lines,
              lines.map((_, i) => i + 1),
              width,
            ),
          ]),
    ].join("\n");
    if (used + full.length <= budgetChars * FULL_SOURCE_SHARE) {
      blocks.push(full);
      used += full.length + 2;
      shown.push({ path, mode: "full" });
      continue;
    }
    const numbers = [...new Set(file.symbols.flatMap((s) => signatureLines(lines, s)))].sort(
      (a, b) => a - b,
    );
    const signatures = `### ${clean(path)} (${lines.length} lines; signatures only)\n${numbered(lines, numbers, width)}`;
    if (numbers.length > 0 && used + signatures.length <= budgetChars) {
      blocks.push(signatures);
      used += signatures.length + 2;
      shown.push({ path, mode: "signatures" });
      continue;
    }
    listed.push(path);
    shown.push({ path, mode: "listed" });
  }
  const others =
    listed.length === 0
      ? []
      : [`## Other member files (not shown)\n${listed.map((p) => `- ${clean(p)}`).join("\n")}`];
  const text = [head, `## Source`, ...blocks, ...others, tail].join("\n\n");
  return { featureId, text, tokens: estimateTokens(text), shown, commits, candidates };
}
