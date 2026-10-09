import {
  type ActivityDay,
  type Claim,
  contributorsOf,
  type PeopleExport,
  type PersonFacts,
  type PersonRevision,
  withoutEmails,
} from "@repowiki/core";
import {
  barChart,
  bucketLabel,
  bucketStarts,
  chartWindow,
  FIRST_CHART_DAY,
  heatmap,
  periodDays,
  repositorySeries,
  sparkline,
  zoomPeriod,
} from "./activity-svg.ts";
import { formatDate, formatNumber, shortSha } from "./format.ts";
import { escapeHtml, renderInline } from "./inline.ts";
import { featureLink, type SiteModel } from "./model.ts";
import { backlinksHtml, citationHtml, collectReferences, markersHtml } from "./references.ts";
import { listHtml } from "./section-layout.ts";
import { activityUrl, personUrl } from "./urls.ts";

/** Every /people/<path>/ page: the index, a person, or a merged-away id's redirect. */
export type PeopleRoute =
  | { path: undefined; kind: "index" }
  | { path: string; kind: "person"; personId: string }
  | { path: string; kind: "redirect"; to: string };

/** The People pages (spec v2 #6 §11), only when the export has People: none otherwise. */
export function peopleRoutes(site: SiteModel): PeopleRoute[] {
  const people = site.wiki.people;
  if (people === null) return [];
  return [
    { path: undefined, kind: "index" },
    ...humans(people).map((p) => ({ path: p.id, kind: "person" as const, personId: p.id })),
    ...people.snapshot.redirects.map((r) => ({
      path: r.from,
      kind: "redirect" as const,
      to: r.to,
    })),
  ];
}

const humans = (people: PeopleExport): PersonFacts[] =>
  people.snapshot.people.filter((p) => p.kind === "human");
const byCommits = (a: PersonFacts, b: PersonFacts) =>
  b.commits - a.commits || (a.id < b.id ? -1 : 1);
const percent = (share: number) => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
const range = (p: PersonFacts) => `${formatDate(p.firstCommit)} – ${formatDate(p.lastCommit)}`;
/**
 * People's narratives with every cited commit's subject scrubbed of addresses (spec v2 #6 R10,
 * R38, the Task 33 ruling): the engine stores them so, and the site holds to it for whatever it
 * writes from an export (pages, export.json, llms.txt). Null stays null.
 */
export function withoutQuotedAddresses(people: PeopleExport | null): PeopleExport | null {
  if (people === null) return null;
  return {
    ...people,
    pages: people.pages.map((page) => ({
      ...page,
      sections: page.sections.map((s) => ({
        ...s,
        claims: s.claims.map((c) => ({
          ...c,
          citations: c.citations.map((cite) =>
            cite.kind === "commit" ? { ...cite, subject: withoutEmails(cite.subject) } : cite,
          ),
        })),
      })),
    })),
  };
}

/** A share of current lines, or "no current lines" for none (the Task 33 ruling). */
const lineShare = (lines: number, total: number) =>
  lines === 0 ? "no current lines" : percent(lines / Math.max(1, total));

const counted = (n: number, one: string) => `${formatNumber(n)} ${one}${n === 1 ? "" : "s"}`;

/** A feature as trusted HTML: its link when it has a page, else its title as text. */
function featureHtml(site: SiteModel, id: string): string {
  const link = featureLink(site, id);
  const title = site.features.get(id)?.title ?? id;
  return link === null
    ? escapeHtml(title)
    : `<a class="wikilink" href="${escapeHtml(link.href)}">${escapeHtml(link.title)}</a>`;
}

export interface PeopleIndexView {
  /** Trusted HTML: the repository's all-time stacked chart. */
  chart: string;
  /** Plain text except `sparkline` (trusted HTML). */
  people: {
    name: string;
    href: string;
    active: string;
    commits: string;
    share: string;
    sparkline: string;
  }[];
  bots: { name: string; commits: string }[];
  /** Trusted HTML in `feature` and each contributor's `html`. */
  byFeature: { anchor: string; feature: string; contributors: string[] }[];
}

/**
 * /people/: the repository's activity, every person with a page by commits, the bots, and each
 * feature's contributors by current lines (R23's "and N more" lands here).
 */
export function peopleIndexView(site: SiteModel, people: PeopleExport): PeopleIndexView {
  const { snapshot } = people;
  const built = new Set(
    activityRoutes(site).flatMap((r) => (r.period === undefined ? [] : [r.period])),
  );
  const window = chartWindow(
    [...snapshot.people.flatMap((p) => p.activity), ...snapshot.others],
    headDay(people),
  );
  const { from, to, bucket } = window;
  const chart = barChart(repositorySeries(snapshot, from, to, personUrl), {
    label: `Commits to ${site.wiki.repo} by ${bucket}`,
    bucket,
    starts: window.starts,
    note: window.note,
    hrefOf: (_start, days) => {
      const year = zoomPeriod(days, 4, (y) => built.has(y));
      return year === null ? null : activityUrl(year);
    },
  });
  const total = Math.max(1, snapshot.totalLines);
  return {
    chart,
    people: humans(people)
      .sort(byCommits)
      .map((p) => ({
        name: p.name,
        href: personUrl(p.id),
        active: range(p),
        commits: formatNumber(p.commits),
        share: lineShare(p.currentLines, total),
        sparkline: sparkline(p.activity, from, to),
      })),
    bots: snapshot.people
      .filter((p) => p.kind === "bot")
      .sort(byCommits)
      .map((p) => ({ name: p.name, commits: counted(p.commits, "commit") })),
    byFeature: site.wiki.manifest.features
      .filter((f) => f.status.kind === "active" && (snapshot.featureLines[f.id] ?? 0) > 0)
      .sort((a, b) =>
        a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      )
      .map((f) => ({
        anchor: `feature-${f.id}`,
        feature: featureHtml(site, f.id),
        contributors: contributorsOf(people, f.id, Number.POSITIVE_INFINITY).contributors.map(
          (c) =>
            `<a href="${escapeHtml(personUrl(c.id))}">${escapeHtml(c.name)}</a> (${percent(c.share)})`,
        ),
      })),
  };
}

export interface PersonView {
  /** Plain text. */
  name: string;
  /** Plain text label, trusted HTML value. */
  infobox: { label: string; html: string }[];
  /** Trusted HTML. */
  leadHtml: string;
  /** Trusted HTML: the all-time chart, then one heatmap per active year. */
  chart: string;
  years: { anchor: string; year: string; html: string }[];
  /** Trusted HTML, one entry per chronicle claim; empty with no narrative. */
  chronicle: string[];
  /** Trusted block markup: a `<ul class="claim-list">`, or null with no areas claims. */
  areasHtml: string | null;
  /** The computed areas table; `feature` is trusted HTML. */
  areas: { feature: string; commits: string; lines: string; share: string }[];
  /** Plain text title; `href` null without --repo-url. */
  pulls: { number: number; title: string; merged: string; href: string | null }[];
  references: { n: number; html: string; backlinks: string }[];
  /** Plain text: "Narrative as of …", or why there is none; and the due line, or null. */
  asOf: string;
  due: string | null;
}

/** The lead a person without a narrative gets (R15): trusted HTML. */
export const computedLead = (p: PersonFacts): string =>
  `<b>${escapeHtml(p.name)}</b> made ${counted(p.commits, "commit")} between ${formatDate(p.firstCommit)} and ${formatDate(p.lastCommit)}.`;

/**
 * /people/<id>/ (spec v2 #6 §11): the infobox of computed facts, the narrative's lead (or the
 * computed one), the activity charts, the chronicle, the areas of work (claims, then the table),
 * the pull requests and the commit references. Person claims link features only, never Wikipedia.
 */
export function personView(site: SiteModel, people: PeopleExport, personId: string): PersonView {
  const { snapshot } = people;
  const p = snapshot.people.find((x) => x.id === personId && x.kind === "human");
  if (p === undefined) throw new Error(`no person ${personId}`);
  const narrative: PersonRevision | null =
    withoutQuotedAddresses(people)?.pages.find((r) => r.personId === p.id) ?? null;
  const refs = narrative === null ? null : collectReferences(narrative);
  // A person claim never links Wikipedia (planner ruling R6): defence in depth over the engine's.
  const links = { link: (id: string) => featureLink(site, id), wikipediaLinks: false };
  const claimHtml = (c: Claim) =>
    renderInline(c.text, links) + markersHtml(refs?.markers.get(c.id) ?? []);
  const claims = (key: string) => narrative?.sections.find((s) => s.key === key)?.claims ?? [];
  const total = Math.max(1, snapshot.totalLines);
  const window = chartWindow(p.activity, headDay(people));
  const { bucket } = window;
  // A heatmap per year the chart draws: a crafted date outside it gets none.
  const years = [
    ...new Set(
      p.activity
        .map((d) => d.day)
        .filter((d) => d >= window.from && d <= window.to)
        .map((d) => d.slice(0, 4)),
    ),
  ];
  const newer =
    narrative === null
      ? 0
      : p.activity
          .filter((d) => d.day > narrative.commitDate.slice(0, 10))
          .reduce((n, d) => n + d.commits, 0);
  const main = p.features.slice(0, 3).map((f) => featureHtml(site, f.featureId));
  const row = (label: string, html: string) => ({ label, html });
  return {
    name: p.name,
    infobox: [
      ...(p.otherNames.length > 0 ? [row("Other names", escapeHtml(p.otherNames.join(", ")))] : []),
      row("Active", escapeHtml(range(p))),
      row("Commits", formatNumber(p.commits)),
      row("Lines", `+${formatNumber(p.added)} −${formatNumber(p.deleted)}`),
      row(
        "Current lines",
        p.currentLines === 0
          ? "no current lines"
          : `${formatNumber(p.currentLines)} (${percent(p.currentLines / total)})`,
      ),
      row(
        "Pull requests",
        `${formatNumber(p.prsAuthored.length)} authored, ${formatNumber(p.prsMerged.length)} merged`,
      ),
      ...(main.length > 0 ? [row("Main features", main.join(", "))] : []),
    ],
    leadHtml: claims("lead").length > 0 ? claims("lead").map(claimHtml).join(" ") : computedLead(p),
    // Only the window's days, as the other charts draw (the wave B re-review): a commit outside
    // it but inside an edge bucket is in the note, not in a bar.
    chart: barChart(
      [
        {
          label: p.name,
          href: null,
          cls: "series-1",
          activity: p.activity.filter((d) => d.day >= window.from && d.day <= window.to),
        },
      ],
      {
        label: `${p.name}'s commits by ${bucket}`,
        bucket,
        starts: window.starts,
        note: window.note,
        hrefOf: (_start, days) => {
          const year = zoomPeriod(days, 4, (y) => years.includes(y));
          return year === null ? null : `#activity-${year}`;
        },
      },
    ),
    years: years.map((year) => ({
      anchor: `activity-${year}`,
      year,
      html: heatmap(Number(year), p.activity, `${p.name}'s commits in ${year}`),
    })),
    chronicle: claims("chronicle").map(claimHtml),
    areasHtml: claims("areas").length > 0 ? listHtml(claims("areas").map(claimHtml)) : null,
    areas: p.features.map((f) => ({
      feature: featureHtml(site, f.featureId),
      commits: formatNumber(f.commits),
      lines: formatNumber(f.currentLines),
      share: lineShare(f.currentLines, snapshot.featureLines[f.featureId] ?? 0),
    })),
    pulls: p.prsAuthored.map((pr) => ({
      number: pr.number,
      title: pr.title ?? `Pull request #${pr.number}`,
      merged: formatDate(pr.mergedAt),
      href: site.repoUrl === null ? null : `${site.repoUrl}/pull/${pr.number}`,
    })),
    references: (refs?.notes ?? []).map((note) => ({
      n: note.n,
      html: citationHtml(note.citation, site.repoUrl),
      backlinks: backlinksHtml(note),
    })),
    asOf:
      narrative === null
        ? "No narrative: the facts above are computed from the repository's history."
        : `Narrative as of ${formatDate(narrative.commitDate)} (${shortSha(narrative.sha)}).`,
    due:
      newer === 0
        ? null
        : `${counted(newer, "newer commit")} ${newer === 1 ? "is" : "are"} not yet in the narrative.`,
  };
}

/** The activity pages (spec v2 #6 §11, R22): all time, then each year and month with commits. */
export function activityRoutes(site: SiteModel): { period: string | undefined }[] {
  const people = site.wiki.people;
  if (people === null) return [];
  const days = activityDays(people);
  const years = [...new Set(days.map((d) => d.slice(0, 4)))];
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  return [{ period: undefined }, ...[...years, ...months].sort().map((period) => ({ period }))];
}

/** The head commit's day: the latest a chart draws (the Task 30 ruling). */
const headDay = (people: PeopleExport): string => people.snapshot.commitDate.slice(0, 10);

/**
 * Every day with a commit, the anonymous series' included, sorted, within the days a chart draws
 * (1970 to the head's day), so a crafted date gets no zoom page.
 */
function activityDays(people: PeopleExport): string[] {
  const { snapshot } = people;
  const last = headDay(people);
  return [
    ...new Set(
      [...snapshot.people.flatMap((p) => p.activity), ...snapshot.others]
        .map((d) => d.day)
        .filter((d) => d >= FIRST_CHART_DAY && d <= last),
    ),
  ].sort();
}

export interface ActivityView {
  /** Plain text. */
  title: string;
  /** Trusted HTML: the stacked chart. */
  chart: string;
  /** The zoom levels around this one: the period above, and the periods below with commits. */
  up: { label: string; href: string } | null;
  down: { label: string; href: string }[];
}

/**
 * /special/activity/[<yyyy>[-<mm>]]/: the repository's commits by person over the period, all
 * time by R22's bucket, a year by ISO week, a month by day; every bar leads one level down.
 */
export function activityView(
  site: SiteModel,
  people: PeopleExport,
  period: string | undefined,
): ActivityView {
  const active = new Set(
    activityRoutes(site).flatMap((r) => (r.period === undefined ? [] : [r.period])),
  );
  const all = chartWindow(
    [...people.snapshot.people.flatMap((p) => p.activity), ...people.snapshot.others],
    headDay(people),
  );
  const { from, to } = period === undefined ? all : periodDays(period);
  const bucket = period === undefined ? all.bucket : period.length === 4 ? "week" : "day";
  if (period !== undefined && !active.has(period))
    throw new Error(`no activity page for the period ${JSON.stringify(period)}`);
  const below = (_start: string, held: readonly ActivityDay[]): string | null => {
    // All time links each bar to the year holding most of its commits; a month is the finest.
    if (period === undefined) {
      const year = zoomPeriod(held, 4, (y) => active.has(y));
      return year === null ? null : activityUrl(year);
    }
    if (bucket === "day") return null;
    // A week leads to the month of this year holding most of its commits, when it has a page.
    const month = zoomPeriod(
      held.filter((d) => d.day.startsWith(`${period}-`)),
      7,
      (m) => active.has(m),
    );
    return month === null ? null : activityUrl(month);
  };
  const name =
    period === undefined
      ? null
      : period.length === 4
        ? period
        : bucketLabel(`${period}-01`, "month");
  const title = name === null ? "Activity" : `Activity in ${name}`;
  return {
    title,
    chart: barChart(repositorySeries(people.snapshot, from, to, personUrl), {
      label: `Commits to ${site.wiki.repo}${name === null ? "" : ` in ${name}`} by ${bucket}`,
      bucket,
      starts: period === undefined ? all.starts : bucketStarts(from, to, bucket),
      hrefOf: below,
      note: period === undefined ? all.note : null,
    }),
    up:
      period === undefined
        ? null
        : period.length === 4
          ? { label: "All time", href: activityUrl() }
          : { label: period.slice(0, 4), href: activityUrl(period.slice(0, 4)) },
    down: [...active]
      .filter((p) =>
        period === undefined ? p.length === 4 : p.length === 7 && p.startsWith(`${period}-`),
      )
      .sort()
      .map((p) => ({
        label: p.length === 4 ? p : bucketLabel(`${p}-01`, "month"),
        href: activityUrl(p),
      })),
  };
}
