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

  /** Claim text for the agent: links name their page id, so the agent can read it next. */
  text(claimText: string): string {
    const linked = claimText.replace(
      TOKEN,
      (match, code: string | undefined, target = "", label?: string) => {
        if (code !== undefined) return match;
        const id = target.trim();
        const shown = label?.trim() || undefined;
        if (id.startsWith("wp:")) return shown ?? id.slice(3).trim();
        return this.hasRoute(id) ? `${shown ?? this.title(id)} [page: ${id}]` : (shown ?? id);
      },
    );
    return oneLine(linked);
  }

  /** The first sentence of a page's lead, one line, for search results and choices. */
  summary(id: string): string {
    const lead =
      id === ABOUT_PAGE_ID
        ? this.article?.sections.find((s) => s.key === "lead")?.claims[0]
        : this.pages.get(id)?.sections.find((s) => s.key === "lead")?.claims[0];
    return lead === undefined ? "" : cut(this.text(lead.text), SUMMARY_LENGTH);
  }

  resolve(raw: string): Resolved {
    const id = raw
      .trim()
      .replace(/^\/?wiki\//, "")
      .replace(/\/+$/, "");
    if (id === ABOUT_PAGE_ID && this.article !== undefined) return { kind: "about" };
    const feature = this.features.get(id);
    if (feature !== undefined && this.hasRoute(id)) {
      const target = this.finalTarget(id);
      const status = this.features.get(target)?.status;
      if (status?.kind === "disambiguation")
        return { kind: "choices", from: id, targets: status.to };
      if (this.pages.has(target))
        return { kind: "page", featureId: target, from: target === id ? null : id };
    }
    const targets = this.aliasRoutes.get(aliasSlug(id));
    if (targets !== undefined && targets.length === 1 && targets[0] !== undefined) {
      return this.resolve(targets[0]).kind === "page"
        ? { kind: "page", featureId: targets[0], from: id }
        : this.resolve(targets[0]);
    }
    if (targets !== undefined && targets.length > 1) return { kind: "choices", from: id, targets };
    throw new ToolError(
      `no page ${JSON.stringify(cut(oneLine(raw), 80))}; use search to find a page's id`,
    );
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
