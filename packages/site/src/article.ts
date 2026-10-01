import type { Revision, SectionKey } from "@repowiki/core";
import { formatDate, formatNumber, shortSha } from "./format.ts";
import { escapeHtml, renderInline } from "./inline.ts";
import { featureLink, type SiteModel } from "./model.ts";
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
  title: string;
  html: string;
  stale: boolean;
}

export interface ArticleView {
  featureId: string;
  title: string;
  /** Banner HTML above the article (retired feature, old revision), or null. */
  notice: string | null;
  leadHtml: string;
  leadStale: boolean;
  toc: { anchor: string; title: string }[];
  sections: SectionView[];
  seeAlso: { href: string; title: string }[];
  references: { n: number; html: string; backlinks: string }[];
  infobox: { label: string; html: string }[];
  lastEdited: string;
}

/** Everything the article template prints, computed from one revision. */
export function articleView(site: SiteModel, revision: Revision): ArticleView {
  const feature = site.features.get(revision.featureId);
  const title = feature?.title ?? revision.featureId;
  const refs = collectReferences(revision);
  const link = (id: string) => featureLink(site, id);

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
    const target = link(id);
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
