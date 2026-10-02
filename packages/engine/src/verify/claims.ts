import {
  type Citation,
  type Claim,
  type ClaimKind,
  claimRuleViolations,
  contentHash,
  RepoPath,
  type SectionKey,
} from "@repowiki/core";
import type { CommitInfo } from "../index/index.ts";
import type { DraftClaim } from "./draft.ts";
import { isLimitationEvidence } from "./evidence.ts";

/** What citations are checked against: the files and commits of the page's sha. */
export interface VerifyContext {
  sha: string;
  /** Text of every readable file at sha, by path. */
  sources: ReadonlyMap<string, string>;
  /** Indexed symbols of a file, to name the symbol a cited range sits in. */
  symbolsOf(path: string): readonly { qualifiedName: string; startLine: number; endLine: number }[];
  /** Every commit reachable from sha. */
  commits: readonly CommitInfo[];
}

/** A citation must point at a passage, not a whole module. */
export const MAX_CITED_LINES = 120;
/** Claim text is a sentence or two; this bounds what reaches pages and hover previews. */
export const MAX_CLAIM_LENGTH = 1000;
const MIN_COMMIT_PREFIX = 7;
const MAX_QUOTED_LENGTH = 80;

/**
 * Characters that can forge or hide structure in a prompt or a page: control characters (C0, DEL
 * and C1), line and paragraph separators, bidirectional controls and the byte order mark.
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const UNSAFE_TEXT_EACH = new RegExp(UNSAFE_TEXT.source, "gu");

const hex4 = (char: string): string => (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0");

/**
 * A model-supplied string, safe to quote in a retry prompt: JSON-escaped, cut to 80, and with
 * every character JSON leaves raw but UNSAFE_TEXT names (C1, U+2028/9, bidi, BOM) escaped too.
 */
export function quote(text: string): string {
  const chars = [...text];
  const json =
    chars.length <= MAX_QUOTED_LENGTH
      ? JSON.stringify(text)
      : JSON.stringify(`${chars.slice(0, MAX_QUOTED_LENGTH).join("")}…`);
  return json.replace(UNSAFE_TEXT_EACH, (char) => `\\u${hex4(char)}`);
}

/**
 * A file's lines as citations count them: split on "\n" only (a CRLF line keeps its "\r"), an
 * empty file has none, and a final newline ends a line rather than starting one. Line N of this
 * list is exactly `citedLines(text, N, N)`.
 */
export function sourceLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

const lineCount = (text: string): number => sourceLines(text).length;

/** Lines start..end (1-based, inclusive) of a file's text. */
export function citedLines(text: string, start: number, end: number): string {
  return text
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
}

export type Resolved = { citation: Citation; lines: string | null } | { problem: string };

/**
 * Turns one "path:12-30" or "commit:abc1234" reference into a core Citation at ctx.sha. A code
 * citation gets the hash of its lines and the innermost indexed symbol around them. The reference
 * is model-supplied: a path with control characters, a `..` segment or a leading slash is refused,
 * and only a key of ctx.sources ever resolves.
 */
export function resolveReference(ref: string, ctx: VerifyContext): Resolved {
  const commit = /^commit:([0-9a-f]+)$/i.exec(ref.trim());
  if (commit) return resolveCommit(ref, (commit[1] ?? "").toLowerCase(), ctx);
  if (UNSAFE_TEXT.test(ref)) {
    return { problem: `citation ${quote(ref)} is not a safe repository path` };
  }
  const code = /^(.+):L?(\d+)(?:-L?(\d+))?$/.exec(ref.trim());
  if (code === null) {
    return { problem: `citation ${quote(ref)} is neither "path:start-end" nor "commit:sha"` };
  }
  const path = code[1] ?? "";
  if (!RepoPath.safeParse(path).success) {
    return { problem: `citation ${quote(ref)} is not a safe repository path` };
  }
  const startLine = Number(code[2]);
  const endLine = Number(code[3] ?? code[2]);
  const text = ctx.sources.get(path);
  if (text === undefined) {
    return { problem: `citation ${quote(ref)} names no file at this commit` };
  }
  const total = lineCount(text);
  if (startLine < 1 || endLine < startLine || endLine > total) {
    return { problem: `citation ${quote(ref)} is outside the file's lines 1-${total}` };
  }
  if (endLine - startLine + 1 > MAX_CITED_LINES) {
    return {
      problem: `citation ${quote(ref)} spans more than ${MAX_CITED_LINES} lines; cite the passage`,
    };
  }
  const lines = citedLines(text, startLine, endLine);
  const symbol =
    ctx
      .symbolsOf(path)
      .filter((s) => s.startLine <= startLine && endLine <= s.endLine)
      .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0]?.qualifiedName ??
    null;
  const citation: Citation = {
    kind: "code",
    path,
    startLine,
    endLine,
    sha: ctx.sha,
    symbol,
    contentHash: contentHash(lines),
  };
  return { citation, lines };
}

function resolveCommit(ref: string, prefix: string, ctx: VerifyContext): Resolved {
  if (prefix.length < MIN_COMMIT_PREFIX) {
    return { problem: `citation ${quote(ref)} needs at least ${MIN_COMMIT_PREFIX} hex digits` };
  }
  const matches = ctx.commits.filter((c) => c.sha.startsWith(prefix));
  const found = matches[0];
  if (found === undefined || matches.length > 1) {
    const why = found === undefined ? "names no commit in this history" : "is ambiguous";
    return { problem: `citation ${quote(ref)} ${why}` };
  }
  const subject = found.subject.trim() === "" ? "(no subject)" : found.subject;
  return { citation: { kind: "commit", sha: found.sha, subject, pr: found.pr }, lines: null };
}

function kindOf(key: SectionKey): ClaimKind {
  if (key === "history") return "history";
  if (key === "known-limitations") return "limitation";
  return "fact";
}

export type Verified = { claim: Claim; problems: [] } | { claim: null; problems: string[] };

/**
 * Checks one draft claim of a section: every reference resolves at ctx.sha, the section's
 * citation rules hold (spec §5 rules 2-4), a limitation cites evidence, and the text is short.
 * The claim keeps the draft's id and supports; the page assembly renumbers them.
 */
export function verifyClaim(key: SectionKey, draft: DraftClaim, ctx: VerifyContext): Verified {
  const problems: string[] = [];
  const text = draft.text.trim();
  if (draft.id === "") problems.push("the claim has no id");
  if (text === "") problems.push("the claim has no text");
  if ([...text].length > MAX_CLAIM_LENGTH) {
    problems.push(`the claim is over ${MAX_CLAIM_LENGTH} characters; split or shorten it`);
  }
  if (UNSAFE_TEXT.test(text)) {
    problems.push(
      "the claim text holds a control or line-break character; write one plain paragraph",
    );
  }
  const citations: Citation[] = [];
  let evidence = false;
  let unresolved = false;
  const seen = new Set<string>();
  for (const ref of draft.cite) {
    const resolved = resolveReference(ref, ctx);
    if ("problem" in resolved) {
      problems.push(resolved.problem);
      unresolved = true;
      continue;
    }
    const fingerprint = JSON.stringify(resolved.citation);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    citations.push(resolved.citation);
    evidence ||= isLimitationEvidence(resolved.citation, resolved.lines);
  }
  const claim: Claim = {
    id: draft.id,
    text: text === "" ? "-" : text,
    kind: kindOf(key),
    citations,
    supports: key === "lead" ? draft.supports : [],
    staleSince: null,
    hook: draft.hook,
  };
  if (key !== "lead" && draft.supports.length > 0) {
    problems.push("only lead claims may support other claims");
  }
  // The citation rules and the evidence check need every reference resolved, but not clean text:
  // the retry round should hear about every problem at once, or the claim is dropped for a
  // problem the model was never told about.
  if (!unresolved) {
    const violations = claimRuleViolations(key, claim);
    problems.push(...violations);
    if (violations.length === 0 && key === "known-limitations" && !evidence) {
      problems.push(
        "limitation claims must cite evidence: lines with a TODO or FIXME, a skipped test, or a reverting commit",
      );
    }
  }
  return problems.length === 0 ? { claim, problems: [] } : { claim: null, problems };
}
