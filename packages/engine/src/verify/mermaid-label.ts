/*
 * The first block below is a character-for-character copy of `mermaidLabel` and its constants from
 * packages/site/src/feature-map.ts (the engine may not import the site). The two MUST stay
 * identical: mermaid-label.test.ts compares their source text and their output. The diagram
 * check accepts a label only if this function would have written it, so the engine's allowlist
 * is exactly what the site's escaper produces.
 */

/** Characters that stay as they are inside a quoted Mermaid label. */
const LITERAL = /^[\p{L}\p{M}\p{N}]$/u;
const LITERAL_PUNCTUATION = new Set([".", ",", "-", "_", "/", "+", "!", "?", "@", "*"]);
/**
 * The letters of Mermaid's entity placeholders (U+FB02 U+00B0 U+00B0 code U+00B6 U+00DF, which it
 * decodes after parsing): written as entities, so a label cannot forge one. Degree and pilcrow
 * are not letters, so they already are.
 */
const PLACEHOLDER_LETTERS = new Set(["\u00DF", "\uFB02"]);
/** Control characters and every kind of space and line break: each becomes one space. */
const SPACING = /^[\p{Cc}\p{Z}]$/u;
/** Private-use, format (zero-width, bidi), unassigned and lone-surrogate characters: dropped. */
const DROPPED = /^[\p{Co}\p{Cf}\p{Cn}\p{Cs}]$/u;
const NAMED_ENTITIES: Record<string, string> = {
  '"': "#quot;",
  "&": "#amp;",
  "<": "#lt;",
  ">": "#gt;",
};

/**
 * Makes untrusted text safe to put between the quotes of a Mermaid node label. Mermaid reads
 * `#quot;` and `#59;` as entity codes and shows the character they name, so every character that
 * could mean something to Mermaid's parser (quotes, brackets, `;`, `%%` comments, `#`, markup)
 * is written as an entity, line breaks cannot start a new statement such as `click`, and
 * invisible characters are dropped. Letters, digits and a few plain punctuation marks stay as
 * they are. The result never contains a quote, so it cannot end the label early.
 */
export function mermaidLabel(text: string): string {
  let out = "";
  for (const char of text) {
    if (SPACING.test(char)) out += " ";
    else if (DROPPED.test(char)) continue;
    else if (
      LITERAL_PUNCTUATION.has(char) ||
      (LITERAL.test(char) && !PLACEHOLDER_LETTERS.has(char))
    )
      out += char;
    else out += NAMED_ENTITIES[char] ?? `#${char.codePointAt(0)};`;
  }
  return out.replace(/ +/g, " ").trim();
}

const NAMED_CHARACTERS = new Map(
  Object.entries(NAMED_ENTITIES).map(([char, entity]) => [entity, char]),
);
const ENTITY = /#(?:(\d{1,7})|[a-z]+);/y;

/**
 * Undoes mermaidLabel's entities: the named ones in NAMED_ENTITIES and `#<decimal>;` (a code point
 * up to U+10FFFF). Null when the label holds a `#` that starts anything else (a bare `#`, an
 * unknown name, a hex reference, a code point beyond Unicode), so it cannot be a label
 * mermaidLabel wrote.
 */
export function decodeMermaidEntities(label: string): string | null {
  let out = "";
  for (let i = 0; i < label.length; ) {
    if (label[i] !== "#") {
      const char = String.fromCodePoint(label.codePointAt(i) ?? 0);
      out += char;
      i += char.length;
      continue;
    }
    ENTITY.lastIndex = i;
    const match = ENTITY.exec(label);
    if (match === null) return null;
    const [entity = "", decimal] = match;
    if (decimal !== undefined) {
      const codePoint = Number(decimal);
      if (codePoint > 0x10ffff) return null;
      out += String.fromCodePoint(codePoint);
    } else {
      const char = NAMED_CHARACTERS.get(entity);
      if (char === undefined) return null;
      out += char;
    }
    i += entity.length;
  }
  return out;
}
