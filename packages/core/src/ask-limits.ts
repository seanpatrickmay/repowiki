// The Ask sidebar's limits (spec v2 #4 section 5.1), with no zod, so the browser's answer guard
// (packages/site/src/client/ask-render.ts) checks the very numbers AskResponse does.

/** The longest question the sidebar takes, in code points after trimming (spec v2 #4 section 5.1). */
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
/** The longest page id or claim id an answer names, section key, and section title. */
export const ASK_ID_MAX_LENGTH = 64;
export const ASK_SECTION_MAX_LENGTH = 32;
export const ASK_SECTION_TITLE_MAX_LENGTH = 64;

/**
 * Every link an answer may carry (R19): a feature page or the About article, optionally at one of
 * its claims or sections. The server builds links from handles; the client refuses anything else,
 * with this very pattern. M11 widens it to person pages.
 */
export const ASK_HREF =
  /^\/(wiki\/[a-z0-9-]{1,64}\/|special\/about\/)(#claim-[A-Za-z0-9_-]{1,64}|#[a-z-]{1,32})?$/;

/** A not-found answer's one sentence: fixed server text, never the model's (spec v2 #4 R26). */
export const NOT_FOUND_SENTENCE = "The wiki does not cover this.";
