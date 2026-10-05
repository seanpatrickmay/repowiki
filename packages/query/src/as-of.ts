import type { Feature, LineageEvent, Revision, WikiExport } from "@repowiki/core";
import { ToolError } from "./tools.ts";
import { titleText, WikiView } from "./wiki-view.ts";

/**
 * A point in the wiki's past (spec v2 #5 R9): a calendar date, compared with the date written in
 * each revision's commitDate (spec §5 rule 5), or a commit of the documented repository.
 */
export type AsOf = { kind: "date"; date: string } | { kind: "commit"; sha: string };

/** The full sha of the commit a 7-40 hex prefix names, or null; git is the caller's (mcp). */
export type ResolveCommit = (prefix: string) => string | null;

/** True when `ancestor` is `descendant` or one of its ancestors; git is the caller's (mcp). */
export type IsAncestor = (ancestor: string, descendant: string) => boolean;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HEX = /^[0-9a-f]{7,40}$/i;
const FORMS = "a date YYYY-MM-DD or a commit sha of 7 to 40 hex characters";

/**
 * An as_of argument as an AsOf: a real calendar date, or a hex prefix the repository resolves to
 * one commit. Anything else is a ToolError naming both forms. Only a validated hex prefix ever
 * reaches `resolveCommit`.
 */
export function parseAsOf(text: string, resolveCommit: ResolveCommit): AsOf {
  const value = text.trim();
  const date = DATE.exec(value);
  if (date !== null) {
    const [, y, m, d] = date.map(Number);
    const day = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 0));
    if (day.toISOString().slice(0, 10) !== value) {
      throw new ToolError(`as_of ${JSON.stringify(value)} is not a real date; use ${FORMS}`);
    }
    return { kind: "date", date: value };
  }
  if (HEX.test(value)) {
    const sha = resolveCommit(value.toLowerCase());
    if (sha === null) {
      throw new ToolError(
        `no single commit ${value.toLowerCase()} in the repository; as_of is ${FORMS}`,
      );
    }
    return { kind: "commit", sha };
  }
  throw new ToolError(`as_of must be ${FORMS}`);
}

/** How an AsOf reads in a sentence: "2026-01-03" or "commit 594d833". */
export const asOfLabel = (asOf: AsOf): string =>
  asOf.kind === "date" ? asOf.date : `commit ${asOf.sha.slice(0, 7)}`;

/**
 * The revision current at `asOf`, of a list oldest first: for a date, the last whose commitDate's
 * written calendar date is on or before it; for a commit, the last made at that commit, else the
 * last whose commit is its ancestor (a branch, or a commit between two updates). Null when the
 * history begins later. Works for page revisions and About article revisions alike.
 */
export function revisionAt<R extends { sha: string; commitDate: string }>(
  revisions: readonly R[],
  asOf: AsOf,
  isAncestor: IsAncestor,
): R | null {
  if (asOf.kind === "date") {
    return revisions.findLast((r) => r.commitDate.slice(0, 10) <= asOf.date) ?? null;
  }
  return (
    revisions.findLast((r) => r.sha === asOf.sha) ??
    revisions.findLast((r) => isAncestor(r.sha, asOf.sha)) ??
    null
  );
}

/** The About article current at `asOf`: revisionAt over the export's article revisions. */
export const architectureAt = revisionAt;

/**
 * The commit the wiki stood at on `asOf`: the commit itself, or for a date the commit of the
 * newest revision (of any page or the About article) written on or before it: the day is the
 * written calendar date, "newest" is by instant (Date.parse), since offsets differ. Null when
 * nothing was written by then.
 */
export function pointAt(wiki: WikiExport, asOf: AsOf): string | null {
  if (asOf.kind === "commit") return asOf.sha;
  let best: { sha: string; commitDate: string } | null = null;
  const all = [...Object.values(wiki.history).flat(), ...wiki.architecture];
  for (const r of all) {
    if (r.commitDate.slice(0, 10) > asOf.date) continue;
    if (best === null || Date.parse(r.commitDate) > Date.parse(best.commitDate)) best = r;
  }
  return best?.sha ?? null;
}

/** Whether a lineage event had happened by commit `point`. */
const happened = (event: LineageEvent, point: string | null, isAncestor: IsAncestor) =>
  point !== null && isAncestor(event.sha, point);

/**
 * A feature as it stood at `point`: the title it had then (the old title of the first rename
 * after it), its aliases less the titles it had not yet left behind, and its status then
 * (active, unless a merge, split or retirement had happened).
 */
function featureAt(feature: Feature, point: string | null, isAncestor: IsAncestor): Feature {
  const later = feature.lineage.filter((e) => !happened(e, point, isAncestor));
  const renames = later.flatMap((e) => (e.kind === "rename" ? [e.fromTitle] : []));
  const ended = later.some((e) => e.kind === "merge" || e.kind === "split" || e.kind === "retire");
  return {
    ...feature,
    title: renames[0] ?? feature.title,
    aliases: feature.aliases.filter((alias) => !renames.includes(alias)),
    status: ended ? { kind: "active" } : feature.status,
  };
}

/**
 * The wiki as it was at `asOf` (spec v2 #5 §5, `WikiView.at`): each feature's page is its
 * revisionAt (a feature with none is absent), its history ends there, the About article is
 * architectureAt, and each feature has the title and status it had then. The manifest's
 * membership is the export's. No git runs here: `isAncestor` is the caller's.
 */
export function viewAt(wiki: WikiExport, asOf: AsOf, isAncestor: IsAncestor): WikiView {
  const point = pointAt(wiki, asOf);
  const pages: Revision[] = [];
  const history: Record<string, Revision[]> = {};
  for (const [featureId, revisions] of Object.entries(wiki.history)) {
    const page = revisionAt(revisions, asOf, isAncestor);
    if (page === null) continue;
    pages.push(page);
    history[featureId] = revisions.slice(0, revisions.indexOf(page) + 1);
  }
  const article = architectureAt(wiki.architecture, asOf, isAncestor);
  const then: WikiExport = {
    ...wiki,
    manifest: {
      ...wiki.manifest,
      features: wiki.manifest.features.map((f) => featureAt(f, point, isAncestor)),
    },
    pages,
    history,
    architecture:
      article === null ? [] : wiki.architecture.slice(0, wiki.architecture.indexOf(article) + 1),
  };
  return new WikiView(then);
}

/** One lineage event as a phrase: "renamed from "X" at commit 3d751d3". */
function lineagePhrase(event: LineageEvent): string {
  const at = `at commit ${event.sha.slice(0, 7)}`;
  switch (event.kind) {
    case "create":
      return `created ${at}`;
    case "rename":
      return `renamed from ${JSON.stringify(titleText(event.fromTitle))} ${at}`;
    case "merge":
      return `merged into ${event.into} ${at}`;
    case "split":
      return `split into ${event.into.join(", ")} ${at}`;
    case "retire":
      return `retired ${at}`;
  }
}

/**
 * The lines read_page puts under a page's title when it is read as of a point (spec v2 #5 §6.2):
 * which revision this is, the current one, and the feature's lineage up to then.
 */
export function asOfBanner(
  wiki: WikiExport,
  featureId: string,
  revision: Revision,
  asOf: AsOf,
  isAncestor: IsAncestor,
): string[] {
  const all = wiki.history[featureId] ?? [];
  const current = all.at(-1);
  const k = all.indexOf(revision) + 1;
  const lines = [
    `This is the page as of ${asOfLabel(asOf)}: revision ${k} of ${all.length}, commit ${revision.sha.slice(0, 7)}, ${revision.commitDate.slice(0, 10)}. The current revision is ${current?.commitDate.slice(0, 10) ?? "unknown"} (commit ${current?.sha.slice(0, 7) ?? "unknown"}).`,
  ];
  const feature = wiki.manifest.features.find((f) => f.id === featureId);
  if (feature !== undefined) {
    const point = pointAt(wiki, asOf);
    const by = feature.lineage.filter((e) => happened(e, point, isAncestor));
    const later = feature.lineage.length - by.length;
    lines.push(
      `Lineage up to then: ${by.map(lineagePhrase).join("; ") || "none"}.${later > 0 ? ` ${later} later lineage ${later === 1 ? "event is" : "events are"} on the current page.` : ""}`,
    );
  }
  return lines;
}

/** read_page's answer for a point before a feature's first revision. */
export function historyBegins(featureId: string, first: { sha: string; commitDate: string }) {
  return `The wiki's history of ${featureId} begins on ${first.commitDate.slice(0, 10)} (commit ${first.sha.slice(0, 7)}).\n`;
}
