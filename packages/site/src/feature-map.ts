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
 * The most lines the map draws from the project article's edges. Mirrors MAX_ARCHITECTURE_EDGES in
 * packages/engine/src/write/architecture-edges.ts (the article diagram's cap), which the site
 * cannot import; it keeps the map well under Mermaid's 500-edge limit.
 */
export const MAX_ARCHITECTURE_EDGES = 80;

/**
 * Main Page feature map (F10): one clickable node per active article, and one undirected edge per
 * pair of articles joined by the project article's cross-feature edges (F27, real calls and
 * imports; the MAX_ARCHITECTURE_EDGES heaviest pairs) when the export has one, else per pair that
 * lists each other, or one the other, in See also. Null when empty. Labels come from feature
 * titles (untrusted) through `mermaidLabel`; the only other text is node ids and `articleUrl(id)`
 * for feature ids, which the export schema limits to kebab-case.
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
  const edges = mapPairs(site, new Set(ids)).map(([a, b]) => `  ${node.get(a)} --- ${node.get(b)}`);
  lines.push(...edges.sort());
  for (const id of ids) lines.push(`  click ${node.get(id)} "${articleUrl(id)}"`);
  return lines.join("\n");
}

/** Two map nodes a line joins, sorted. */
type Pair = readonly [string, string];

/**
 * The pair `x`, `y` joins on the map, sorted, or null when it joins none: a link to a merged
 * feature leads to the article it was merged into, and both ends must be distinct map nodes.
 */
function mapPair(site: SiteModel, nodes: ReadonlySet<string>, x: string, y: string): Pair | null {
  const [a, b] = [finalTarget(site, x), finalTarget(site, y)].sort();
  if (a === undefined || b === undefined || a === b || !nodes.has(a) || !nodes.has(b)) return null;
  return [a, b];
}

/** The distinct pairs of map nodes the map joins, each sorted. */
function mapPairs(site: SiteModel, nodes: ReadonlySet<string>): Pair[] {
  if (site.architecture !== null) {
    // Weight per undirected pair: both directions and every edge through a redirect add up.
    const weighted = new Map<string, { pair: Pair; weight: number }>();
    for (const edge of site.architecture.edges) {
      const pair = mapPair(site, nodes, edge.from, edge.to);
      if (pair === null) continue;
      const key = pair.join(" ");
      const weight = (weighted.get(key)?.weight ?? 0) + edge.imports + edge.calls;
      weighted.set(key, { pair, weight });
    }
    return [...weighted]
      .sort(([p, v], [q, w]) => w.weight - v.weight || (p < q ? -1 : p > q ? 1 : 0))
      .slice(0, MAX_ARCHITECTURE_EDGES)
      .map(([, { pair }]) => pair);
  }
  const seeAlso = new Map<string, Pair>();
  for (const id of nodes) {
    for (const listed of site.pages.get(id)?.seeAlso ?? []) {
      const pair = mapPair(site, nodes, id, listed);
      if (pair !== null) seeAlso.set(pair.join(" "), pair);
    }
  }
  return [...seeAlso.values()];
}

/** What the feature map's lines mean, for its caption. */
export function featureMapCaption(site: SiteModel): string {
  return site.architecture !== null
    ? "Each box is an article; a line joins two articles when code in one calls or imports code in the other."
    : "Each box is an article; a line joins two articles when one lists the other under See also.";
}
