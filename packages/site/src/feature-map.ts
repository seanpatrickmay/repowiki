import { finalTarget, type SiteModel } from "./model.ts";
import { articleUrl } from "./urls.ts";

/** Characters that stay as they are inside a quoted Mermaid label. */
const LITERAL = /^[\p{L}\p{M}\p{N}]$/u;
const LITERAL_PUNCTUATION = new Set([".", ",", "-", "_", "/", "+", "!", "?", "@", "*"]);
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
    else if (LITERAL.test(char) || LITERAL_PUNCTUATION.has(char)) out += char;
    else out += NAMED_ENTITIES[char] ?? `#${char.codePointAt(0)};`;
  }
  return out.replace(/ +/g, " ").trim();
}

/**
 * Main Page feature map (F10): one clickable node per active article, one undirected edge per
 * pair of articles that list each other, or one the other, in See also. Null when empty.
 * Labels come from feature titles (untrusted) through `mermaidLabel`; the only other text is
 * node ids and `articleUrl(id)` for feature ids, which the export schema limits to kebab-case.
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
  const edges = new Set<string>();
  for (const id of ids) {
    for (const listed of site.pages.get(id)?.seeAlso ?? []) {
      // A link to a merged feature leads to the article it was merged into.
      const other = finalTarget(site, listed);
      if (!node.has(other) || other === id) continue;
      const [a, b] = [id, other].sort();
      edges.add(`  ${node.get(a as string)} --- ${node.get(b as string)}`);
    }
  }
  lines.push(...[...edges].sort());
  for (const id of ids) lines.push(`  click ${node.get(id)} "${articleUrl(id)}"`);
  return lines.join("\n");
}
