import { INVISIBLE_CHARACTERS, type Manifest } from "@repowiki/core";
import type { CommitInfo, IndexedSymbol, RepoIndex, SourceLanguage } from "../index/index.ts";
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
  /** Token budget for the whole pack (spec §7.2: contextBudgetTokens). */
  budgetTokens: number;
}

/** One write call's context (spec §7.2): the user message, plus what verify and diagrams need. */
export interface ContextPack {
  featureId: string;
  text: string;
  /** Estimated tokens of `text`; at most the budget, unless the header and candidates alone exceed it. */
  tokens: number;
  /** How each member file is shown: in full, as signatures, or only listed. */
  shown: { path: string; mode: "full" | "signatures" | "listed" }[];
  /** All of the feature's commits, newest first; the pack lists the newest 40 that fit. */
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
/** Lines of a signature, of the decorators above it, and of a docstring below it. */
const MAX_SIGNATURE_LINES = 12;
const MAX_DECORATOR_LINES = 12;
const MAX_DOCSTRING_LINES = 6;
const MAX_JSDOC_LINES = 12;

/** estimateTokens counts a token per 2.5 characters, so a budget is this many characters. */
const CHARS_PER_TOKEN = 2.5;
const SOURCE_HEADING = "## Source";
const OTHER_FILES_HEADING = "## Other member files (not shown)";
const moreFiles = (count: number) => `- and ${count} more files`;
/** What the not-shown list needs at the least: its separator, heading and a "more files" line. */
const OTHER_FILES_RESERVE = 2 + OTHER_FILES_HEADING.length + 1 + moreFiles(9_999_999).length;

/**
 * Characters that can forge or hide structure in a prompt, other than tab: core's
 * INVISIBLE_CHARACTERS (control characters, so newline too, line and paragraph separators, and
 * every format character except ZWJ and ZWNJ, which emoji sequences and several scripts need).
 */
const UNSAFE = new RegExp(`(?!\\t)${INVISIBLE_CHARACTERS.source}`, "gu");

/** A repository- or model-derived string, safe to put in the prompt: unsafe characters become U+FFFD. */
const clean = (text: string): string => text.replace(UNSAFE, "\uFFFD");

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
      const line = raw.length > MAX_LINE_LENGTH ? `${clip(raw, MAX_LINE_LENGTH)}\u2026` : raw;
      return `${String(n).padStart(width)}| ${clean(line)}`;
    })
    .join("\n");
}

/**
 * Walks one source line, tracking bracket depth and skipping string literals and comments (`#`
 * in Python, `//` elsewhere). Returns the depth after the line, and whether the line holds the
 * end of a signature at depth 0: a `:` in Python, a `{`, `=>` or `;` elsewhere. Only the first
 * such terminator counts, and the depth is then that at the terminator.
 */
function scanLine(
  text: string,
  python: boolean,
  depth: number,
): { depth: number; terminated: boolean } {
  let quote = "";
  // The last character that was not a space, to tell a type's `{` from the body's.
  let previous = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    const before = previous;
    if (c !== " " && c !== "\t") previous = c;
    if (c === '"' || c === "'" || (c === "`" && !python)) quote = c;
    else if (python ? c === "#" : c === "/" && text[i + 1] === "/") break;
    else if (c === "(" || c === "[" || c === "{") {
      // After `<`, `:`, `|`, `&` or `,` a `{` opens an object-literal type, not the body.
      if (c === "{" && depth === 0 && !python && !"<:|&,".includes(before || "x")) {
        return { depth, terminated: true };
      }
      depth++;
    } else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && python && c === ":") return { depth, terminated: true };
    else if (depth === 0 && !python && c === ";") return { depth, terminated: true };
    else if (depth === 0 && !python && c === "=" && text[i + 1] === ">") {
      return { depth, terminated: true };
    }
  }
  return { depth, terminated: false };
}

/**
 * Whether a line opening with a decorator also holds the declaration it decorates, as in
 * `@HostListener("x") onX() {`: after the decorator's name and its balanced arguments comes
 * more than a comment. A decorator whose arguments run past the line is not one.
 */
function decoratesOnOwnLine(text: string): boolean {
  const name = /^\s*@[\w$.]+/.exec(text);
  if (name === null) return false;
  let rest = text.slice(name[0].length);
  if (rest.startsWith("(")) {
    const { depth, end } = argumentsEnd(rest);
    if (depth > 0) return false;
    rest = rest.slice(end);
  }
  rest = rest.trim();
  return rest !== "" && !/^(?:\/\/|\/\*|#)/.test(rest);
}

/** Where the parenthesis that opens `text` closes (or the text's end), and the depth left open. */
function argumentsEnd(text: string): { depth: number; end: number } {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { depth, end: i + 1 };
  }
  return { depth, end: text.length };
}

const PYTHON_HEADER = /^\s*(?:async\s+def\s|def\s|class\s[^{]*$)/;
const DOCSTRING_OPEN = /^[rRbBuUfF]{0,2}("""|''')/;
const DOCSTRING_ONE_LINE = /^[rRbBuUfF]{0,2}(?:"[^"]*"|'[^']*')\s*$/;

/**
 * The lines that show a symbol's signature, in order: the JSDoc block right above it (at most
 * 12 lines), its decorators (any run of lines opening with `@`, a multi-line one by bracket
 * balance; at most 12 lines shown), the signature itself from the line after them to the line
 * that ends it (at most 12): a `:` at bracket depth 0 in Python, a `{`, `=>` or `;` at depth 0
 * elsewhere, then a Python docstring (at most 6 lines). `language` says which of the two;
 * when it is not given, a `def` or a brace-less `class` line means Python.
 */
export function signatureLines(
  lines: readonly string[],
  symbol: IndexedSymbol,
  language: SourceLanguage | null = null,
): number[] {
  const out: number[] = [];
  const at = (n: number) => (lines[n - 1] ?? "").trimEnd();
  const last = symbol.endLine;

  if (
    at(symbol.startLine - 1)
      .trim()
      .endsWith("*/")
  ) {
    let start = symbol.startLine - 1;
    while (
      start > 1 &&
      start > symbol.startLine - MAX_JSDOC_LINES &&
      !at(start).trim().startsWith("/**")
    )
      start--;
    if (at(start).trim().startsWith("/**"))
      for (let n = start; n < symbol.startLine; n++) out.push(n);
  }

  let first = symbol.startLine;
  let depth = 0;
  while (
    first <= last &&
    (depth > 0 || (at(first).trim().startsWith("@") && !decoratesOnOwnLine(at(first))))
  ) {
    depth = scanLine(at(first), false, depth).depth;
    if (first - symbol.startLine < MAX_DECORATOR_LINES) out.push(first);
    first++;
  }
  if (first > last) return out;

  const python = language === null ? PYTHON_HEADER.test(at(first)) : language === "python";
  let end = first;
  depth = 0;
  for (let n = first; n <= Math.min(last, first + MAX_SIGNATURE_LINES - 1); n++) {
    end = n;
    out.push(n);
    const scanned = scanLine(at(n), python, depth);
    depth = scanned.depth;
    if (scanned.terminated) break;
  }

  const doc = at(end + 1).trim();
  if (python && end + 1 <= last) {
    const open = DOCSTRING_OPEN.exec(doc)?.[1];
    if (open !== undefined) {
      const oneLine = doc.indexOf(open, doc.indexOf(open) + 3) !== -1;
      for (let n = end + 1; n <= Math.min(last, end + MAX_DOCSTRING_LINES); n++) {
        out.push(n);
        if (oneLine || (n > end + 1 && at(n).includes(open))) break;
      }
    } else if (DOCSTRING_ONE_LINE.test(doc)) {
      out.push(end + 1);
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
 * The lines that can back a known limitation (spec §5 rule 3), strongest first and 30 at most:
 * reverting commits (newest first), then skipped tests, then TODO/FIXME lines, each in member-file
 * weight order. Only member files count.
 */
function limitationEvidence(
  files: readonly string[],
  commits: readonly CommitInfo[],
  sources: ReadonlyMap<string, string>,
): string[] {
  const reverts = commits
    .filter((c) => REVERT_SUBJECT.test(c.subject))
    .slice(0, MAX_EVIDENCE)
    .map((c) => `- commit:${c.sha.slice(0, 7)} ${clip(clean(c.subject), MAX_SUBJECT_LENGTH)}`);
  const skipped: string[] = [];
  const todos: string[] = [];
  for (const path of files) {
    for (const [i, line] of sourceLines(sources.get(path) ?? "").entries()) {
      const isSkip = SKIPPED_TEST.test(line);
      if (!isSkip && !TODO_MARKER.test(line)) continue;
      const found = isSkip ? skipped : todos;
      if (found.length < MAX_EVIDENCE) {
        found.push(`- ${clean(path)}:${i + 1}: ${clip(clean(line.trim()), MAX_EVIDENCE_LENGTH)}`);
      }
    }
  }
  return [...reverts, ...skipped, ...todos].slice(0, MAX_EVIDENCE);
}

/**
 * Builds the context pack for one feature page (spec §7.2). Everything in the pack counts toward
 * `budgetTokens`. The header, commits (newest 40), limitation evidence (30), neighbours and
 * diagram candidates go in first; if they alone exceed the budget, commits are dropped from the
 * oldest, then evidence from the weakest. Then each member file, heaviest first, is judged on
 * its own: in full if the pack stays under 70% of the budget, else as signatures and docstrings
 * if it stays under the budget, else listed by path. Listed paths are themselves capped by what
 * is left, with "and N more files" for the rest. Once a file has taken signatures, later files
 * usually have no room for full source and are listed.
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

  const evidence = limitationEvidence(files, commits, sources);
  const commitLines = commits.slice(0, MAX_COMMITS).map((c) => {
    const pr = c.pr === null ? "" : ` (PR #${c.pr})`;
    return `- commit:${c.sha.slice(0, 7)} ${clean(c.date.slice(0, 10))} ${clip(clean(c.subject), MAX_SUBJECT_LENGTH)}${pr}`;
  });

  const head = [
    `# Page: ${clean(feature.title)} (${clean(feature.id)})`,
    `Aliases: ${feature.aliases.map(clean).join(", ") || "(none)"}`,
    `Neighbouring features: ${neighbours.join(", ") || "(none)"}`,
  ].join("\n");
  const diagrams = `## Diagram candidates\n${renderCandidates(candidates, clean)}`;
  /** Everything after the source, with the first `nc` commit lines and `ne` evidence lines. */
  const tailWith = (nc: number, ne: number): string => {
    const omittedCommits = commits.length - nc;
    const commitNote =
      omittedCommits === 0
        ? ""
        : nc > 0
          ? `\n- and ${omittedCommits} older commits`
          : `- ${omittedCommits} commits not listed`;
    const omittedEvidence = evidence.length - ne;
    const evidenceNote =
      omittedEvidence === 0
        ? ""
        : ne > 0
          ? `\n- and ${omittedEvidence} more evidence items not listed`
          : `- ${omittedEvidence} evidence items not listed`;
    return [
      `## Commits that touched this feature (newest first)\n${commitLines.slice(0, nc).join("\n") || (commits.length === 0 ? "(none)" : "")}${commitNote}`,
      `## Evidence for known limitations\n${evidence.slice(0, ne).join("\n") || (evidence.length === 0 ? "(none)" : "")}${evidenceNote}`,
      diagrams,
      "Write the page.",
    ].join("\n\n");
  };

  const budgetChars = input.budgetTokens * CHARS_PER_TOKEN;
  // The parts are joined with "\n\n": head, source heading and tail make two separators; each
  // file block and the not-shown list add one more.
  const fixedLength = (nc: number, ne: number) =>
    head.length + SOURCE_HEADING.length + tailWith(nc, ne).length + 4;
  let nCommits = commitLines.length;
  let nEvidence = evidence.length;
  while (fixedLength(nCommits, nEvidence) > budgetChars && (nCommits > 0 || nEvidence > 0)) {
    if (nCommits > 0) nCommits--;
    else nEvidence--;
  }
  const tail = tailWith(nCommits, nEvidence);

  let used = fixedLength(nCommits, nEvidence);
  const fullLimit = budgetChars * FULL_SOURCE_SHARE;
  const signatureLimit = budgetChars - OTHER_FILES_RESERVE;
  const blocks: string[] = [];
  const shown: ContextPack["shown"] = [];
  const listed: string[] = [];
  for (const path of files) {
    const text = sources.get(path);
    const file = indexed.get(path);
    if (
      text === undefined ||
      file === undefined ||
      file.skipped !== null ||
      used >= signatureLimit
    ) {
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
    if (used + 2 + full.length <= fullLimit) {
      blocks.push(full);
      used += full.length + 2;
      shown.push({ path, mode: "full" });
      continue;
    }
    const numbers = [
      ...new Set(file.symbols.flatMap((s) => signatureLines(lines, s, file.language))),
    ].sort((a, b) => a - b);
    const signatures = `### ${clean(path)} (${lines.length} lines; signatures only)\n${numbered(lines, numbers, width)}`;
    if (numbers.length > 0 && used + 2 + signatures.length <= signatureLimit) {
      blocks.push(signatures);
      used += signatures.length + 2;
      shown.push({ path, mode: "signatures" });
      continue;
    }
    listed.push(path);
    shown.push({ path, mode: "listed" });
  }

  const others: string[] = [];
  if (listed.length > 0) {
    // Paths while they fit (each leaves room for the "more files" line that may follow), then a count.
    const room = budgetChars - used - 2;
    const lines: string[] = [];
    let length = OTHER_FILES_HEADING.length;
    for (const [i, path] of listed.entries()) {
      const line = `- ${clean(path)}`;
      const rest = listed.length - i - 1;
      const reserve = rest > 0 ? 1 + moreFiles(rest).length : 0;
      if (length + 1 + line.length + reserve > room) break;
      lines.push(line);
      length += 1 + line.length;
    }
    if (lines.length < listed.length) lines.push(moreFiles(listed.length - lines.length));
    if (OTHER_FILES_HEADING.length + lines.join("\n").length + 1 <= room) {
      others.push(`${OTHER_FILES_HEADING}\n${lines.join("\n")}`);
    }
  }
  const text = [head, SOURCE_HEADING, ...blocks, ...others, tail].join("\n\n");
  return { featureId, text, tokens: estimateTokens(text), shown, commits, candidates };
}
