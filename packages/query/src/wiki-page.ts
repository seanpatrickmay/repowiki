import type { Architecture, Citation, Claim, Revision } from "@repowiki/core";
import { count, cut, oneLine, toolText } from "./text.ts";
import { MAX_TOOL_RESULT_CHARS } from "./tools.ts";
import { ABOUT_PAGE_ID, listedPage, reference, titleText, type WikiView } from "./wiki-view.ts";

/** Every section key's title, a feature page's and the About article's. */
export const SECTION_TITLES: Readonly<Record<string, string>> = {
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

/** The most entries of a list (aliases, languages, entry points, choices) a page names. */
const MAX_LISTED = 20;

/** The first MAX_LISTED items, each one line cut to `max`, then how many more there are. */
function listed(items: readonly string[], max: number): string[] {
  const shown = items.slice(0, MAX_LISTED).map((item) => cut(oneLine(item), max));
  return items.length > MAX_LISTED ? [...shown, `and ${items.length - MAX_LISTED} more`] : shown;
}

const date = (iso: string) => iso.slice(0, 10);
const sha7 = (sha: string) => sha.slice(0, 7);

/** Sections of claims, as a feature page and the About article store them. */
type PageSections = readonly { key: string; claims: readonly (Claim & { pages?: string[] })[] }[];

/**
 * The citations a page's References list, in the order read_page numbers them: by first
 * appearance, one entry per distinct reference text.
 */
export function referenceList(sections: PageSections): Citation[] {
  const seen = new Map<string, Citation>();
  for (const section of sections) {
    for (const claim of section.claims) {
      for (const citation of claim.citations) {
        const text = reference(citation);
        if (!seen.has(text)) seen.set(text, citation);
      }
    }
  }
  return [...seen.values()];
}

/** Sections of claims with numbered references, the same for a feature page and the About page. */
function renderSections(
  view: WikiView,
  sections: PageSections,
  claimHandle: (claimId: string) => string | null,
): string[] {
  const refs = referenceList(sections).map(reference);
  const refOf = (citation: Citation) => refs.indexOf(reference(citation)) + 1;
  const lines: string[] = [];
  for (const section of sections) {
    lines.push("", SECTION_TITLES[section.key] ?? section.key);
    for (const claim of section.claims) {
      const marks = claim.citations.map((c) => `[${refOf(c)}]`).join("");
      const pages =
        (claim.pages ?? []).length > 0 ? ` [pages: ${(claim.pages ?? []).join(", ")}]` : "";
      const stale = claim.staleSince === null ? "" : " (may be out of date)";
      const handle = claimHandle(claim.id);
      // Every claim, the lead's too, is a bullet: claim text never starts a line of its own.
      lines.push(
        `- ${handle === null ? "" : `${handle} `}${view.text(claim.text)}${marks === "" ? "" : ` ${marks}`}${pages}${stale}`,
      );
    }
  }
  if (refs.length > 0) lines.push("", "References", ...refs.map((r, i) => `[${i + 1}] ${r}`));
  return lines;
}

const codePoints = (lines: readonly string[]) => [...`${lines.join("\n")}\n`].length;

/**
 * A feature page as lines, fitted to `max` code points by leaving out whole parts, least useful
 * first: the oldest history entries, then See also. The claims and their References always stay
 * (a longer page is cut by the tool's cap); a last line says what was left out.
 */
function fitPage(
  core: readonly string[],
  seeAlso: string | null,
  revisions: readonly string[],
  max: number,
): string[] {
  const assemble = (dropped: number, withSeeAlso: boolean, note: string | null) => [
    ...core,
    ...(withSeeAlso && seeAlso !== null ? ["", seeAlso] : []),
    ...(dropped < revisions.length
      ? ["", `Page history, oldest first: ${revisions.slice(dropped).join("; ")}`]
      : []),
    ...(note === null ? [] : ["", note]),
  ];
  const whole = assemble(0, true, null);
  if (codePoints(whole) <= max) return whole;
  const noteFor = (dropped: number, withSeeAlso: boolean) => {
    // A page read without its history (the ask's) names only what it had to leave out.
    const parts = [
      ...(revisions.length === 0
        ? []
        : [
            dropped === revisions.length
              ? "the whole page history"
              : `the ${dropped} oldest page history ${dropped === 1 ? "entry" : "entries"}`,
          ]),
      ...(withSeeAlso || seeAlso === null ? [] : ["the See also list"]),
    ];
    return parts.length === 0
      ? null
      : `(Left out to fit the ${max}-character limit: ${parts.join(" and ")}.)`;
  };
  for (let dropped = 1; dropped <= revisions.length; dropped++) {
    const lines = assemble(dropped, true, noteFor(dropped, true));
    if (codePoints(lines) <= max) return lines;
  }
  return assemble(revisions.length, false, noteFor(revisions.length, false));
}

function renderFeaturePage(
  view: WikiView,
  featureId: string,
  from: string | null,
  max: number,
  options: PageOptions,
): string {
  const page = view.pages.get(featureId) as Revision;
  const feature = view.features.get(featureId);
  const box = page.infobox;
  const history = view.wiki.history[featureId] ?? [page];
  const status =
    feature?.status.kind === "retired"
      ? "retired: the feature is no longer in the code, and this is its last page"
      : "active";
  const lines = [
    `${titleText(view.title(featureId))} (page id: ${featureId})`,
    ...(from === null ? [] : [`(Redirected from ${cut(oneLine(from), 80)})`]),
    `Status: ${status}. This revision: commit ${sha7(page.sha)}, ${date(page.commitDate)}.`,
    ...((feature?.aliases.length ?? 0) > 0
      ? [`Also called: ${listed((feature?.aliases ?? []).map(titleText), 80).join("; ")}`]
      : []),
    `Infobox: ${count(box.files, "file")}, ${count(box.loc, "line")}; languages: ${listed(box.languages, 80).join(", ") || "none"}; entry points: ${listed(box.entryPoints, 200).join(", ") || "none"}; first commit ${date(box.firstCommitDate)}, last commit ${date(box.lastCommitDate)}.`,
    ...renderSections(view, page.sections, options.claimHandle ?? (() => null)),
  ];
  const seeAlso = page.seeAlso.filter((id) => view.hasRoute(id));
  const seeAlsoLine =
    seeAlso.length === 0
      ? null
      : `See also: ${seeAlso.map((id) => `${id} (${titleText(view.title(id))})`).join(", ")}`;
  const revisions = (options.history === false ? [] : history).map(
    (r) =>
      `${date(r.commitDate)} commit ${sha7(r.sha)} (${r.reason}${r.pr === null ? "" : `, pull request #${r.pr}`})`,
  );
  return `${fitPage(lines, seeAlsoLine, revisions, max).join("\n")}\n`;
}

function renderAbout(view: WikiView, options: PageOptions): string {
  const article = view.article as Architecture;
  const lines = [
    `${titleText(article.title)} (page id: ${ABOUT_PAGE_ID}): the project's own article`,
    `This revision: commit ${sha7(article.sha)}, ${date(article.commitDate)}.`,
    ...renderSections(view, article.sections, options.claimHandle ?? (() => null)),
  ];
  return `${lines.join("\n")}\n`;
}

function renderChoices(view: WikiView, from: string, targets: readonly string[]): string {
  const lines = [`${cut(oneLine(from), 80)} may refer to:`];
  const readable = targets.filter((id) => view.hasRoute(id));
  for (const id of readable.slice(0, MAX_LISTED)) {
    lines.push(listedPage(id, view.title(id), view.summary(view.finalTarget(id))));
  }
  if (readable.length > MAX_LISTED) lines.push(`- and ${readable.length - MAX_LISTED} more`);
  lines.push("Read one with read_page(id).");
  return `${lines.join("\n")}\n`;
}

/**
 * What the Ask sidebar's read_page (readPageWithHandles) changes in a page: a handle at the start
 * of each claim's bullet, and no page history. Each handle is one line of untrusted-safe text;
 * with no options the page is exactly v1's.
 */
export interface PageOptions {
  /** A mark put before a claim's text, by claim id (the ask's `{page#claim}`), or null for none. */
  claimHandle?: (claimId: string) => string | null;
  /** False leaves out a feature page's dated history (spec v2 #4 R22); default true. */
  history?: boolean;
}

/**
 * One page as the wiki agent reads it (read_page): a feature page with its status, aliases,
 * infobox, claims, numbered references, See also and dated history; the About article; or the
 * choices of a disambiguation. Redirects and alias routes are followed as the site follows them.
 * A feature page over `max` code points leaves out its oldest history, then its See also list.
 * `options` add the Ask sidebar's claim handles or leave out the history; without them the page
 * is byte for byte v1's (the M7 cassettes pin it, C4).
 */
export function readPage(
  view: WikiView,
  id: string,
  max = MAX_TOOL_RESULT_CHARS,
  options: PageOptions = {},
): string {
  const resolved = view.resolve(id);
  if (resolved.kind === "about") return toolText(renderAbout(view, options));
  if (resolved.kind === "choices")
    return toolText(renderChoices(view, resolved.from, resolved.targets));
  return toolText(renderFeaturePage(view, resolved.featureId, resolved.from, max, options));
}
