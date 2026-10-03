import { finalTarget, type SiteModel } from "./model.ts";
import { articleUrl } from "./urls.ts";

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

/**
 * Main Page feature map (F10): one clickable node per active article, and one undirected edge per
 * pair of articles joined by the project article's cross-feature edges (F27, real calls and
 * imports) when the export has one, else per pair that lists each other, or one the other, in
 * See also. Null when empty. Labels come from feature titles (untrusted) through `mermaidLabel`;
 * the only other text is node ids and `articleUrl(id)` for feature ids, which the export schema
 * limits to kebab-case.
 */
export function featureMapSource(site: SiteModel): string | null {
  const ids = [...site.pages.keys()]
    .filter((id) => site.features.get(id)?.status.kind === "active")
    .sort();
  if (ids.length === 0) return null;
  const node = new Map(ids.map((id, index) => [id, `n${index}`]));
  const lines = ["flowchart LR"];
  for (const id of ids) {
    const label = mermaidLabel(site.features.get(id)?.title ?? id);
    lines.push(`  ${node.get(id)}["${label === "" ? id : label}"]`);
  }
  const pairs: [string, string][] =
    site.architecture !== null
      ? site.architecture.edges.map((edge) => [edge.from, edge.to])
      : ids.flatMap((id) =>
          (site.pages.get(id)?.seeAlso ?? []).map((listed): [string, string] => [id, listed]),
        );
  const edges = new Set<string>();
  for (const [x, y] of pairs) {
    // A link to a merged feature leads to the article it was merged into.
    const [a, b] = [finalTarget(site, x), finalTarget(site, y)].sort();
    if (a === undefined || b === undefined || a === b || !node.has(a) || !node.has(b)) continue;
    edges.add(`  ${node.get(a)} --- ${node.get(b)}`);
  }
  lines.push(...[...edges].sort());
  for (const id of ids) lines.push(`  click ${node.get(id)} "${articleUrl(id)}"`);
  return lines.join("\n");
}

/** What the feature map's lines mean, for its caption. */
export function featureMapCaption(site: SiteModel): string {
  return site.architecture !== null
    ? "Each box is an article; a line joins two articles when code in one calls or imports code in the other."
    : "Each box is an article; a line joins two articles when one lists the other under See also.";
}
