import type { Feature, Manifest } from "@repowiki/core";

/**
 * A link token as claim text writes it: [[target]] or [[target|label]] (spec §7.3, §5 rule 11).
 * This is character for character the site's own token (packages/site/src/inline.ts): the
 * target holds no ] or |, the label no ], so a label ends at the first ] and `|` in a label is
 * just text.
 */
export const LINK_TOKEN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
/**
 * One left-to-right pass over a code span or a link token, as the site reads claim text. Code
 * spans and links must be found in the same pass: a link label may hold backticks, and the site
 * renders such a token as a link, so splitting on code spans first would hide it from the linker.
 */
const INLINE_TOKEN = new RegExp(`\`[^\`]+\`|${LINK_TOKEN.source}`, "g");

/**
 * The site deletes these two private-use characters from claim text before it reads any token
 * (packages/site/src/inline.ts), so `[<U+E000>[wp:X]]` is a link there. Read text the same way.
 */
const PLACEHOLDER_CHARS = /[\ue000\ue001]/g;

/** Every link token in a text that the reader renders as a link (none inside code spans). */
export function linkTokensIn(text: string): { target: string; label: string | undefined }[] {
  const tokens: { target: string; label: string | undefined }[] = [];
  for (const [, target, label] of text.replace(PLACEHOLDER_CHARS, "").matchAll(INLINE_TOKEN)) {
    if (target !== undefined) tokens.push({ target: target.trim(), label: label?.trim() });
  }
  return tokens;
}

/**
 * Wikipedia's form of a title for comparing and caching: spaces for underscores, runs of
 * whitespace collapsed, the first letter upper case (Wikipedia ignores its case).
 */
export function normalizeWikipediaTitle(title: string): string {
  const spaced = title.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return spaced === "" ? "" : `${spaced[0]?.toUpperCase()}${spaced.slice(1)}`;
}

/** Every [[wp:Title]] in a text outside code spans, normalized. */
export function wikipediaTitlesIn(text: string): string[] {
  const titles: string[] = [];
  for (const { target } of linkTokensIn(text)) {
    if (target.startsWith("wp:")) {
      const title = normalizeWikipediaTitle(target.slice(3));
      if (title !== "") titles.push(title);
    }
  }
  return titles;
}

/**
 * Finds the page a link target means: a feature id, title or alias (case-insensitive), followed
 * through redirects to the final feature. A retired feature has no current page, so it is not a
 * target; a disambiguation page is.
 */
export function createTargetResolver(manifest: Manifest): (target: string) => Feature | null {
  const byId = new Map(manifest.features.map((f) => [f.id, f]));
  // A name goes to an active feature before any other, a retired one last; ties go to the
  // smallest id, so manifest order never decides a link.
  const rank = (f: Feature): number =>
    f.status.kind === "retired" ? 2 : f.status.kind === "active" ? 0 : 1;
  const better = (f: Feature, than: Feature): boolean =>
    rank(f) - rank(than) < 0 || (rank(f) === rank(than) && f.id < than.id);
  const byName = new Map<string, Feature>();
  for (const feature of manifest.features) {
    for (const name of [feature.title, ...feature.aliases]) {
      const key = name.trim().toLowerCase();
      const held = byName.get(key);
      if (held === undefined || better(feature, held)) byName.set(key, feature);
    }
  }
  const final = (feature: Feature): Feature | null => {
    const seen = new Set<string>();
    let current: Feature | undefined = feature;
    while (current?.status.kind === "redirect") {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      current = byId.get(current.status.to);
    }
    return current === undefined || current.status.kind === "retired" ? null : current;
  };
  return (target) => {
    const found = byId.get(target.trim()) ?? byName.get(target.trim().toLowerCase());
    return found === undefined ? null : final(found);
  };
}

/**
 * Words that replace a dropped link. Claim text is untrusted: brackets and backticks are
 * removed so the words can never join their neighbours into a new token or code span (a freed
 * backtick pairing with a later one would uncover a token the linker left alone as code).
 */
const plainWords = (words: string): string => words.replace(/[[\]`]/g, "");

/**
 * Rewrites the link tokens of one page's claims, in page order (spec §7.3). A token for a known
 * feature becomes [[id]] or [[id|words]]; a page links each concept on its first mention only;
 * a link to the page itself, to an unknown target, or to a Wikipedia title that did not check
 * out becomes its plain words. `wikipedia` maps each normalized title to the title to link
 * (Wikipedia's canonical one), or to null when the link must become plain text.
 */
export function createPageLinker(
  manifest: Manifest,
  pageId: string,
  wikipedia: ReadonlyMap<string, string | null>,
): (text: string) => string {
  const resolve = createTargetResolver(manifest);
  const titles = new Map(manifest.features.map((f) => [f.id, f.title]));
  const linked = new Set<string>();
  const rewrite = (rawTarget: string, rawLabel: string | undefined): string => {
    const target = rawTarget.trim();
    // Like the site, an empty label is no label.
    const label = rawLabel?.trim() || undefined;
    if (target.startsWith("wp:")) {
      const requested = normalizeWikipediaTitle(target.slice(3));
      const words = (label ?? target.slice(3).trim()).replace(/]/g, "");
      const canonical = wikipedia.get(requested) ?? null;
      if (canonical === null || linked.has(`wp:${canonical}`)) return plainWords(words);
      linked.add(`wp:${canonical}`);
      return words === canonical ? `[[wp:${canonical}]]` : `[[wp:${canonical}|${words}]]`;
    }
    const feature = resolve(target);
    // An id shows as the title of the feature it names, even when that feature redirects.
    const words = (label ?? titles.get(target) ?? target).replace(/]/g, "");
    if (feature === null || feature.id === pageId || linked.has(feature.id)) {
      return plainWords(words);
    }
    linked.add(feature.id);
    if (label === undefined && target === feature.id) return `[[${feature.id}]]`;
    return words === "" ? `[[${feature.id}]]` : `[[${feature.id}|${words}]]`;
  };
  return (text) =>
    text
      .replace(PLACEHOLDER_CHARS, "")
      .replace(INLINE_TOKEN, (match, target: string | undefined, label?: string) =>
        target === undefined ? match : rewrite(target, label),
      );
}
