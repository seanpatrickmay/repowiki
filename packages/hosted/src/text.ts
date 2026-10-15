import { INVISIBLE_CHARACTERS } from "@repowiki/core";
import { MAX_PARAGRAPHS } from "./content.ts";

const LINK = /\[\[(?:wp:)?([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const PARAGRAPH_BREAK = /\n[ \t]*\n\s*/;

/**
 * Markdown and wiki link tokens as plain words (no hidden characters, no tag openings, at most
 * three paragraphs), cut at a word boundary within `max`.
 */
export function plainWords(markdown: string, max: number): string {
  const text = markdown
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE_CHARACTERS, (c) => (c === "\n" ? c : c === "\t" ? " " : ""))
    .replace(LINK, (_match, target: string, label?: string) => label ?? target.replace(/-/g, " "))
    .replace(/[*`]/g, "")
    .replace(/^[ \t]*(?:#+|>)[ \t]?/gm, "")
    .replace(/<(?=[a-z!/?])/gi, "< ")
    .replace(/[^\S\n]+/g, " ")
    .trim();
  const paragraphs = text.split(PARAGRAPH_BREAK);
  const kept =
    paragraphs.length <= MAX_PARAGRAPHS
      ? text
      : [
          ...paragraphs.slice(0, MAX_PARAGRAPHS - 1),
          paragraphs.slice(MAX_PARAGRAPHS - 1).join(" "),
        ].join("\n\n");
  if (kept.length <= max) return kept;
  const cut = kept.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : kept.slice(0, max)).trim();
}

const BREAK = / (?:that|which|with|using|where|and|to|for) |[,;:] | — /g;
/** Abbreviations whose full stop does not end a sentence when lowercase text follows. */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|cf|incl)\.$/i;

/**
 * Prose split into sentences at ".", "!" or "?" and a space, except after an abbreviation such
 * as "e.g." when the next word starts in lowercase or with a digit (review M6).
 */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/(?<=[.!?])\s+/)) {
    const before = out.at(-1);
    if (before !== undefined && ABBREVIATION.test(before) && /^[\p{Ll}\d]/u.test(part)) {
      out[out.length - 1] = `${before} ${part}`;
    } else if (part !== "") {
      out.push(part);
    }
  }
  return out;
}

/**
 * Prose's first sentence without the full stop, cut when longer than `max` at its last clause
 * ("… that …", "… and …") or comma, colon or dash within the limit, else at a word with an
 * ellipsis. Taglines and the biography's noun phrases are cut this way (ADR-0012, ADR-0013).
 */
export function firstClause(text: string, max: number): string {
  const plain = plainWords(text, 4000).replace(/\s+/g, " ");
  const sentence = (sentencesOf(plain)[0] ?? "").replace(/\.$/, "");
  if (sentence.length <= max) return sentence;
  const head = sentence.slice(0, max);
  const pause = [...head.matchAll(BREAK)].filter((m) => m.index >= 30).at(-1);
  if (pause !== undefined) return head.slice(0, pause.index);
  const cut = head.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[,;:]$/, "")}…`;
}
