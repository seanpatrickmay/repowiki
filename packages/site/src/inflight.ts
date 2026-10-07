import {
  claimAnchor,
  githubBlobUrl,
  githubUrl,
  hasCitableLines,
  type InFlight,
  type InFlightPull,
  type IssueEvidence,
  plainClaimText,
} from "@repowiki/core";
import { formatDate, formatNumber, shortSha } from "./format.ts";
import { renderInline } from "./inline.ts";
import { featureLink, type SiteModel } from "./model.ts";
import { inlineOptions } from "./preview.ts";
import { articleUrl, pullUrl } from "./urls.ts";

/** A snapshot read this long before the export was made is stale (R16). */
export const STALE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A feature as a link when it has a page; plain text otherwise. All text is plain. */
export interface FeatureRef {
  title: string;
  href: string | null;
}

/** "From GitHub on <date>, against commit <sha7>", and R16's warning when the snapshot is stale. */
export interface InflightStatus {
  /** Plain text. */
  line: string;
  /** Plain text, or null when the snapshot is current. */
  stale: string | null;
}

/**
 * The snapshot's status against the export, never the build machine's clock, so one export
 * always renders the same: stale when derived against another head than the export's, or read
 * from GitHub more than STALE_AFTER_DAYS before the export was made.
 */
export function inflightStatus(site: SiteModel, inflight: InFlight): InflightStatus {
  const line = `From GitHub on ${formatDate(inflight.fetchedAt)}, against commit ${shortSha(inflight.wikiHead)}.`;
  if (inflight.wikiHead !== site.wiki.head) {
    return {
      line,
      stale: `The wiki has moved on to commit ${shortSha(site.wiki.head)} since this was worked out; run pnpm wiki:inflight to refresh it.`,
    };
  }
  const days = Math.floor(
    (Date.parse(site.wiki.exportedAt) - Date.parse(inflight.fetchedAt)) / DAY_MS,
  );
  return days > STALE_AFTER_DAYS
    ? {
        line,
        stale: `GitHub was read ${formatNumber(days)} days before this wiki was exported; run pnpm wiki:inflight to refresh it.`,
      }
    : { line, stale: null };
}

const counted = (n: number, one: string): string =>
  `${formatNumber(n)} ${one}${n === 1 ? "" : "s"}`;

/** "N files added and M removed": file counts, worded so they never read as line counts. */
function addedRemoved(added: number, removed: number): string {
  if (added > 0 && removed > 0)
    return `${counted(added, "file")} added and ${formatNumber(removed)} removed`;
  if (added > 0) return `${counted(added, "file")} added`;
  return removed > 0 ? `${counted(removed, "file")} removed` : "";
}

const featureRef = (site: SiteModel, id: string): FeatureRef => ({
  title: site.features.get(id)?.title ?? id,
  href: featureLink(site, id)?.href ?? null,
});

/** A pull request's badges: Draft, Bot, and "targets <base>" off the default branch (R18, R23). */
export function badges(inflight: InFlight, pull: InFlightPull): string[] {
  return [
    ...(pull.draft ? ["Draft"] : []),
    ...(pull.author?.bot === true ? ["Bot"] : []),
    ...(pull.baseRef !== inflight.repo.defaultBranch ? [`targets ${pull.baseRef}`] : []),
  ];
}

const authorOf = (pull: { author: InFlightPull["author"] }): string =>
  pull.author === null ? "a deleted account" : pull.author.login;

/** The claims a pull request would make stale (certain ones) and may change. */
const effectCount = (pull: InFlightPull): string => {
  if (pull.head !== "fetched") return "not computed";
  const certain = pull.effects.filter((e) => e.certain).length;
  const may = pull.effects.length - certain;
  return may === 0
    ? formatNumber(certain)
    : `${formatNumber(certain)} (+${formatNumber(may)} may change)`;
};

/** An issue's evidence in words (spec v2 #9 §6.2). Plain text. */
export function evidenceText(site: SiteModel, evidence: IssueEvidence): string {
  switch (evidence.kind) {
    case "pull":
      return `closed by ${evidence.detail}`;
    case "path":
      return `mentions ${evidence.detail}`;
    case "name":
      return `names ${featureRef(site, evidence.featureId).title}`;
    case "label":
      return `label ${evidence.detail}`;
    case "search":
      return "suggested by search";
  }
}

export interface IssueRow {
  number: number;
  /** Plain text. */
  title: string;
  href: string;
  labels: string[];
  evidence: string;
}

export interface InflightIndexView {
  status: InflightStatus;
  pulls: {
    number: number;
    /** Plain text. */
    title: string;
    href: string;
    badges: string[];
    author: string;
    updated: string;
    features: FeatureRef[];
    claims: string;
  }[];
  planned: { feature: FeatureRef; issues: IssueRow[] }[];
  unmapped: IssueRow[];
  /** "And N more …" lines for R19's caps. Plain text. */
  more: string[];
}

/** /special/in-progress/: the open pull requests, and the planned work under each feature. */
export function inflightIndexView(site: SiteModel, inflight: InFlight): InflightIndexView {
  const planned = new Map<string, IssueRow[]>();
  const unmapped: IssueRow[] = [];
  for (const issue of inflight.issues) {
    const row = (evidence: string): IssueRow => ({
      number: issue.number,
      title: issue.title,
      href: githubUrl(inflight.repo, "issues", issue.number),
      labels: issue.labels,
      evidence,
    });
    if (issue.features.length === 0) unmapped.push(row("not mapped"));
    for (const evidence of issue.features) {
      const rows = planned.get(evidence.featureId) ?? [];
      rows.push(row(evidenceText(site, evidence)));
      planned.set(evidence.featureId, rows);
    }
  }
  const { pulls, issues } = inflight.omitted;
  return {
    status: inflightStatus(site, inflight),
    pulls: inflight.pulls.map((pull) => ({
      number: pull.number,
      title: pull.title,
      href: pullUrl(pull.number),
      badges: badges(inflight, pull),
      author: authorOf(pull),
      updated: formatDate(pull.updatedAt),
      features: pull.features.map((f) => featureRef(site, f.featureId)),
      claims: effectCount(pull),
    })),
    planned: [...planned].map(([id, rows]) => ({ feature: featureRef(site, id), issues: rows })),
    unmapped,
    more: [
      ...(pulls > 0 ? [`And ${formatNumber(pulls)} more open pull requests, not read.`] : []),
      ...(issues > 0 ? [`And ${formatNumber(issues)} more open issues, not read.`] : []),
    ],
  };
}

export interface PullView {
  number: number;
  /** Plain text. */
  title: string;
  badges: string[];
  githubHref: string;
  author: string;
  created: string;
  updated: string;
  base: string;
  /** Plain text: how the pull request would merge, or why its impact is unknown. */
  merge: string;
  /** Plain text: R27's notice when the wiki is behind its base, else null. */
  behind: string | null;
  /** Null when the head was not fetched; the page says so. */
  summary: { html: string; refs: { n: number; label: string; href: string }[] }[] | null;
  /** Plain text the page shows in place of a null summary. */
  summaryNote: string;
  features: {
    anchor: string;
    feature: FeatureRef;
    files: string;
    /** How many of its files the pull request adds here by placement, not by the manifest. */
    inferred: number;
    drifts: boolean;
    /** Each claim it would change, quoted as plain text and linked to it on the article. */
    effects: { text: string; href: string | null; reason: string; certain: boolean }[];
  }[];
  closes: { number: number; href: string }[];
}

const MERGE_WORDS: Record<InFlightPull["merge"], string> = {
  clean: "It merges cleanly with the wiki's commit.",
  conflicts: "It conflicts with the wiki's commit, so the claims below only may change.",
  unknown: "Git could not merge it with the wiki's commit (that needs git 2.38 or later).",
};

/**
 * R27's notice for a pull request the wiki's head does not hold the fork point of, or whose base
 * was not read: its effects only may change until wiki:update. Null otherwise. Plain text.
 */
export function behindNotice(pull: InFlightPull): string | null {
  if (!pull.behind) return null;
  return pull.baseSha === null
    ? "This pull's base was not read, so its claims below only may change; run wiki:inflight again for exact predictions."
    : `The wiki is behind this pull's base (${shortSha(pull.baseSha)}); run wiki:update for exact predictions.`;
}

/** The anchor of a feature's part of a pull request page, which article markers link to. */
export const pullFeatureAnchor = (featureId: string): string => `feature-${featureId}`;

/** /special/in-progress/pr/<n>/. Every text field is plain except the summary claims' `html`. */
export function pullView(site: SiteModel, inflight: InFlight, pull: InFlightPull): PullView {
  const fetched = pull.head === "fetched";
  const titleOf = (id: string) => site.features.get(id)?.title ?? null;
  let n = 0;
  const summary =
    pull.summary === null
      ? null
      : pull.summary.claims.map((claim) => ({
          html: renderInline(claim.text, inlineOptions(site)),
          refs: claim.citations.map((c) => ({
            n: ++n,
            label: `${c.path}:L${c.startLine}${c.endLine > c.startLine ? `-L${c.endLine}` : ""}`,
            href: githubBlobUrl(inflight.repo, c.sha, c.path, c.startLine, c.endLine),
          })),
        }));
  return {
    number: pull.number,
    title: pull.title,
    badges: badges(inflight, pull),
    githubHref: githubUrl(inflight.repo, "pull", pull.number),
    author: authorOf(pull),
    created: formatDate(pull.createdAt),
    updated: formatDate(pull.updatedAt),
    base: pull.baseRef,
    merge: !fetched
      ? `Its head commit ${pull.head === "moved" ? "moved since GitHub was read" : "could not be fetched"}, so its impact could not be computed.`
      : pull.behind
        ? "It was not merged with the wiki's commit, so the claims below only may change."
        : MERGE_WORDS[pull.merge],
    behind: behindNotice(pull),
    summary,
    summaryNote:
      fetched && !hasCitableLines(pull.files)
        ? "There is nothing to summarise: it adds or changes no lines of text."
        : "No summary of this pull request yet.",
    // Every feature it touches, then any whose page cites a file it changes: each has an anchor
    // the article's markers link to.
    features: [...new Set([...pull.features, ...pull.effects].map((f) => f.featureId))].map(
      (featureId) => {
        const f = pull.features.find((touched) => touched.featureId === featureId);
        return {
          anchor: pullFeatureAnchor(featureId),
          feature: featureRef(site, featureId),
          files:
            f === undefined
              ? "None of its files, but its page cites files this changes"
              : [
                  counted(f.files, "file"),
                  counted(f.changedLines, "line"),
                  addedRemoved(f.added, f.removed),
                ]
                  .filter((part) => part !== "")
                  .join(", "),
          inferred: pull.files.filter(
            (file) => file.featureId === featureId && file.placement === "inferred",
          ).length,
          drifts: f?.drifts ?? false,
          effects: pull.effects
            .filter((e) => e.featureId === featureId)
            .map((e) => {
              const section = site.pages
                .get(e.featureId)
                ?.sections.find((s) => s.claims.some((c) => c.id === e.claimId));
              const claim = section?.claims.find((c) => c.id === e.claimId);
              const anchor = claimAnchor(e.claimId);
              const article = featureLink(site, e.featureId)?.href ?? null;
              return {
                text: claim === undefined ? e.claimId : plainClaimText(claim.text, titleOf),
                // A claim no longer on the page (a stale snapshot) links to the article itself; one
                // whose id cannot be an anchor, to its section's (C10), or the article for the lead.
                href:
                  claim === undefined || section === undefined
                    ? article
                    : anchor !== null
                      ? `${articleUrl(e.featureId)}#${anchor}`
                      : section.key === "lead"
                        ? article
                        : `${articleUrl(e.featureId)}#${section.key}`,
                reason: e.reason,
                certain: e.certain,
              };
            }),
        };
      },
    ),
    closes: pull.closes.map((number) => ({
      number,
      href: githubUrl(inflight.repo, "issues", number),
    })),
  };
}
