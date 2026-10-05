import { z } from "zod";
import { GitSha, IsoDateTime } from "./primitives.ts";

/** The longest question the sidebar takes, in code points after trimming (spec v2 #4 §5.1). */
export const ASK_QUESTION_MAX_LENGTH = 500;
/** The most sentences an answer shows. */
export const ASK_MAX_SENTENCES = 6;
/** The longest sentence shown, in code points. */
export const ASK_SENTENCE_MAX_LENGTH = 400;
/** The most claims one sentence cites. */
export const ASK_MAX_SENTENCE_SOURCES = 4;
/** The most sources one answer lists. */
export const ASK_MAX_SOURCES = 12;
/** The most pages an answer's Read next lists. */
export const ASK_MAX_READ_NEXT = 3;
/** The longest excerpt of a cited claim a source shows, in code points. */
export const ASK_EXCERPT_LENGTH = 160;
/** The longest page hint a request may carry: the longest page id an answer names. */
export const ASK_PAGE_MAX_LENGTH = 64;
/** The longest page summary in Read next, and the longest title, in code points. */
export const ASK_SUMMARY_MAX_LENGTH = 200;
export const ASK_TITLE_MAX_LENGTH = 200;

/** A not-found answer's one sentence: fixed server text, never the model's (spec v2 #4 R26). */
export const NOT_FOUND_SENTENCE = "The wiki does not cover this.";

const ANCHORED_CLAIM_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The id of a claim's anchor on the site (`claim-<id>`, spec v2 #4 R17), or null when the id is
 * not one an HTML id and a URL fragment can carry as written; such a claim links to its section.
 */
export function claimAnchor(claimId: string): string | null {
  return ANCHORED_CLAIM_ID.test(claimId) ? `claim-${claimId}` : null;
}

/**
 * Every link an answer may carry (R19): a feature page or the About article, optionally at one of
 * its claims or sections. The server builds links from handles; the client refuses anything else.
 */
export const ASK_HREF =
  /^\/(wiki\/[a-z0-9-]{1,64}\/|special\/about\/)(#claim-[A-Za-z0-9_-]{1,64}|#[a-z-]{1,32})?$/;

const codePoints = (text: string) => [...text].length;

/** A string of `min` to `max` code points. */
const sized = (min: number, max: number) =>
  z
    .string()
    .refine(
      (text) => codePoints(text) >= min && codePoints(text) <= max,
      `expected ${min} to ${max} characters`,
    );

/** One question from the sidebar: its text, the page the reader is on, and "Ask again". */
export const AskRequest = z.strictObject({
  question: z
    .string()
    .trim()
    .refine(
      (q) => q.length > 0 && codePoints(q) <= ASK_QUESTION_MAX_LENGTH,
      `expected a question of 1 to ${ASK_QUESTION_MAX_LENGTH} characters`,
    ),
  /**
   * A feature id or "special:about", at most ASK_PAGE_MAX_LENGTH characters (it comes from the
   * browser); anything that resolves to no page is ignored.
   */
  page: z.string().max(ASK_PAGE_MAX_LENGTH).nullable().default(null),
  /** True bypasses the answer cache. */
  fresh: z.boolean().default(false),
});
export type AskRequest = z.infer<typeof AskRequest>;

/** One progress event while a question is answered: a search, or a page being read. */
export const AskProgress = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("search"), query: sized(0, ASK_SUMMARY_MAX_LENGTH) }),
  z.strictObject({
    step: z.literal("read"),
    pageId: z.string().min(1).max(64),
    title: sized(0, ASK_TITLE_MAX_LENGTH),
  }),
]);
export type AskProgress = z.infer<typeof AskProgress>;

/** A claim an answer cites, numbered in order of first citation. */
export const AskSource = z.strictObject({
  n: z.number().int().min(1),
  pageId: z.string().min(1).max(64),
  pageTitle: sized(1, ASK_TITLE_MAX_LENGTH),
  /** The claim's section key, and its title; null for neither. */
  section: z.string().max(32).nullable(),
  sectionTitle: sized(1, 64).nullable(),
  claimId: z.string().min(1).max(64),
  href: z.string().regex(ASK_HREF, "expected a page, claim or section link"),
  /** The first ASK_EXCERPT_LENGTH code points of the claim as plain text. */
  excerpt: sized(1, ASK_EXCERPT_LENGTH),
});
export type AskSource = z.infer<typeof AskSource>;

export const AskAnswerStatus = z.enum(["answered", "partial", "not-found", "budget", "error"]);
export type AskAnswerStatus = z.infer<typeof AskAnswerStatus>;

/**
 * One answer as the sidebar shows it (spec v2 #4 §5.1): sentences, each citing 1 to 4 sources by
 * number; the sources; up to three pages to read next; and what it cost. A not-found answer is
 * the one fixed sentence with no source; budget and error answers have no sentence.
 */
export const AskResponse = z
  .strictObject({
    status: AskAnswerStatus,
    question: sized(1, ASK_QUESTION_MAX_LENGTH),
    head: GitSha,
    sentences: z
      .array(
        z.strictObject({
          text: sized(1, ASK_SENTENCE_MAX_LENGTH),
          sources: z.array(z.number().int().min(1)).max(ASK_MAX_SENTENCE_SOURCES),
        }),
      )
      .max(ASK_MAX_SENTENCES),
    sources: z.array(AskSource).max(ASK_MAX_SOURCES),
    readNext: z
      .array(
        z.strictObject({
          pageId: z.string().min(1).max(64),
          title: sized(1, ASK_TITLE_MAX_LENGTH),
          href: z.string().regex(ASK_HREF, "expected a page link"),
          summary: sized(0, ASK_SUMMARY_MAX_LENGTH),
        }),
      )
      .max(ASK_MAX_READ_NEXT),
    /** Sentences dropped by validation. */
    refused: z.number().int().min(0),
    cached: z.boolean(),
    answeredAt: IsoDateTime,
    cost: z.strictObject({
      turns: z.number().int().min(0),
      usd: z.number().min(0).nullable(),
      model: z.string().min(1).nullable(),
    }),
  })
  .superRefine((response, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    response.sources.forEach((source, i) => {
      if (source.n !== i + 1) issue(`expected source ${i + 1}`, ["sources", i, "n"]);
    });
    const cited = new Set<number>();
    response.sentences.forEach((sentence, i) => {
      if (new Set(sentence.sources).size !== sentence.sources.length)
        issue("cites a source twice", ["sentences", i, "sources"]);
      for (const n of sentence.sources) {
        if (n > response.sources.length) issue(`no source ${n}`, ["sentences", i, "sources"]);
        cited.add(n);
      }
    });
    response.sources.forEach((source, i) => {
      if (!cited.has(source.n)) issue("no sentence cites it", ["sources", i]);
    });
    const { status, sentences } = response;
    if (status === "answered" || status === "partial") {
      if (sentences.length === 0) issue(`a ${status} answer needs a sentence`, ["sentences"]);
      sentences.forEach((sentence, i) => {
        if (sentence.sources.length === 0) issue("cites no source", ["sentences", i, "sources"]);
      });
    } else if (status === "not-found") {
      if (
        sentences.length !== 1 ||
        sentences[0]?.text !== NOT_FOUND_SENTENCE ||
        sentences[0].sources.length !== 0
      )
        issue(`a not-found answer is the one sentence "${NOT_FOUND_SENTENCE}"`, ["sentences"]);
    } else if (sentences.length > 0) issue(`a ${status} answer has no sentence`, ["sentences"]);
  });
export type AskResponse = z.infer<typeof AskResponse>;

/**
 * What GET /api/ask/status answers: the sidebar answers questions, or only routes them through
 * Pagefind (no key, --no-ask, or a session that cannot afford another question).
 */
export const AskStatus = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("answer"),
    head: GitSha,
    model: z.string().min(1),
    questionUsd: z.number().positive(),
    sessionLeftUsd: z.number().min(0),
  }),
  z.strictObject({
    mode: z.literal("routing"),
    head: GitSha,
    reason: z.enum(["no-key", "disabled", "budget"]),
  }),
]);
export type AskStatus = z.infer<typeof AskStatus>;
