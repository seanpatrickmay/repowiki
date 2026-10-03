import type { ArchitectureClaim, ArchitectureSectionKey } from "@repowiki/core";
import { revisionHtml, type SectionView } from "./article.ts";
import { formatDate } from "./format.ts";
import { escapeHtml, renderInline } from "./inline.ts";
import { featureLink, type SiteModel } from "./model.ts";
import { articleLink } from "./preview.ts";
import { backlinksHtml, citationHtml, collectReferences, markersHtml } from "./references.ts";

export const ARCHITECTURE_SECTION_TITLES: Record<
  Exclude<ArchitectureSectionKey, "lead">,
  string
> = {
  purpose: "Purpose and features",
  layers: "Layers",
  "request-paths": "Request paths",
  dependencies: "Feature dependencies",
  infrastructure: "Infrastructure",
};

/**
 * Everything /special/about/ prints. As for ArticleView, a field is either plain text
 * (emit with `{}`) or trusted HTML built here from escaped parts (emit with `set:html`).
 */
export interface ArchitectureView {
  /** Plain text: the project's name, the page's title. */
  title: string;
  /** Trusted HTML. */
  leadHtml: string;
  /** Mermaid source the engine drew; pass it to `<Diagram>`, never `set:html`. */
  diagram: string | null;
  /** Plain text titles. */
  toc: { anchor: string; title: string }[];
  sections: SectionView[];
  /** Trusted HTML in both `html` and `backlinks`. */
  references: { n: number; html: string; backlinks: string }[];
  /** Trusted HTML: "This page was last edited on <date>, at commit <sha link>." */
  lastEdited: string;
}

/**
 * The project's current article as the page prints it, or null when the export has none.
 * Each claim is its text and its citation markers, then a link to every feature page that backs
 * it, so a reader can check a claim that rests on a page's lead.
 */
export function architectureView(site: SiteModel): ArchitectureView | null {
  const article = site.architecture;
  if (article === null) return null;
  const refs = collectReferences(article);
  const link = (id: string) => articleLink(site, id);
  const paragraph = (claims: readonly ArchitectureClaim[]): string =>
    claims
      .map((claim) => {
        const backing = claim.pages.flatMap((id) => {
          const page = featureLink(site, id);
          return page === null
            ? []
            : [`<a class="wikilink" href="${escapeHtml(page.href)}">${escapeHtml(page.title)}</a>`];
        });
        const pages =
          backing.length === 0 ? "" : ` <span class="page-ref">(see ${backing.join(", ")})</span>`;
        return (
          renderInline(claim.text, { link }) + markersHtml(refs.markers.get(claim.id) ?? []) + pages
        );
      })
      .join(" ");
  const sections: SectionView[] = article.sections.flatMap((section) =>
    section.key === "lead"
      ? []
      : [
          {
            anchor: section.key,
            title: ARCHITECTURE_SECTION_TITLES[section.key],
            html: paragraph(section.claims),
            stale: section.claims.some((claim) => claim.staleSince !== null),
          },
        ],
  );
  const references = refs.notes.map((note) => ({
    n: note.n,
    html: citationHtml(note.citation, site.repoUrl),
    backlinks: backlinksHtml(note),
  }));
  return {
    title: article.title,
    leadHtml: paragraph(article.sections.find((s) => s.key === "lead")?.claims ?? []),
    diagram: article.diagram,
    toc: [
      ...sections.map(({ anchor, title }) => ({ anchor, title })),
      ...(references.length > 0 ? [{ anchor: "references", title: "References" }] : []),
    ],
    sections,
    references,
    lastEdited: `This page was last edited on ${formatDate(article.commitDate)}, at commit ${revisionHtml(site, article)}.`,
  };
}
