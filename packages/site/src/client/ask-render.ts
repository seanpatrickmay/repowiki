/// <reference lib="dom" />
// The Ask sidebar's rendering (spec v2 #4 R19, §9.3): an answer's JSON is checked by hand (no
// zod in the browser), every piece of text is set with textContent, and a link is made only when
// its href matches SAFE_HREF. Nothing from an answer or a Pagefind excerpt is parsed as HTML.
import type { AskProgress, AskResponse } from "@repowiki/core";
import {
  ASK_EXCERPT_LENGTH,
  ASK_HREF,
  ASK_ID_MAX_LENGTH,
  ASK_MAX_READ_NEXT,
  ASK_MAX_SENTENCE_SOURCES,
  ASK_MAX_SENTENCES,
  ASK_MAX_SOURCES,
  ASK_QUESTION_MAX_LENGTH,
  ASK_SECTION_MAX_LENGTH,
  ASK_SECTION_TITLE_MAX_LENGTH,
  ASK_SENTENCE_MAX_LENGTH,
  ASK_SUMMARY_MAX_LENGTH,
  ASK_TITLE_MAX_LENGTH,
  citedInOrder,
  hrefFits,
  NOT_FOUND_SENTENCE,
} from "@repowiki/core/ask-limits";

/** A person page and its anchors: Pagefind lists them, but a served answer never cites one (C9). */
const PERSON_HREF = /^\/people\/[a-z0-9-]{1,64}\/(#claim-[A-Za-z0-9_-]{1,64}|#[a-z-]{1,32})?$/;

/**
 * The links an answer or a route may carry (R19): core's ASK_HREF (a feature page or the About
 * article, at one of its claims or sections), or a person page (spec v2 #6 §11: Pagefind finds
 * them by name). Anything else is shown as plain text.
 */
export const SAFE_HREF = new RegExp(`${ASK_HREF.source}|${PERSON_HREF.source}`);

/** The href, or null when it is not one SAFE_HREF admits. */
export const safeHref = (href: unknown): string | null =>
  typeof href === "string" && SAFE_HREF.test(href) ? href : null;

/** The slice of a DOM node the renderer builds, so a test can stand in for the browser. */
export interface AskNode {
  textContent: string | null;
  className: string;
  append(...nodes: (AskNode | string)[]): void;
  setAttribute(name: string, value: string): void;
}

/** The slice of `document` the renderer uses: element creation only. */
export interface AskDocument {
  createElement(tag: string): AskNode;
}

const STATUSES = new Set(["answered", "partial", "not-found", "budget", "error"]);
const codePoints = (text: string) => [...text].length;
const isText = (value: unknown, max: number, min = 0): value is string =>
  typeof value === "string" && codePoints(value) >= min && codePoints(value) <= max;
const isInt = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isList = (value: unknown, max: number): value is unknown[] =>
  Array.isArray(value) && value.length <= max;

/**
 * An answer from the server, or null when it is not the shape core's AskResponse gives it (spec
 * v2 #4 section 9.3), by hand and with core's own limits (`@repowiki/core/ask-limits`, which
 * holds no zod): types, lengths and index ranges, and AskResponse's cross-field rules (sources
 * numbered in order of first citation, each cited, none cited twice by a sentence, each linked
 * into its own page and claim; no blank sentence; an answered or partial answer's
 * sentences each cite one; not-found is the one fixed sentence; budget and error have none). The
 * renderer shows nothing it refuses.
 */
export function guardResponse(value: unknown): AskResponse | null {
  if (!isRecord(value) || !STATUSES.has(value.status as string)) return null;
  if (
    !isText(value.question, ASK_QUESTION_MAX_LENGTH, 1) ||
    typeof value.head !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.head)
  )
    return null;
  const sources = value.sources;
  if (!isList(sources, ASK_MAX_SOURCES)) return null;
  const sourcesOk = sources.every(
    (s, i) =>
      isRecord(s) &&
      s.n === i + 1 &&
      isText(s.pageId, ASK_ID_MAX_LENGTH, 1) &&
      isText(s.pageTitle, ASK_TITLE_MAX_LENGTH, 1) &&
      (s.section === null || isText(s.section, ASK_SECTION_MAX_LENGTH)) &&
      (s.sectionTitle === null || isText(s.sectionTitle, ASK_SECTION_TITLE_MAX_LENGTH, 1)) &&
      isText(s.claimId, ASK_ID_MAX_LENGTH, 1) &&
      typeof s.href === "string" &&
      hrefFits(s.href, s.pageId, s.claimId) &&
      isText(s.excerpt, ASK_EXCERPT_LENGTH, 1),
  );
  const sentences = value.sentences;
  if (!sourcesOk || !isList(sentences, ASK_MAX_SENTENCES)) return null;
  const sentencesOk = sentences.every(
    (s) =>
      isRecord(s) &&
      isText(s.text, ASK_SENTENCE_MAX_LENGTH, 1) &&
      s.text.trim() !== "" &&
      isList(s.sources, ASK_MAX_SENTENCE_SOURCES) &&
      s.sources.every((n) => isInt(n, 1) && n <= sources.length) &&
      new Set(s.sources).size === s.sources.length,
  );
  if (!sentencesOk) return null;
  const cited = sentences as { text: string; sources: number[] }[];
  if (!citedInOrder(cited)) return null;
  const citedSet = new Set(cited.flatMap((s) => s.sources));
  if (sources.some((_s, i) => !citedSet.has(i + 1))) return null;
  const status = value.status;
  const shapeOk =
    status === "answered" || status === "partial"
      ? cited.length > 0 && cited.every((s) => s.sources.length > 0)
      : status === "not-found"
        ? cited.length === 1 &&
          cited[0]?.text === NOT_FOUND_SENTENCE &&
          cited[0].sources.length === 0
        : cited.length === 0;
  const readNext = value.readNext;
  if (!shapeOk || !isList(readNext, ASK_MAX_READ_NEXT)) return null;
  const readNextOk = readNext.every(
    (r) =>
      isRecord(r) &&
      isText(r.pageId, ASK_ID_MAX_LENGTH, 1) &&
      isText(r.title, ASK_TITLE_MAX_LENGTH, 1) &&
      typeof r.href === "string" &&
      hrefFits(r.href, r.pageId, null) &&
      isText(r.summary, ASK_SUMMARY_MAX_LENGTH),
  );
  const cost = value.cost;
  if (
    !readNextOk ||
    !isInt(value.refused, 0) ||
    typeof value.cached !== "boolean" ||
    !isText(value.answeredAt, 40, 1) ||
    !isRecord(cost) ||
    !isInt(cost.turns, 0) ||
    !(cost.usd === null || (Number.isFinite(cost.usd) && (cost.usd as number) >= 0)) ||
    !(cost.model === null || isText(cost.model, 100, 1))
  )
    return null;
  return value as unknown as AskResponse;
}

/** A progress event, or null when it is not one: the client ignores what it does not know. */
export function guardProgress(value: unknown): AskProgress | null {
  if (!isRecord(value)) return null;
  if (value.step === "search" && isText(value.query, 200)) return value as AskProgress;
  if (value.step === "read" && isText(value.pageId, 64, 1) && isText(value.title, 200))
    return value as AskProgress;
  return null;
}

/** What the live region says while a question is answered. */
export function progressText(progress: AskProgress): string {
  return progress.step === "search"
    ? `Searching for \u201C${progress.query}\u201D\u2026`
    : `Reading ${progress.title}\u2026`;
}

/** Text with each backtick span as a <code> node, every part set as text. */
function codeText(doc: AskDocument, parent: AskNode, text: string): void {
  text.split(/(`[^`]+`)/).forEach((part) => {
    if (part === "") return;
    if (/^`[^`]+`$/.test(part)) {
      const code = doc.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.append(code);
    } else parent.append(part);
  });
}

/**
 * A link when the href is safe, with (unless `preview` is false) a hover preview of the feature
 * page it goes to, read from the href itself so the preview is always the link's page; else
 * plain text.
 */
function link(doc: AskDocument, href: unknown, text: string, preview = true): AskNode {
  const safe = safeHref(href);
  const node = doc.createElement(safe === null ? "span" : "a");
  if (safe !== null) {
    node.setAttribute("href", safe);
    const page = /^\/wiki\/([a-z0-9-]{1,64})\//.exec(safe)?.[1];
    if (preview && page !== undefined) node.setAttribute("data-preview", page);
  }
  node.textContent = text;
  return node;
}

/** The footer line: "Answered from the wiki at 7247d28 · 2 turns · $0.0098" (or "· cached"). */
export function footerText(response: AskResponse): string {
  const turns = `${response.cost.turns} turn${response.cost.turns === 1 ? "" : "s"}`;
  const cost = response.cached
    ? "cached"
    : `${turns} \u00B7 ${response.cost.usd === null ? "cost unknown" : `$${response.cost.usd.toFixed(4)}`}`;
  return `Answered from the wiki at ${response.head.slice(0, 7)} \u00B7 ${cost}`;
}

/** What the panel says for an answer that has no sentence to show. */
const NOTE: Partial<Record<AskResponse["status"], string>> = {
  budget: "This question would pass the spending cap set for this session, so it was not asked.",
  error: "The question could not be answered.",
};

/**
 * One answer as the panel shows it (spec v2 #4 §2): its sentences, each followed by numbered
 * marks linking to the claims it cites; the Sources list (page title › section, the claim's
 * excerpt); Read next; and the footer. Text is set with textContent only.
 */
export function renderAnswer(doc: AskDocument, response: AskResponse): AskNode {
  const root = doc.createElement("div");
  root.className = "ask-answer";
  const note = NOTE[response.status];
  if (note !== undefined) {
    const p = doc.createElement("p");
    p.className = "ask-note";
    p.textContent = note;
    root.append(p);
  }
  for (const sentence of response.sentences) {
    const p = doc.createElement("p");
    codeText(doc, p, sentence.text);
    for (const n of sentence.sources) {
      const source = response.sources[n - 1];
      const mark = link(doc, source?.href, `[${n}]`);
      mark.className = "ask-mark";
      p.append(mark);
    }
    root.append(p);
  }
  if (response.sources.length > 0) {
    const heading = doc.createElement("h3");
    heading.textContent = "Sources";
    const list = doc.createElement("ol");
    list.className = "ask-sources";
    for (const source of response.sources) {
      const item = doc.createElement("li");
      const where =
        source.sectionTitle === null
          ? source.pageTitle
          : `${source.pageTitle} \u203A ${source.sectionTitle}`;
      item.append(link(doc, source.href, where));
      const excerpt = doc.createElement("div");
      excerpt.className = "ask-excerpt";
      codeText(doc, excerpt, source.excerpt);
      item.append(excerpt);
      list.append(item);
    }
    root.append(heading, list);
  }
  if (response.readNext.length > 0) {
    const heading = doc.createElement("h3");
    heading.textContent = "Read next";
    const list = doc.createElement("ul");
    list.className = "ask-read-next";
    for (const page of response.readNext) {
      const item = doc.createElement("li");
      item.append(link(doc, page.href, page.title));
      if (page.summary !== "") item.append(` \u2014 ${page.summary}`);
      list.append(item);
    }
    root.append(heading, list);
  }
  const footer = doc.createElement("p");
  footer.className = "ask-footer";
  footer.textContent = footerText(response);
  root.append(footer);
  return root;
}

/**
 * The most characters (UTF-16 code units, as decoded) of one answer's event stream the client
 * reads (spec v2 #4 §9.3).
 */
export const MAX_STREAM_CHARS = 64 * 1024;

/** One Server-Sent Event: its name and its data lines joined. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Reads Server-Sent Events from text chunks however they were split: a frame ends at a blank
 * line; `event:` and `data:` fields are read and comments and other fields ignored. Past
 * MAX_STREAM_CHARS in all, `feed` throws.
 */
export function sseReader(): { feed(chunk: string): SseEvent[] } {
  let buffer = "";
  let seen = 0;
  return {
    feed(chunk) {
      seen += chunk.length;
      if (seen > MAX_STREAM_CHARS) throw new Error("the answer stream is too long");
      buffer += chunk;
      const events: SseEvent[] = [];
      for (;;) {
        // A frame ends at a blank line: two line ends of any kind (CRLF, LF or CR) in a row. A CR
        // at the very end may be the first half of a CRLF still to come, so it waits.
        const end = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(buffer);
        if (end === null) break;
        if (end.index + end[0].length === buffer.length && buffer.endsWith("\r")) break;
        const frame = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split(/\r\n|\n|\r/)) {
          const colon = line.indexOf(":");
          if (colon === 0) continue;
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        if (data.length > 0) events.push({ event, data: data.join("\n") });
      }
      return events;
    },
  };
}

/** HTML character references a Pagefind excerpt may hold, decoded to text. */
const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
};

/**
 * A Pagefind excerpt as text and marked parts (spec v2 #4 R19): only an exact `<mark>…</mark>`
 * is kept as a mark; every other tag is dropped and the rest decoded to text.
 */
export function excerptParts(html: string): { text: string; mark: boolean }[] {
  const decode = (text: string) =>
    text.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39|#x27);/g, (e) => ENTITIES[e] ?? e);
  return html
    .split(/(<mark>[^<]*<\/mark>)/)
    .filter((part) => part !== "")
    .map((part) => {
      const marked = /^<mark>([^<]*)<\/mark>$/.exec(part);
      return marked === null
        ? { text: decode(part), mark: false }
        : { text: decode(marked[1] ?? ""), mark: true };
    })
    .filter((part) => part.text !== "");
}

/** One Pagefind result as the static fallback lists it: a page and up to two of its sections. */
export interface Route {
  title: string;
  url: string;
  excerpt: string;
  sections: { title: string; url: string; excerpt: string }[];
}

/** A Pagefind excerpt as nodes: text, with its matches as <mark> nodes. */
function excerptNode(doc: AskDocument, html: string): AskNode {
  const node = doc.createElement("div");
  node.className = "ask-excerpt";
  for (const part of excerptParts(html)) {
    if (!part.mark) node.append(part.text);
    else {
      const mark = doc.createElement("mark");
      mark.textContent = part.text;
      node.append(mark);
    }
  }
  return node;
}

/** The static fallback's list of pages that match (spec v2 #4 §4.3). */
export function renderRoutes(doc: AskDocument, routes: readonly Route[]): AskNode {
  const list = doc.createElement("ol");
  list.className = "ask-routes";
  for (const route of routes) {
    const item = doc.createElement("li");
    item.append(link(doc, route.url, route.title, false), excerptNode(doc, route.excerpt));
    for (const section of route.sections.slice(0, 2)) {
      const sub = doc.createElement("div");
      sub.append(link(doc, section.url, section.title, false), excerptNode(doc, section.excerpt));
      item.append(sub);
    }
    list.append(item);
  }
  return list;
}
