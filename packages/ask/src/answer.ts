import {
  ASK_EXCERPT_LENGTH,
  ASK_MAX_READ_NEXT,
  ASK_MAX_SENTENCE_SOURCES,
  ASK_MAX_SENTENCES,
  ASK_MAX_SOURCES,
  ASK_SENTENCE_MAX_LENGTH,
  ASK_TITLE_MAX_LENGTH,
  type AskAnswerStatus,
  AskResponse,
  type AskSource,
  NOT_FOUND_SENTENCE,
  plainClaimText,
} from "@repowiki/core";
import {
  ABOUT_PAGE_ID,
  claimHref,
  cut,
  type HandleClaim,
  handleClaim,
  oneLine,
  pageHref,
  reference,
  SECTION_TITLES,
  toolText,
  type WikiView,
} from "@repowiki/query";
import { z } from "zod";
import { type AskIndexes, hintedPage, PACK_PAGES } from "./pack.ts";
import { MAX_ANSWER_WORDS } from "./prompt.ts";

/**
 * The answer tool's input as validation reads it: looser than the AnswerInput the model is told,
 * so a seventh sentence or a fifth handle is dropped by the rules below rather than losing the
 * whole answer. Anything that is not even this is an unusable answer.
 */
const LooseAnswer = z.object({
  status: z.enum(["answered", "partial", "not-found"]),
  sentences: z
    .array(z.object({ text: z.string(), claims: z.array(z.string()).max(20) }))
    .max(20)
    .default([]),
  readNext: z.array(z.string()).max(10).default([]),
});

/**
 * File extensions that make a word code-like: spec v2 #4 R6's list, plus the other common source,
 * config and text files (plan ruling), so `secrets.txt` or `main.go` must be grounded too.
 */
const SOURCE_EXTENSION =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|tf|hcl|json|yml|yaml|toml|sql|sh|css|html|md|txt|env|ini|cfg|xml|lock|go|rs|java|kt|rb|php|c|h|cpp|cs|swift)$/i;

/**
 * The code-like tokens of a sentence (spec v2 #4 R6): every backtick span, and every other word
 * that contains `/` or `_`, ends in `()`, or ends in a source-file extension. Surrounding
 * punctuation is not part of a word.
 */
export function codeTokens(text: string): string[] {
  const tokens: string[] = [];
  const rest = text.replace(/`([^`]*)`/g, (_span, inner: string) => {
    if (inner.trim() !== "") tokens.push(inner.trim());
    return " ";
  });
  for (const raw of rest.split(/\s+/)) {
    let word = raw.replace(/^[("'[{<]+/, "");
    for (;;) {
      const next = word.replace(/[.,;:!?'"\]}>]+$/, "");
      const trimmed = next.endsWith(")") && !next.endsWith("()") ? next.slice(0, -1) : next;
      if (trimmed === word) break;
      word = trimmed;
    }
    if (word === "") continue;
    if (word.endsWith("()") || /[/_]/.test(word) || SOURCE_EXTENSION.test(word)) tokens.push(word);
  }
  return tokens;
}

/** Everything a cited claim lets a sentence name: its text, citations, page title and aliases. */
function groundText(view: WikiView, claims: readonly HandleClaim[]): string {
  return claims
    .flatMap((c) => [
      c.claim.text,
      view.text(c.claim.text),
      ...c.claim.citations.flatMap((citation) =>
        citation.kind === "code"
          ? [citation.path, citation.symbol ?? "", reference(citation)]
          : [citation.subject],
      ),
      c.pageTitle,
      ...c.aliases,
    ])
    .join("\n");
}

/**
 * The first code-like token of `text` that its cited claims do not write (spec v2 #4 R6), or
 * null when every one is grounded. `foo()` is grounded by `foo`.
 */
export function ungroundedToken(
  view: WikiView,
  text: string,
  claims: readonly HandleClaim[],
): string | null {
  const ground = groundText(view, claims);
  for (const token of codeTokens(text)) {
    const base = token.endsWith("()") ? token.slice(0, -2) : token;
    if (!ground.includes(token) && (base === "" || !ground.includes(base))) return token;
  }
  return null;
}

/** A sentence validation dropped: its 1-based number in the model's answer, and why. */
export interface Refusal {
  n: number;
  reason: string;
}

/** The model's answer after validation (spec v2 #4 §6.3). */
export interface CheckedAnswer {
  /** Null when the input was not an answer at all. */
  status: "answered" | "partial" | "not-found" | null;
  sentences: { text: string; handles: string[] }[];
  readNext: string[];
  refusals: Refusal[];
}

const words = (text: string) => text.split(/\s+/).filter((w) => w !== "").length;

/** A handle as the model may write it: with or without its braces. */
const bare = (claim: string) =>
  claim
    .trim()
    .replace(/^\{\s*/, "")
    .replace(/\s*\}$/, "");

/**
 * Validates an `answer` call's input against what the conversation showed (spec v2 #4 R5, R6),
 * in order: parse; per sentence, one neutralised line cut at 400 code points; keep only handles
 * in `shown` (deduplicated, at most 4); refuse a sentence left with none, or one naming a
 * code-like token its cited claims do not write; stop at 6 sentences and 120 words.
 */
export function checkAnswer(
  view: WikiView,
  input: unknown,
  shown: ReadonlySet<string>,
): CheckedAnswer {
  const parsed = LooseAnswer.safeParse(input);
  if (!parsed.success) return { status: null, sentences: [], readNext: [], refusals: [] };
  const sentences: CheckedAnswer["sentences"] = [];
  const refusals: Refusal[] = [];
  let total = 0;
  for (const [i, sentence] of parsed.data.sentences.entries()) {
    const text = cut(oneLine(toolText(sentence.text)), ASK_SENTENCE_MAX_LENGTH);
    const handles = [...new Set(sentence.claims.map(bare))]
      .filter((h) => shown.has(h))
      .slice(0, ASK_MAX_SENTENCE_SOURCES);
    const claims = handles.flatMap((h) => handleClaim(view, h) ?? []);
    const reason =
      text === ""
        ? "it is empty"
        : handles.length === 0
          ? "it cites no handle of a claim you were shown"
          : ungroundedToken(view, text, claims) !== null
            ? "it names a file, function or setting that its cited claims do not write"
            : sentences.length === ASK_MAX_SENTENCES
              ? `it is past the ${ASK_MAX_SENTENCES}-sentence limit`
              : total + words(text) > MAX_ANSWER_WORDS
                ? `it is past the ${MAX_ANSWER_WORDS}-word limit`
                : null;
    if (reason !== null) {
      refusals.push({ n: i + 1, reason });
      continue;
    }
    total += words(text);
    sentences.push({ text, handles });
  }
  return { status: parsed.data.status, sentences, readNext: parsed.data.readNext, refusals };
}

/** Claim text as an excerpt: plain words on one line, emphasis markers dropped, cut at 160. */
function excerptOf(view: WikiView, text: string): string {
  const plain = plainClaimText(text, (id) => (view.features.has(id) ? view.title(id) : null))
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/\*(?=\S)([^*]+?)(?<=\S)\*/g, "$1");
  return cut(oneLine(plain), ASK_EXCERPT_LENGTH) || "(no text)";
}

const titleOf = (view: WikiView, pageId: string) =>
  cut(
    oneLine(pageId === ABOUT_PAGE_ID ? (view.article?.title ?? "About") : view.title(pageId)),
    ASK_TITLE_MAX_LENGTH,
  ) || pageId;

/** One cited claim as the answer's Sources list shows it. */
function sourceOf(view: WikiView, n: number, found: HandleClaim): AskSource {
  return {
    n,
    pageId: found.pageId,
    pageTitle: titleOf(view, found.pageId),
    section: found.sectionKey,
    sectionTitle: SECTION_TITLES[found.sectionKey] ?? null,
    claimId: found.claim.id,
    href: claimHref(found.pageId, found.claim.id, found.sectionKey),
    excerpt: excerptOf(view, found.claim.text),
  };
}

/**
 * Up to three pages to read next: the model's ids that resolve to a page, then the page search
 * over the question, each once.
 */
export function readNextOf(
  view: WikiView,
  indexes: AskIndexes,
  question: string,
  wanted: readonly string[],
): AskResponse["readNext"] {
  const ids: string[] = [];
  const add = (id: string | null) => {
    if (id !== null && !ids.includes(id) && ids.length < ASK_MAX_READ_NEXT) ids.push(id);
  };
  for (const id of wanted) add(hintedPage(view, id));
  for (const id of indexes.pages.search(question, PACK_PAGES)) add(id);
  return ids.map((id) => ({
    pageId: id,
    title: titleOf(view, id),
    href: pageHref(id),
    summary: view.summary(id),
  }));
}

export interface ResponseInput {
  view: WikiView;
  indexes: AskIndexes;
  question: string;
  status: AskAnswerStatus;
  sentences: readonly { text: string; handles: readonly string[] }[];
  readNext: readonly string[];
  refused: number;
  cost: AskResponse["cost"];
  answeredAt: Date;
}

/**
 * The response the sidebar shows (spec v2 #4 §6.3): sources numbered in order of first citation
 * (at most 12; a sentence left with none is refused), links built by the server from handles,
 * and Read next filled from the page search. An answered or partial answer left with no sentence
 * is not-found, whose one sentence is R26's fixed text; budget and error answers have none.
 * Parsed with core's AskResponse before it is returned.
 */
export function buildResponse(input: ResponseInput): AskResponse {
  const { view } = input;
  const numbers = new Map<string, number>();
  const sources: AskSource[] = [];
  const sentences: AskResponse["sentences"] = [];
  let refused = input.refused;
  const answering = input.status === "answered" || input.status === "partial";
  for (const sentence of answering ? input.sentences : []) {
    const cited: number[] = [];
    for (const handle of sentence.handles) {
      let n = numbers.get(handle);
      if (n === undefined) {
        const found = handleClaim(view, handle);
        if (found === null || sources.length === ASK_MAX_SOURCES) continue;
        n = sources.length + 1;
        numbers.set(handle, n);
        sources.push(sourceOf(view, n, found));
      }
      if (!cited.includes(n)) cited.push(n);
    }
    if (cited.length === 0) refused++;
    else sentences.push({ text: sentence.text, sources: cited });
  }
  let status = input.status;
  if (answering && sentences.length === 0) status = "not-found";
  return AskResponse.parse({
    status,
    question: input.question,
    head: view.wiki.head,
    sentences: status === "not-found" ? [{ text: NOT_FOUND_SENTENCE, sources: [] }] : sentences,
    sources: status === "not-found" ? [] : sources,
    readNext: readNextOf(view, input.indexes, input.question, input.readNext),
    refused,
    cached: false,
    answeredAt: input.answeredAt.toISOString(),
    cost: input.cost,
  });
}
