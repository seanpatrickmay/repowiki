import {
  type Citation,
  type Claim,
  type ClaimKind,
  claimRuleViolations,
  contentHash,
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

/** A model-supplied string, safe to quote in a retry prompt: JSON-escaped and cut to 80. */
export function quote(text: string): string {
  const chars = [...text];
  if (chars.length <= MAX_QUOTED_LENGTH) return JSON.stringify(text);
  return JSON.stringify(`${chars.slice(0, MAX_QUOTED_LENGTH).join("")}…`);
}

const lineCount = (text: string): number => text.replace(/\n$/, "").split("\n").length;

/** Lines start..end (1-based, inclusive) of a file's text. */
export function citedLines(text: string, start: number, end: number): string {
  return text
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
}

/** Whether text holds a C0 or C1 control character, NUL and newlines included. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** A relative path with no `..` segment; the caller still requires it to be a key of the sources. */
function isSafePath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  return !path.split(/[\\/]/).includes("..");
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
  if (hasControlCharacter(ref)) {
    return { problem: `citation ${quote(ref)} is not a safe repository path` };
  }
  const code = /^(.+):L?(\d+)(?:-L?(\d+))?$/.exec(ref.trim());
  if (code === null) {
    return { problem: `citation ${quote(ref)} is neither "path:start-end" nor "commit:sha"` };
  }
  const path = code[1] ?? "";
  if (!isSafePath(path)) {
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
  if (text === "") problems.push("the claim has no text");
  if ([...text].length > MAX_CLAIM_LENGTH) {
    problems.push(`the claim is over ${MAX_CLAIM_LENGTH} characters; split or shorten it`);
  }
  const citations: Citation[] = [];
  let evidence = false;
  const seen = new Set<string>();
  for (const ref of draft.cite) {
    const resolved = resolveReference(ref, ctx);
    if ("problem" in resolved) {
      problems.push(resolved.problem);
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
  // Rule violations are only meaningful once every reference resolved.
  if (problems.length === 0) problems.push(...claimRuleViolations(key, claim));
  if (problems.length === 0 && key === "known-limitations" && !evidence) {
    problems.push(
      "limitation claims must cite evidence: lines with a TODO or FIXME, a skipped test, or a reverting commit",
    );
  }
  return problems.length === 0 ? { claim, problems: [] } : { claim: null, problems };
}
