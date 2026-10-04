import type { Architecture, Citation, Claim, Revision } from "@repowiki/core";
import { count, cut, oneLine, toolText } from "./text.ts";
import { ABOUT_PAGE_ID, reference, type WikiView } from "./wiki-view.ts";

const SECTION_TITLES: Readonly<Record<string, string>> = {
  lead: "Lead",
  overview: "Overview",
  "how-it-works": "How it works",
  "data-flow": "Data flow",
  history: "History",
  "known-limitations": "Known limitations",
  purpose: "Purpose and features",
  layers: "Layers",
  "request-paths": "Request paths",
  dependencies: "Dependencies",
  infrastructure: "Infrastructure",
};

const date = (iso: string) => iso.slice(0, 10);
const sha7 = (sha: string) => sha.slice(0, 7);

/** Sections of claims with numbered references, the same for a feature page and the About page. */
function renderSections(
  view: WikiView,
  sections: readonly { key: string; claims: readonly (Claim & { pages?: string[] })[] }[],
): string[] {
  const refs: string[] = [];
  const refOf = (citation: Citation) => {
    const text = reference(citation);
    const at = refs.indexOf(text);
    return at === -1 ? refs.push(text) : at + 1;
  };
  const lines: string[] = [];
  for (const section of sections) {
    lines.push("", SECTION_TITLES[section.key] ?? section.key);
    for (const claim of section.claims) {
      const marks = claim.citations.map((c) => `[${refOf(c)}]`).join("");
      const pages =
        (claim.pages ?? []).length > 0 ? ` [pages: ${(claim.pages ?? []).join(", ")}]` : "";
      const stale = claim.staleSince === null ? "" : " (may be out of date)";
      const bullet = section.key === "lead" ? "" : "- ";
      lines.push(
        `${bullet}${view.text(claim.text)}${marks === "" ? "" : ` ${marks}`}${pages}${stale}`,
      );
    }
  }
  if (refs.length > 0) lines.push("", "References", ...refs.map((r, i) => `[${i + 1}] ${r}`));
  return lines;
}

function renderFeaturePage(view: WikiView, featureId: string, from: string | null): string {
  const page = view.pages.get(featureId) as Revision;
  const feature = view.features.get(featureId);
  const box = page.infobox;
  const history = view.wiki.history[featureId] ?? [page];
  const status =
    feature?.status.kind === "retired"
      ? "retired: the feature is no longer in the code, and this is its last page"
      : "active";
  const lines = [
    `${oneLine(view.title(featureId))} (page id: ${featureId})`,
    ...(from === null ? [] : [`(Redirected from ${cut(oneLine(from), 80)})`]),
    `Status: ${status}. This revision: commit ${sha7(page.sha)}, ${date(page.commitDate)}.`,
    ...((feature?.aliases.length ?? 0) > 0
      ? [`Also called: ${(feature?.aliases ?? []).map(oneLine).join("; ")}`]
      : []),
    `Infobox: ${count(box.files, "file")}, ${count(box.loc, "line")}; languages: ${box.languages.map(oneLine).join(", ") || "none"}; entry points: ${box.entryPoints.map(oneLine).join(", ") || "none"}; first commit ${date(box.firstCommitDate)}, last commit ${date(box.lastCommitDate)}.`,
    ...renderSections(view, page.sections),
  ];
  const seeAlso = page.seeAlso.filter((id) => view.hasRoute(id));
  if (seeAlso.length > 0) {
    lines.push(
      "",
      `See also: ${seeAlso.map((id) => `${id} (${oneLine(view.title(id))})`).join(", ")}`,
    );
  }
  const revisions = history.map(
    (r) =>
      `${date(r.commitDate)} commit ${sha7(r.sha)} (${r.reason}${r.pr === null ? "" : `, pull request #${r.pr}`})`,
  );
  lines.push("", `Page history, oldest first: ${revisions.join("; ")}`);
  return `${lines.join("\n")}\n`;
}

function renderAbout(view: WikiView): string {
  const article = view.article as Architecture;
  const lines = [
    `${oneLine(article.title)} (page id: ${ABOUT_PAGE_ID}): the project's own article`,
    `This revision: commit ${sha7(article.sha)}, ${date(article.commitDate)}.`,
    ...renderSections(view, article.sections),
  ];
  return `${lines.join("\n")}\n`;
}

function renderChoices(view: WikiView, from: string, targets: readonly string[]): string {
  const lines = [`${cut(oneLine(from), 80)} may refer to:`];
  for (const id of targets) {
    if (!view.hasRoute(id)) continue;
    const summary = view.summary(view.finalTarget(id));
    lines.push(`- ${id}: ${oneLine(view.title(id))}${summary === "" ? "" : `. ${summary}`}`);
  }
  lines.push("Read one with read_page(id).");
  return `${lines.join("\n")}\n`;
}

/**
 * One page as the wiki agent reads it (read_page): a feature page with its status, aliases,
 * infobox, claims, numbered references, See also and dated history; the About article; or the
 * choices of a disambiguation. Redirects and alias routes are followed as the site follows them.
 */
export function readPage(view: WikiView, id: string): string {
  const resolved = view.resolve(id);
  if (resolved.kind === "about") return toolText(renderAbout(view));
  if (resolved.kind === "choices")
    return toolText(renderChoices(view, resolved.from, resolved.targets));
  return toolText(renderFeaturePage(view, resolved.featureId, resolved.from));
}
