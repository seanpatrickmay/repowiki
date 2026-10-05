import {
  type Architecture,
  aliasSlug,
  type Citation,
  type Feature,
  type Revision,
  type WikiExport,
} from "@repowiki/core";
import { cut, oneLine } from "./text.ts";
import { ToolError } from "./tools.ts";

/** The About article's id for the wiki agent: no feature id has a colon, so none can take it. */
export const ABOUT_PAGE_ID = "special:about";

/** The longest summary a search result or a choice shows, in code points. */
const SUMMARY_LENGTH = 200;

const TOKEN = /`([^`]+)`|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Text with every bracket that would open a reference or page mark made a parenthesis. A `[n]`
 * straight after a letter, digit, `_`, `]` or `)` is an index in prose (`items[0]`, `grid[i][0]`),
 * not a mark: the page puts its own marks after a space, so those stay as written.
 */
const unmark = (text: string) =>
  text
    .replace(/(^|[^\p{L}\p{N}_\])])((?:\[\s*\d+\s*\])+)/gu, (_all, before: string, run: string) => {
      return before + run.replace(/\[\s*(\d+)\s*\]/g, "($1)");
    })
    .replace(/\[(?=\s*pages?\s*:)/giu, "(");

/**
 * A title or an alias for the agent: one line, with every bracket that would open a reference or
 * page mark made a parenthesis, as claim text has (titles are model text too).
 */
export const titleText = (title: string): string => oneLine(unmark(title));

/** A page in a list (search results, choices): its id, title and summary, punctuated once. */
export function listedPage(id: string, title: string, summary: string): string {
  const shown = titleText(title);
  if (summary === "") return `- ${id}: ${shown}`;
  return `- ${id}: ${shown}${/[.!?]$/.test(shown) ? "" : "."} ${summary}`;
}

/** What a page id resolves to. */
export type Resolved =
  | { kind: "page"; featureId: string; from: string | null }
  | { kind: "about" }
  | { kind: "choices"; from: string; targets: string[] };

/**
 * The wiki agent's view of an export: its features and pages, the site's routes, and how a page
 * id the agent gives resolves.
 */
export class WikiView {
  readonly wiki: WikiExport;
  readonly features: ReadonlyMap<string, Feature>;
  readonly pages: ReadonlyMap<string, Revision>;
  readonly article: Architecture | undefined;
  readonly aliasRoutes = new Map<string, string[]>();

  constructor(wiki: WikiExport) {
    this.wiki = wiki;
    this.features = new Map(wiki.manifest.features.map((f) => [f.id, f]));
    this.pages = new Map(wiki.pages.map((p) => [p.featureId, p]));
    this.article = wiki.architecture.at(-1);
    // The site's alias routes, plus each title's slug: a slug with one final target redirects,
    // with more it disambiguates.
    for (const feature of wiki.manifest.features) {
      if (!this.hasRoute(feature.id)) continue;
      const target = this.finalTarget(feature.id);
      for (const alias of [feature.title, ...feature.aliases]) {
        const slug = aliasSlug(alias);
        if (slug === "" || this.features.has(slug)) continue;
        const targets = this.aliasRoutes.get(slug) ?? [];
        if (!targets.includes(target)) targets.push(target);
        this.aliasRoutes.set(slug, targets);
      }
    }
  }

  title(id: string): string {
    return this.features.get(id)?.title ?? id;
  }

  /** True when /wiki/<id>/ is a page on the site: a redirect, a disambiguation, or a stored page. */
  hasRoute(id: string): boolean {
    const kind = this.features.get(id)?.status.kind;
    if (kind === "redirect" || kind === "disambiguation") return true;
    return (kind === "active" || kind === "retired") && this.pages.has(id);
  }

  finalTarget(id: string): string {
    const seen = new Set<string>();
    let current = id;
    for (;;) {
      const status = this.features.get(current)?.status;
      if (status?.kind !== "redirect" || seen.has(current)) return current;
      seen.add(current);
      current = status.to;
    }
  }

  /**
   * Claim text for the agent: links name their page id, so the agent can read it next. Text the
   * claim writes itself that imitates a mark the page adds (a reference `[1]`, `[page: id]`,
   * `[pages: ...]`) has its bracket made a parenthesis, so only the page's own marks look like marks;
   * code spans and indexes in prose (`items[0]`) are left as they are.
   */
  text(claimText: string): string {
    let linked = "";
    let at = 0;
    for (const token of claimText.matchAll(TOKEN)) {
      const [match, code, target = "", label] = token;
      linked += unmark(claimText.slice(at, token.index));
      at = token.index + match.length;
      if (code !== undefined) {
        linked += match;
        continue;
      }
      const id = target.trim();
      const shown = label === undefined || label.trim() === "" ? undefined : unmark(label.trim());
      if (id.startsWith("wp:")) linked += shown ?? unmark(id.slice(3).trim());
      else if (this.hasRoute(id)) linked += `${shown ?? unmark(this.title(id))} [page: ${id}]`;
      else linked += shown ?? unmark(id);
    }
    return oneLine(linked + unmark(claimText.slice(at)));
  }

  /** The first sentence of a page's lead, one line, for search results and choices. */
  summary(id: string): string {
    const lead =
      id === ABOUT_PAGE_ID
        ? this.article?.sections.find((s) => s.key === "lead")?.claims[0]
        : this.pages.get(id)?.sections.find((s) => s.key === "lead")?.claims[0];
    return lead === undefined ? "" : cut(this.text(lead.text), SUMMARY_LENGTH);
  }

  /**
   * Where a page id leads. The id is read as the site reads a path: the "wiki/" prefix and slashes
   * go, and a title or a differently cased or spelled id matches by its slug. An unknown id throws
   * a `ToolError`.
   */
  resolve(raw: string): Resolved {
    const line = oneLine(raw);
    const id = line.replace(/^\/?wiki\//, "").replace(/\/+$/, "");
    // The About article by its id or its site path, in any case; no feature can take the name.
    if (/^special[:/]about$/i.test(id.replace(/^\//, ""))) {
      if (this.article !== undefined) return { kind: "about" };
    } else {
      const slug = aliasSlug(id);
      // `from` is the agent's own text, so it is one printable line and capped.
      const from = cut(id, 80);
      if (this.hasRoute(slug)) {
        const found = this.reach(slug, slug === this.finalTarget(slug) ? null : from, from);
        if (found !== undefined) return found;
      }
      // Only targets with a page: the site shows the others as plain text, with nothing to read.
      const targets = this.aliasRoutes.get(slug)?.filter((t) => this.hasRoute(t));
      if (targets?.length === 1) {
        const found = this.reach(targets[0] ?? slug, from, from);
        if (found !== undefined) return found;
      } else if (targets !== undefined && targets.length > 1) {
        return { kind: "choices", from, targets };
      }
    }
    throw new ToolError(`no page ${JSON.stringify(cut(line, 80))}; use search to find a page's id`);
  }

  /** The page or choices a routed feature id ends at, or undefined when its target has no page. */
  private reach(id: string, pageFrom: string | null, choicesFrom: string): Resolved | undefined {
    const target = this.finalTarget(id);
    const status = this.features.get(target)?.status;
    if (status?.kind === "disambiguation") {
      // As the site lists them: each target at its final article, once; only those with a page.
      const targets = [...new Set(status.to.map((to) => this.finalTarget(to)))].filter((t) =>
        this.hasRoute(t),
      );
      return targets.length === 0 ? undefined : { kind: "choices", from: choicesFrom, targets };
    }
    return this.pages.has(target) ? { kind: "page", featureId: target, from: pageFrom } : undefined;
  }
}

/** A citation as the agent reads it: `path:start-end (symbol) at commit <sha7>`, or the commit. */
export function reference(citation: Citation): string {
  if (citation.kind === "code") {
    const symbol = citation.symbol === null ? "" : ` (${oneLine(citation.symbol)})`;
    return `${oneLine(citation.path)}:${citation.startLine}-${citation.endLine}${symbol} at commit ${citation.sha.slice(0, 7)}`;
  }
  const pr = citation.pr === null ? "" : `, pull request #${citation.pr}`;
  return `commit ${citation.sha.slice(0, 7)} ${JSON.stringify(oneLine(citation.subject))}${pr}`;
}
