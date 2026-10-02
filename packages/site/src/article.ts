import type { Revision, SectionKey } from "@repowiki/core";
import { formatDate, formatNumber, shortSha } from "./format.ts";
import { escapeHtml, renderInline } from "./inline.ts";
import { featureLink, type SiteModel } from "./model.ts";
import { articleLink } from "./preview.ts";
import { backlinksHtml, citationHtml, collectReferences, markersHtml } from "./references.ts";

export const SECTION_TITLES: Record<Exclude<SectionKey, "lead">, string> = {
  overview: "Overview",
  "how-it-works": "How it works",
  "data-flow": "Data flow",
  history: "History",
  "known-limitations": "Known limitations",
};

export const STALE_NOTICE = "This section may be out of date.";

export interface SectionView {
  anchor: string;
  /** Plain text: emit with `{}` in Astro. */
  title: string;
  /** Trusted HTML built by the site's renderers: emit with `set:html`. */
  html: string;
  stale: boolean;
}

/**
 * Everything the article template prints. Each text field is either plain text (emit it with
 * `{}`, so Astro escapes it) or trusted HTML built here from escaped parts (emit it with
 * `set:html`). Never swap the two.
 */
export interface ArticleView {
  featureId: string;
  /** Plain text. */
  title: string;
  /** Trusted HTML. Banner above the article (retired feature, old revision, or both), or null. */
  notice: string | null;
  /** Trusted HTML. */
  leadHtml: string;
  leadStale: boolean;
  /**
   * Mermaid source, drawn at the top of Data flow, or after the lead when there is no such
   * section. Model text: pass it to `<Diagram>`, which prints it as escaped text inside
   * `<pre class="mermaid">`. Never `set:html`, and never given to Mermaid's `click` or links.
   */
  diagram: string | null;
  /** Plain text titles. */
  toc: { anchor: string; title: string }[];
  sections: SectionView[];
  /** Plain text titles. */
  seeAlso: { href: string; title: string }[];
  /** Trusted HTML in both `html` and `backlinks`. */
  references: { n: number; html: string; backlinks: string }[];
  /** `label` is plain text; `html` is trusted HTML. */
  infobox: { label: string; html: string }[];
  /** Trusted HTML: "This page was last edited on <date>, at commit <sha link>." */
  lastEdited: string;
}

/** Everything the article template prints, computed from one revision. */
export function articleView(site: SiteModel, revision: Revision): ArticleView {
  const feature = site.features.get(revision.featureId);
  const title = feature?.title ?? revision.featureId;
  const refs = collectReferences(revision);
  const link = (id: string) => articleLink(site, id);

  const stale = new Set<string>();
  for (const section of revision.sections) {
    for (const claim of section.claims) if (claim.staleSince !== null) stale.add(claim.id);
  }
  const paragraph = (claims: Revision["sections"][number]["claims"]): string =>
    claims
      .map(
        (claim) =>
          renderInline(claim.text, { link }) + markersHtml(refs.markers.get(claim.id) ?? []),
      )
      .join(" ");

  const lead = revision.sections.find((section) => section.key === "lead")?.claims ?? [];
  const sections: SectionView[] = revision.sections.flatMap((section) =>
    section.key === "lead"
      ? []
      : [
          {
            anchor: section.key,
            title: SECTION_TITLES[section.key],
            html: paragraph(section.claims),
            stale: section.claims.some((claim) => stale.has(claim.id)),
          },
        ],
  );
  const seeAlso = revision.seeAlso.flatMap((id) => {
    const target = featureLink(site, id);
    return target === null ? [] : [target];
  });
  const references = refs.notes.map((note) => ({
    n: note.n,
    html: citationHtml(note.citation, site.repoUrl),
    backlinks: backlinksHtml(note),
  }));
  const toc = [
    ...sections.map(({ anchor, title }) => ({ anchor, title })),
    ...(seeAlso.length > 0 ? [{ anchor: "see-also", title: "See also" }] : []),
    ...(references.length > 0 ? [{ anchor: "references", title: "References" }] : []),
  ];

  const retire = feature?.lineage.find((event) => event.kind === "retire");
  const notice =
    feature?.status.kind === "retired"
      ? `This feature was retired${retire === undefined ? "" : ` at commit <code>${shortSha(retire.sha)}</code>`}. The article describes it as of its last revision.`
      : null;

  return {
    featureId: revision.featureId,
    title,
    notice,
    leadHtml: paragraph(lead),
    leadStale: lead.some(
      (claim) => stale.has(claim.id) || claim.supports.some((id) => stale.has(id)),
    ),
    diagram: revision.diagram,
    toc,
    sections,
    seeAlso,
    references,
    infobox: infoboxRows(site, revision, feature?.aliases ?? []),
    lastEdited: `This page was last edited on ${formatDate(revision.commitDate)}, at commit ${revisionHtml(site, revision)}.`,
  };
}

function revisionHtml(site: SiteModel, revision: Revision): string {
  const sha = `<code>${shortSha(revision.sha)}</code>`;
  const linked =
    site.repoUrl === null
      ? sha
      : `<a class="external" href="${escapeHtml(`${site.repoUrl}/commit/${revision.sha}`)}">${sha}</a>`;
  return revision.pr === null ? linked : `${linked} (PR #${revision.pr})`;
}

function infoboxRows(
  site: SiteModel,
  revision: Revision,
  aliases: readonly string[],
): ArticleView["infobox"] {
  const box = revision.infobox;
  const rows = [
    { label: "Also known as", html: aliases.map(escapeHtml).join(", ") },
    { label: "Files", html: formatNumber(box.files) },
    { label: "Lines of code", html: formatNumber(box.loc) },
    { label: "Languages", html: box.languages.map(escapeHtml).join(", ") },
    {
      label: "Entry points",
      html: box.entryPoints.map((p) => `<code>${escapeHtml(p)}</code>`).join("<br>"),
    },
    { label: "First commit", html: formatDate(box.firstCommitDate) },
    { label: "Last commit", html: formatDate(box.lastCommitDate) },
    { label: "Revision", html: revisionHtml(site, revision) },
  ];
  return rows.filter((row) => row.html !== "");
}
