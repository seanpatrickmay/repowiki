import { type ActivityDay, INVISIBLE_CHARACTERS, type PeopleSnapshot } from "@repowiki/core";
import { formatNumber } from "./format.ts";
import { escapeHtml } from "./inline.ts";

/**
 * Text as SVG character data or an attribute value (spec v2 #6 §11): `& < > " '` escaped, every
 * invisible and control character dropped (they could hide or reorder a name), lone surrogates
 * replaced. Every repository string in a chart goes through it.
 */
export function xmlText(text: string): string {
  return text
    .toWellFormed()
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** A chart's href, in the SVG and the legend alike: one escaper (the Task 30 ruling). */
const hrefText = xmlText;

/** Text as HTML in a chart's legend and table: escaped, with the same characters dropped. */
const htmlText = (text: string): string =>
  escapeHtml(text.toWellFormed().replace(INVISIBLE_CHARACTERS, ""));

/** The bucket a bar covers (R22). */
export type Bucket = "day" | "week" | "month" | "quarter" | "year";
const BUCKETS: readonly Bucket[] = ["day", "week", "month", "quarter", "year"];
/** The most bars an all-time chart draws (R22). */
export const MAX_BARS = 120;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const toMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parts = (day: string) => day.split("-").map(Number) as [number, number, number];

/** The first calendar day of the bucket holding `day`; ISO weeks start on Monday. */
export function bucketStart(day: string, bucket: Bucket): string {
  const [y, m] = parts(day);
  if (bucket === "day") return day;
  if (bucket === "month") return `${y}-${pad(m)}-01`;
  if (bucket === "quarter") return `${y}-${pad(m - ((m - 1) % 3))}-01`;
  if (bucket === "year") return `${y}-01-01`;
  const ms = toMs(day);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  return toDay(ms - weekday * DAY_MS);
}

/** The first day of the bucket after the one starting at `start`. */
function nextStart(start: string, bucket: Bucket): string {
  const [y, m] = parts(start);
  if (bucket === "day") return toDay(toMs(start) + DAY_MS);
  if (bucket === "week") return toDay(toMs(start) + 7 * DAY_MS);
  const step = bucket === "month" ? 1 : bucket === "quarter" ? 3 : 12;
  return toDay(Date.UTC(y, m - 1 + step, 1));
}

/**
 * Every bucket start from the one holding `from` to the one holding `to`, in order, at most
 * `limit` of them. Dates are compared as parsed times, never as strings (the Task 30 ruling).
 */
export function bucketStarts(
  from: string,
  to: string,
  bucket: Bucket,
  limit = Number.POSITIVE_INFINITY,
): string[] {
  const starts: string[] = [];
  const last = toMs(bucketStart(to, bucket));
  for (
    let at = bucketStart(from, bucket);
    toMs(at) <= last && starts.length < limit;
    at = nextStart(at, bucket)
  )
    starts.push(at);
  return starts;
}

/** The smallest bucket that draws `from` to `to` in at most MAX_BARS bars (R22), else years. */
export function bucketFor(from: string, to: string): Bucket {
  return BUCKETS.find((b) => bucketStarts(from, to, b, MAX_BARS + 1).length <= MAX_BARS) ?? "year";
}

/** The earliest day a chart draws: git dates start in 1970 (the Task 30 ruling). */
export const FIRST_CHART_DAY = "1970-01-01";

/** What a chart draws: its days, bucket and bars, and the commits it leaves out. */
export interface ChartWindow {
  from: string;
  to: string;
  bucket: Bucket;
  starts: string[];
  /** Commits dated outside the window: counted, not drawn. */
  outside: number;
  /** The note under a chart that leaves commits out, or null. */
  note: string | null;
}

/**
 * The window a chart of `activity` draws (the Task 30 ruling): its days clamped to 1970-01-01 and
 * the head's date (a crafted commit date must not hang or break the build), bucketed by R22's
 * rule, and when even years pass MAX_BARS, only the latest MAX_BARS years. Commits left out are
 * counted, and the note says so. With no day inside, the head's day alone.
 */
export function chartWindow(activity: readonly ActivityDay[], head: string): ChartWindow {
  const last = toMs(head) >= toMs(FIRST_CHART_DAY) ? head : FIRST_CHART_DAY;
  const inside = activity
    .map((d) => d.day)
    .filter((d) => toMs(d) >= toMs(FIRST_CHART_DAY) && toMs(d) <= toMs(last));
  const to = inside.reduce((a, b) => (toMs(b) > toMs(a) ? b : a), inside[0] ?? last);
  let from = inside.reduce((a, b) => (toMs(b) < toMs(a) ? b : a), inside[0] ?? last);
  const bucket = bucketFor(from, to);
  let starts = bucketStarts(from, to, bucket);
  const cut = starts.length > MAX_BARS;
  if (cut) {
    starts = starts.slice(-MAX_BARS);
    from = starts[0] as string;
  }
  const outside = activity
    .filter((d) => !(toMs(d.day) >= toMs(from) && toMs(d.day) <= toMs(to)))
    .reduce((n, d) => n + d.commits, 0);
  const floor = cut ? from.slice(0, 4) : FIRST_CHART_DAY.slice(0, 4);
  const note =
    outside === 0
      ? null
      : `${counted(outside)} dated before ${floor} or after the head's date ${outside === 1 ? "is" : "are"} not drawn.`;
  return { from, to, bucket, starts, outside, note };
}

/** "9 Mar 2026", "Week of 9 Mar 2026", "March 2026" or "Q1 2026": a bar's period. */
export function bucketLabel(start: string, bucket: Bucket): string {
  const [y, m, d] = parts(start);
  const date = `${d} ${MONTHS[m - 1]} ${y}`;
  if (bucket === "day") return date;
  if (bucket === "week") return `Week of ${date}`;
  if (bucket === "month") return `${MONTH_NAMES[m - 1]} ${y}`;
  if (bucket === "year") return String(y);
  return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
}

/** One bar: a bucket's totals. */
export interface Bar {
  start: string;
  commits: number;
  added: number;
  deleted: number;
}

/** A series' activity summed into the given buckets (empty buckets included, so they align). */
export function barsOf(
  activity: readonly ActivityDay[],
  starts: readonly string[],
  bucket: Bucket,
): Bar[] {
  const at = new Map(starts.map((start) => [start, { start, commits: 0, added: 0, deleted: 0 }]));
  for (const day of activity) {
    const bar = at.get(bucketStart(day.day, bucket));
    if (bar === undefined) continue;
    bar.commits += day.commits;
    bar.added += day.added;
    bar.deleted += day.deleted;
  }
  return [...at.values()];
}

const counted = (n: number) => `${formatNumber(n)} ${n === 1 ? "commit" : "commits"}`;
/** "Week of 9 Mar 2026: 12 commits, +840 −120 lines" (spec v2 #6 §11). */
export const barTitle = (label: string, bar: Omit<Bar, "start">): string =>
  `${label}: ${counted(bar.commits)}, +${formatNumber(bar.added)} −${formatNumber(bar.deleted)} lines`;

/**
 * The year (`unit` 4) or month (`unit` 7) holding most of a bar's commits, the earlier on a tie,
 * when `built` says it has a page or an anchor; else null (the Task 32 and 34 rulings). Every
 * chart's zoom link goes through it, so a week starting in another period leads to its commits.
 */
export function zoomPeriod(
  days: readonly ActivityDay[],
  unit: 4 | 7,
  built: (period: string) => boolean,
): string | null {
  const by = new Map<string, number>();
  for (const d of days)
    by.set(d.day.slice(0, unit), (by.get(d.day.slice(0, unit)) ?? 0) + d.commits);
  const best = [...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return best !== undefined && best[1] > 0 && built(best[0]) ? best[0] : null;
}

/** One series of a chart; `cls` names its CSS colour (`series-1` … `series-8`, `others`, `bots`). */
export interface Series {
  label: string;
  href: string | null;
  cls: string;
  activity: readonly ActivityDay[];
}

export interface ChartOptions {
  /** The chart's accessible name, plain text. */
  label: string;
  bucket: Bucket;
  starts: readonly string[];
  /**
   * Where a bar leads: the next zoom level, or null for the finest. Gets the bar's days with
   * commits, every series' (zoomPeriod reads them).
   */
  hrefOf: (start: string, days: readonly ActivityDay[]) => string | null;
  /** A plain-text note printed under the chart (ChartWindow's), or none. */
  note?: string | null;
}

const WIDTH = 720;
const HEIGHT = 160;
/** The least height a bar with a commit is drawn at, so a one-commit bar shows (Task 30). */
const MIN_BAR = 2;

/**
 * A bar chart as inline SVG (R21): one stack of series per bucket, each bucket an `<a>` to its
 * next zoom level (when there is one) wrapping its rects, each with a `<title>`; then a legend of
 * the series (linked when they have a page) and a visually hidden table of the same numbers. A
 * fixed viewBox scales by CSS. Returns trusted HTML.
 */
export function barChart(series: readonly Series[], options: ChartOptions): string {
  const { starts, bucket } = options;
  const bars = series.map((s) => barsOf(s.activity, starts, bucket));
  const totals = starts.map((start, i) => ({
    start,
    commits: bars.reduce((n, b) => n + (b[i]?.commits ?? 0), 0),
    added: bars.reduce((n, b) => n + (b[i]?.added ?? 0), 0),
    deleted: bars.reduce((n, b) => n + (b[i]?.deleted ?? 0), 0),
  }));
  const max = Math.max(1, ...totals.map((t) => t.commits));
  const width = WIDTH / Math.max(1, starts.length);
  const groups = totals.map((total, i) => {
    const label = bucketLabel(total.start, bucket);
    const x = (i * width).toFixed(2);
    const w = Math.max(0.5, width - 1).toFixed(2);
    let y = HEIGHT;
    const rects = series.flatMap((s, k) => {
      const bar = bars[k]?.[i];
      if (bar === undefined || bar.commits === 0) return [];
      const h = Math.max(MIN_BAR, (bar.commits / max) * (HEIGHT - 4));
      // A raised short segment can push a full stack's top past the edge: keep it inside.
      y = Math.max(0, y - h);
      const name = series.length > 1 ? `${s.label}, ${label}` : label;
      return [
        `<rect class="${s.cls}" x="${x}" y="${y.toFixed(2)}" width="${w}" height="${h.toFixed(2)}"><title>${xmlText(barTitle(name, bar))}</title></rect>`,
      ];
    });
    const hit = `<rect class="bar-hit" x="${x}" y="0" width="${w}" height="${HEIGHT}"><title>${xmlText(barTitle(label, total))}</title></rect>`;
    const body = `${hit}${rects.join("")}`;
    const href =
      total.commits === 0
        ? null
        : options.hrefOf(
            total.start,
            series.flatMap((s) =>
              s.activity.filter((d) => d.commits > 0 && bucketStart(d.day, bucket) === total.start),
            ),
          );
    return href === null ? `<g>${body}</g>` : `<a href="${hrefText(href)}">${body}</a>`;
  });
  const svg = `<svg class="activity-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${xmlText(options.label)}" preserveAspectRatio="none">${groups.join("")}</svg>`;
  const legend =
    series.length < 2
      ? ""
      : `<ul class="chart-legend">${series
          .map((s) => {
            const name = htmlText(s.label);
            const text = s.href === null ? name : `<a href="${hrefText(s.href)}">${name}</a>`;
            return `<li><span class="swatch ${s.cls}" aria-hidden="true"></span>${text}</li>`;
          })
          .join("")}</ul>`;
  const note =
    options.note == null
      ? ""
      : `<figcaption class="chart-note">${htmlText(options.note)}</figcaption>`;
  return `<figure class="activity">${svg}${legend}${chartTable(series, bars, totals, options)}${note}</figure>`;
}

/** The visually hidden table after a chart: the same numbers, one row per bucket with activity. */
function chartTable(
  series: readonly Series[],
  bars: readonly Bar[][],
  totals: readonly Bar[],
  options: ChartOptions,
): string {
  const head =
    series.length > 1
      ? `${series.map((s) => `<th scope="col">${htmlText(s.label)}</th>`).join("")}<th scope="col">Commits</th>`
      : `<th scope="col">Commits</th>`;
  const rows = totals.flatMap((total, i) => {
    if (total.commits === 0) return [];
    const per =
      series.length > 1
        ? series.map((_, k) => `<td>${formatNumber(bars[k]?.[i]?.commits ?? 0)}</td>`).join("")
        : "";
    return [
      `<tr><th scope="row">${escapeHtml(bucketLabel(total.start, options.bucket))}</th>${per}<td>${formatNumber(total.commits)}</td><td>${formatNumber(total.added)}</td><td>${formatNumber(total.deleted)}</td></tr>`,
    ];
  });
  return `<table class="visually-hidden"><caption>${htmlText(options.label)}</caption><thead><tr><th scope="col">Period</th>${head}<th scope="col">Lines added</th><th scope="col">Lines removed</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

const CELL = 12;
const GAP = 2;
/** A heatmap cell's colour level by commits that day: 0, 1, 2-3, 4-6, 7 or more. */
export const heatLevel = (commits: number): number =>
  commits === 0 ? 0 : commits === 1 ? 1 : commits <= 3 ? 2 : commits <= 6 ? 3 : 4;

/**
 * One year's weekday-by-week calendar heatmap (R21): a column per ISO week from the week holding
 * 1 January, a row per weekday from Monday, a cell per day of the year with its `<title>`; then
 * the visually hidden table of the days with activity. Returns trusted HTML.
 */
export function heatmap(year: number, activity: readonly ActivityDay[], label: string): string {
  const byDay = new Map(activity.map((d) => [d.day, d]));
  const first = `${year}-01-01`;
  const origin = toMs(bucketStart(first, "week"));
  const cells: string[] = [];
  let weeks = 0;
  for (let ms = toMs(first); toDay(ms) <= `${year}-12-31`; ms += DAY_MS) {
    const day = toDay(ms);
    const week = Math.floor((ms - origin) / (7 * DAY_MS));
    const weekday = (new Date(ms).getUTCDay() + 6) % 7;
    weeks = Math.max(weeks, week + 1);
    const d = byDay.get(day);
    const bar = { commits: d?.commits ?? 0, added: d?.added ?? 0, deleted: d?.deleted ?? 0 };
    cells.push(
      `<rect class="heat-${heatLevel(bar.commits)}" x="${week * (CELL + GAP)}" y="${weekday * (CELL + GAP)}" width="${CELL}" height="${CELL}"><title>${xmlText(barTitle(bucketLabel(day, "day"), bar))}</title></rect>`,
    );
  }
  const svg = `<svg class="activity-heatmap" viewBox="0 0 ${weeks * (CELL + GAP)} ${7 * (CELL + GAP)}" role="img" aria-label="${xmlText(label)}">${cells.join("")}</svg>`;
  const rows = activity
    .filter((d) => d.day.startsWith(`${year}-`))
    .map(
      (d) =>
        `<tr><th scope="row">${escapeHtml(bucketLabel(d.day, "day"))}</th><td>${formatNumber(d.commits)}</td><td>${formatNumber(d.added)}</td><td>${formatNumber(d.deleted)}</td></tr>`,
    );
  const table = `<table class="visually-hidden"><caption>${htmlText(label)}</caption><thead><tr><th scope="col">Day</th><th scope="col">Commits</th><th scope="col">Lines added</th><th scope="col">Lines removed</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  return `<figure class="activity">${svg}${table}</figure>`;
}

/** A row's decorative sparkline: monthly commits over the given range, hidden from readers. */
export function sparkline(activity: readonly ActivityDay[], from: string, to: string): string {
  const starts = bucketStarts(from, to, bucketFor(from, to));
  const bars = barsOf(activity, starts, bucketFor(from, to));
  const max = Math.max(1, ...bars.map((b) => b.commits));
  const w = 100 / Math.max(1, bars.length);
  const rects = bars
    .filter((b) => b.commits > 0)
    .map((b) => {
      const i = starts.indexOf(b.start);
      const h = (b.commits / max) * 20;
      return `<rect x="${(i * w).toFixed(2)}" y="${(20 - h).toFixed(2)}" width="${Math.max(0.5, w).toFixed(2)}" height="${h.toFixed(2)}"/>`;
    });
  return `<svg class="sparkline" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">${rects.join("")}</svg>`;
}

/** The days a year's or a month's page covers: `2026` or `2026-03`. */
export function periodDays(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number) as [number, number | undefined];
  if (m === undefined) return { from: `${y}-01-01`, to: `${y}-12-31` };
  return {
    from: `${y}-${pad(m)}-01`,
    to: `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`,
  };
}

/** The people a repository chart names, each with their own colour (spec v2 #6 §11). */
export const MAX_NAMED_SERIES = 8;

/**
 * A repository chart's series over `from`..`to` (spec v2 #6 §11): the MAX_NAMED_SERIES humans
 * with the most commits in the range (ties by id), each linked to their page; then "Others" (every
 * other human and the anonymous series of excluded people); then "Bots". A series with no commit
 * in the range is left out.
 */
export function repositorySeries(
  snapshot: PeopleSnapshot,
  from: string,
  to: string,
  hrefOf: (personId: string) => string,
): Series[] {
  const inRange = (activity: readonly ActivityDay[]) =>
    activity.filter((d) => d.day >= from && d.day <= to);
  const commits = (activity: readonly ActivityDay[]) =>
    inRange(activity).reduce((n, d) => n + d.commits, 0);
  const humans = snapshot.people
    .filter((p) => p.kind === "human" && commits(p.activity) > 0)
    .sort((a, b) => commits(b.activity) - commits(a.activity) || (a.id < b.id ? -1 : 1));
  const named = humans.slice(0, MAX_NAMED_SERIES);
  const rest = [...humans.slice(MAX_NAMED_SERIES).map((p) => p.activity), snapshot.others];
  const bots = snapshot.people.filter((p) => p.kind === "bot").map((p) => p.activity);
  const merged = (lists: readonly (readonly ActivityDay[])[]): ActivityDay[] => {
    const days = new Map<string, ActivityDay>();
    for (const day of lists.flat().filter((d) => d.day >= from && d.day <= to)) {
      const was = days.get(day.day) ?? { day: day.day, commits: 0, added: 0, deleted: 0 };
      days.set(day.day, {
        day: day.day,
        commits: was.commits + day.commits,
        added: was.added + day.added,
        deleted: was.deleted + day.deleted,
      });
    }
    return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  };
  const series: Series[] = named.map((p, i) => ({
    label: p.name,
    href: hrefOf(p.id),
    cls: `series-${i + 1}`,
    activity: inRange(p.activity),
  }));
  const others = merged(rest);
  if (others.length > 0)
    series.push({ label: "Others", href: null, cls: "others", activity: others });
  const automated = merged(bots);
  if (automated.length > 0)
    series.push({ label: "Bots", href: null, cls: "bots", activity: automated });
  return series;
}
