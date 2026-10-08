import { z } from "zod";
import {
  ASK_EXCERPT_LENGTH,
  ASK_HREF,
  ASK_ID_MAX_LENGTH,
  ASK_MAX_READ_NEXT,
  ASK_MAX_SENTENCE_SOURCES,
  ASK_MAX_SENTENCES,
  ASK_MAX_SOURCES,
  ASK_PAGE_MAX_LENGTH,
  ASK_QUESTION_MAX_LENGTH,
  ASK_SECTION_MAX_LENGTH,
  ASK_SECTION_TITLE_MAX_LENGTH,
  ASK_SENTENCE_MAX_LENGTH,
  ASK_SUMMARY_MAX_LENGTH,
  ASK_TITLE_MAX_LENGTH,
  citedInOrder,
  hrefFits,
  NOT_FOUND_SENTENCE,
} from "./ask-limits.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";

export {
  ASK_EXCERPT_LENGTH,
  ASK_HREF,
  ASK_ID_MAX_LENGTH,
  ASK_MAX_READ_NEXT,
  ASK_MAX_SENTENCE_SOURCES,
  ASK_MAX_SENTENCES,
  ASK_MAX_SOURCES,
  ASK_PAGE_MAX_LENGTH,
  ASK_QUESTION_MAX_LENGTH,
  ASK_SECTION_MAX_LENGTH,
  ASK_SECTION_TITLE_MAX_LENGTH,
  ASK_SENTENCE_MAX_LENGTH,
  ASK_SUMMARY_MAX_LENGTH,
  ASK_TITLE_MAX_LENGTH,
  citedInOrder,
  hrefFits,
  NOT_FOUND_SENTENCE,
} from "./ask-limits.ts";

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
    pageId: z.string().min(1).max(ASK_ID_MAX_LENGTH),
    title: sized(0, ASK_TITLE_MAX_LENGTH),
  }),
]);
export type AskProgress = z.infer<typeof AskProgress>;

/** A claim an answer cites, numbered in order of first citation. */
export const AskSource = z.strictObject({
  n: z.number().int().min(1),
  pageId: z.string().min(1).max(ASK_ID_MAX_LENGTH),
  pageTitle: sized(1, ASK_TITLE_MAX_LENGTH),
  /** The claim's section key, and its title; null for neither. */
  section: z.string().max(ASK_SECTION_MAX_LENGTH).nullable(),
  sectionTitle: sized(1, ASK_SECTION_TITLE_MAX_LENGTH).nullable(),
  claimId: z.string().min(1).max(ASK_ID_MAX_LENGTH),
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
          pageId: z.string().min(1).max(ASK_ID_MAX_LENGTH),
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
      if (!hrefFits(source.href, source.pageId, source.claimId))
        issue("links somewhere else than its page and claim", ["sources", i, "href"]);
    });
    response.readNext.forEach((page, i) => {
      if (!hrefFits(page.href, page.pageId, null))
        issue("links somewhere else than its page", ["readNext", i, "href"]);
    });
    if (!citedInOrder(response.sentences))
      issue("sources are not numbered in order of first citation", ["sources"]);
    const cited = new Set<number>();
    response.sentences.forEach((sentence, i) => {
      if (sentence.text.trim() === "") issue("is blank", ["sentences", i, "text"]);
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
