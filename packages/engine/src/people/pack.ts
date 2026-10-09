import {
  type Manifest,
  type PeopleSnapshot,
  type PersonFacts,
  withoutEmails,
} from "@repowiki/core";
import type { AuthoredCommit } from "../index/index.ts";
import { estimateTokens } from "../manifest/index.ts";
import { clean } from "../write/index.ts";
import type { Refreshed } from "./refresh.ts";
import {
  type Landing,
  pullRequestAuthors,
  pullRequestLandings,
  topologicalNewestFirst,
} from "./snapshot.ts";

/** The pack's estimated token budget (spec v2 #6 §8.2). */
export const PERSON_BUDGET_TOKENS = 20_000;

/**
 * The most chronicle claims a narrative has, and so the most episodes a pack shows (the Task 18
 * ruling): past it, the oldest episodes are grouped (R15's collapse order), one claim a group.
 */
export const MAX_CHRONICLE_CLAIMS = 30;

/** Paths a commit line shows before "and N more". */
const MAX_PATHS = 5;
/** Merged pull requests the pack lists, newest kept (planner ruling R21). */
export const MAX_MERGED_LISTED = 50;
/** The longest subject, title or path a line shows, in UTF-16 units. */
const MAX_TEXT = 200;

export interface PackInput {
  person: PersonFacts;
  /** The person's identity group: commits whose groupOf is it are theirs. */
  group: number;
  /** readAuthorship at the snapshot's sha, newest first (topologicalNewestFirst). */
  commits: readonly AuthoredCommit[];
  groupOf: (c: AuthoredCommit) => number;
  /** computeSnapshot's commitFeatures (R19). */
  commitFeatures: ReadonlyMap<string, readonly string[]>;
  landings: ReadonlyMap<number, Landing>;
  /** Each pull request's author group (pullRequestAuthors). */
  prAuthors: ReadonlyMap<number, number>;
  snapshot: PeopleSnapshot;
  /** The head manifest, for feature titles. */
  manifest: Manifest;
  /** For an append (R25): the shas the stored narrative covers; only newer episodes are shown. */
  covered?: ReadonlySet<string> | null;
  budgetTokens?: number;
  /** The most episodes shown (MAX_CHRONICLE_CLAIMS; an append's room after its stored claims). */
  maxEpisodes?: number;
}

export interface PersonPack {
  personId: string;
  text: string;
  tokens: number;
  /** Every sha the pack shows, whole: the only ones a claim may cite (R17). */
  shas: Set<string>;
  /** The author date of each sha in `shas`, for R18's date check. */
  dates: Map<string, string>;
  /**
   * The head commit the round runs at (the snapshot's sha): the revision's basis (R25, the Task
   * 21 ruling), so every commit it reaches is covered, on any branch.
   */
  basis: string;
  /** The person's feature ids in the pack's order: what an areas section follows. */
  features: string[];
  /**
   * The citable merges of pull requests the person merged but did not write (the I2 ruling):
   * they credit the person with the merge only, never with the pull request's features.
   */
  mergedOnly: Set<string>;
  /**
   * Headings shown in full, episodes collapsed to one line, and periods listing fewer subjects
   * than they hold (R8.2's trimming, which drops nothing: #616).
   */
  episodes: { full: number; collapsed: number; shortened: number };
}

/** How much of a repository string packText reads, in code points, before anything else. */
const MAX_READ = 1000;

/**
 * Repository text as one line of the pack: no email, no break, nothing that forges structure. It
 * cuts first (so a long unbroken token costs nothing), scrubs emails, makes one clean line, cuts
 * to `max` UTF-16 units well formed, and scrubs again in case the cut made a new address.
 */
export const packText = (text: string, max = MAX_TEXT): string => {
  const head =
    text.length <= MAX_READ ? text : [...text.slice(0, 2 * MAX_READ)].slice(0, MAX_READ).join("");
  const line = clean(
    withoutEmails(head)
      .replace(/[\s\u0085]+/g, " ")
      .trim(),
  );
  return withoutEmails(line.length <= max ? line : `${line.slice(0, max - 1).toWellFormed()}…`);
};

const day = (iso: string) => iso.slice(0, 10);
const sha12 = (sha: string) => sha.slice(0, 12);
const quoted = (text: string) => `"${packText(text).replace(/"/g, "'")}"`;

/** `basis` and every commit it reaches: what a narrative with that basis covers. */
export function ancestorsOf(commits: readonly AuthoredCommit[], basis: string): Set<string> {
  const parents = new Map(commits.map((c) => [c.sha, c.parents]));
  const seen = new Set<string>();
  const stack = [basis];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha) || !parents.has(sha)) continue;
    seen.add(sha);
    stack.push(...(parents.get(sha) ?? []));
  }
  return seen;
}

interface Episode {
  /** `PR #n "title"`, "Commits outside pull requests, yyyy-mm" or "Changes in <period>". */
  name: string;
  /** A pull request's "merged yyyy-mm-dd" (with its citable merge), or null for a month. */
  merged: string | null;
  /** The heading's own citable shas (an authored or merged PR's merge commit): none, or one each. */
  landings: { sha: string; date: string }[];
  /** Oldest first; a period's largest change first (bySize). */
  commits: AuthoredCommit[];
  /**
   * When the work started: its first commit's author date, the day the pack prints and R18
   * checks claims against. Periods follow it.
   */
  started: string;
  /** True for a period: the episodes of a month, quarter, year or span, grouped. */
  period: boolean;
}

const MONTHS = [
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

/** An episode's period: its start (to sort by) and its label, which counts nothing. */
type Period = (e: Episode) => { start: number; label: string };
/** The calendar day `started` prints, in the author's own offset, as a UTC date to count with. */
const utc = (e: Episode) => new Date(Date.parse(`${e.started.slice(0, 10)}T00:00:00Z`) || 0);
const dayOf = (y: number, m: number, d: number) => {
  const at = new Date(Date.UTC(y, m, d));
  return {
    start: at.getTime(),
    name: `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`,
  };
};
const oneDay: Period = (e) => {
  const d = utc(e);
  const { start, name } = dayOf(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start, label: `on ${name}` };
};
/** An ISO week, Monday first, named by its Monday. */
const week: Period = (e) => {
  const d = utc(e);
  const monday = d.getUTCDate() - ((d.getUTCDay() + 6) % 7);
  const { start, name } = dayOf(d.getUTCFullYear(), d.getUTCMonth(), monday);
  return { start, label: `in the week of ${name}` };
};
const month: Period = (e) => {
  const d = utc(e);
  const [y, m] = [d.getUTCFullYear(), d.getUTCMonth()];
  return { start: Date.UTC(y, m), label: `in ${MONTHS[m]} ${y}` };
};
const quarter: Period = (e) => {
  const d = utc(e);
  const [y, q] = [d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3)];
  return { start: Date.UTC(y, 3 * q), label: `in Q${q + 1} ${y}` };
};
const year: Period = (e) => {
  const y = utc(e).getUTCFullYear();
  return { start: Date.UTC(y, 0), label: `in ${y}` };
};

/** A change's size: lines added plus removed (a binary change counts none). */
const sizeOf = (c: AuthoredCommit) =>
  c.files.reduce((n, f) => n + (f.added ?? 0) + (f.deleted ?? 0), 0);
/** A period's representative order: the largest change first, then the oldest, then by sha. */
const bySize = (a: AuthoredCommit, b: AuthoredCommit) =>
  sizeOf(b) - sizeOf(a) ||
  Date.parse(a.authorDate) - Date.parse(b.authorDate) ||
  (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0);

/**
 * Episodes grouped by `period`, oldest period first: each carries every member commit, and a
 * period of one episode is that episode.
 */
function periodsOf(members: readonly Episode[], period: Period): Episode[] {
  const groups = new Map<number, { label: string; members: Episode[] }>();
  for (const e of members) {
    const { start, label } = period(e);
    const group = groups.get(start) ?? { label, members: [] };
    group.members.push(e);
    groups.set(start, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, g]) =>
      g.members.length === 1
        ? (g.members[0] as Episode)
        : {
            name: `Changes ${g.label}`,
            merged: null,
            landings: [],
            commits: g.members.flatMap((m) => m.commits).sort(bySize),
            started: g.members[0]?.started ?? "",
            period: true,
          },
    );
}

/**
 * At most `limit` headings, oldest first (the Task 18 ruling): past it, every episode is grouped
 * by the finest of day, week, month, quarter and year that fits, the newest too, so the whole
 * span is grouped alike; past even one a year, the oldest years share one span. Each episode is
 * placed by the day its first commit was written; commits outside pull requests one by one.
 */
function capped(grouped: readonly Episode[], limit: number): Episode[] {
  if (grouped.length <= limit) return [...grouped];
  const episodes = grouped.flatMap((e) =>
    e.merged === null ? e.commits.map((c) => ({ ...e, commits: [c], started: c.authorDate })) : [e],
  );
  for (const period of [oneDay, week, month, quarter, year])
    if (new Set(episodes.map((e) => period(e).start)).size <= limit)
      return periodsOf(episodes, period);
  const years = [...new Set(episodes.map((e) => utc(e).getUTCFullYear()))].sort((a, b) => a - b);
  const [first, last] = [years[0] as number, years[years.length - limit] as number];
  const span: Period = (e) =>
    utc(e).getUTCFullYear() > last
      ? year(e)
      : { start: Date.UTC(first, 0), label: `from ${first} to ${last}` };
  return periodsOf(episodes, span);
}

/**
 * The person's user turn (spec v2 #6 §8.2): who they are, their features, their episodes oldest
 * first (a pull request's commits together, the rest by month; past the cap, all grouped by
 * period), and the pull requests they merged but did not write. The text never says "episode".
 * Every repository string is one neutralised line (packText). Over the budget, the periods showing
 * the most subjects lose one at a time, down to one each, then the oldest episodes are collapsed
 * to one line; no period or episode is ever dropped (#616), even past the budget. Every sha the
 * pack shows is citable and no other is (R17).
 */
export function buildPersonPack(input: PackInput): PersonPack {
  const { person, snapshot } = input;
  const budget = input.budgetTokens ?? PERSON_BUDGET_TOKENS;
  const titles = new Map(input.manifest.features.map((f) => [f.id, f.title]));
  const mine = input.commits.filter(
    (c) => c.parents.length <= 1 && input.groupOf(c) === input.group,
  );
  const fresh = mine.filter((c) => input.covered?.has(c.sha) !== true);
  const shown = [...fresh].reverse();
  const basis = input.snapshot.sha;

  // Episodes: a pull request's commits together, the rest by author month.
  const mergedOnly = new Set<string>();
  const byKey = new Map<string, Episode>();
  for (const commit of shown) {
    const landing = commit.pr === null ? undefined : input.landings.get(commit.pr);
    let key: string;
    let name: string;
    let merged: string | null = null;
    let own: { sha: string; date: string } | null = null;
    if (landing !== undefined) {
      key = `pr-${landing.number}`;
      const citable =
        landing.sha !== commit.sha &&
        (input.prAuthors.get(landing.number) === input.group || landing.merger === input.group);
      if (citable) own = { sha: landing.sha, date: landing.mergedAt };
      if (citable && input.prAuthors.get(landing.number) !== input.group)
        mergedOnly.add(landing.sha);
      name = `PR #${landing.number}${landing.title === null ? "" : ` ${quoted(landing.title)}`}`;
      merged = `merged ${day(landing.mergedAt)}${own === null ? "" : ` (commit:${sha12(own.sha)})`}`;
    } else {
      key = `month-${commit.authorDate.slice(0, 7)}`;
      name = `Commits outside pull requests, ${commit.authorDate.slice(0, 7)}`;
    }
    const episode: Episode = byKey.get(key) ?? {
      name,
      merged,
      landings: own === null ? [] : [own],
      commits: [],
      started: commit.authorDate,
      period: false,
    };
    episode.commits.push(commit);
    byKey.set(key, episode);
  }
  const episodes = capped(
    [...byKey.values()].sort(
      (a, b) =>
        Date.parse(a.commits[0]?.authorDate ?? "") - Date.parse(b.commits[0]?.authorDate ?? "") ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    ),
    Math.max(1, Math.floor(input.maxEpisodes ?? MAX_CHRONICLE_CLAIMS)),
  );

  const commitLine = (c: AuthoredCommit) => {
    const features = input.commitFeatures.get(c.sha) ?? [];
    const paths = c.files.slice(0, MAX_PATHS).map((f) => quoted(f.path));
    const more = c.files.length > MAX_PATHS ? `, and ${c.files.length - MAX_PATHS} more` : "";
    return `- commit:${sha12(c.sha)} ${day(c.authorDate)} ${quoted(c.subject)} — features: ${features.length === 0 ? "none" : features.join(", ")} — files: ${paths.join(", ") || "none"}${more}`;
  };
  const rangeOf = (e: Episode) => {
    const first = day(e.commits[0]?.authorDate ?? "");
    const last = day(e.commits.at(-1)?.authorDate ?? "");
    return first === last ? first : `${first} to ${last}`;
  };
  const heading = (e: Episode) =>
    `${e.name}${e.merged === null ? "" : `, ${rangeOf(e)}, ${e.merged}`}`;
  const full = (e: Episode) => [`### ${heading(e)}`, ...e.commits.map(commitLine)];
  const collapsed = (e: Episode) => {
    const first = e.commits[0] as AuthoredCommit;
    const last = e.commits.at(-1) as AuthoredCommit;
    const ends =
      first === last
        ? `commit:${sha12(first.sha)}`
        : `commit:${sha12(first.sha)} … commit:${sha12(last.sha)}`;
    const merged =
      e.landings.length === 0
        ? ""
        : ` (merged: ${e.landings.map((l) => `commit:${sha12(l.sha)}`).join(", ")})`;
    return [
      `- ${e.name}, ${rangeOf(e).replace(" to ", "–")}, ${e.commits.length} ${e.commits.length === 1 ? "commit" : "commits"}: ${ends}${merged}`,
    ];
  };

  // Header and the merged list: never trimmed.
  const others =
    person.otherNames.length === 0
      ? ""
      : ` (other names: ${person.otherNames.map((n) => packText(n)).join(", ")})`;
  const header = [
    `# Person: ${packText(person.name)}${others}`,
    `Active between ${day(person.firstCommit)} and ${day(person.lastCommit)} (author dates).`,
    "## Features (id — title — their commits — share of current lines)",
    ...person.features.map((f) => {
      const total = snapshot.featureLines[f.featureId] ?? 0;
      const share = total === 0 ? 0 : Math.round((100 * f.currentLines) / total);
      return `- ${f.featureId} — ${packText(titles.get(f.featureId) ?? f.featureId)} — ${f.commits} — ${share}%`;
    }),
    input.covered == null ? "## Work, oldest first" : "## New work, oldest first",
  ];
  const mergedLandings = [...input.landings.values()]
    // Only those someone else wrote: a pull request of their own is an episode (the I2 ruling).
    .filter(
      (l) =>
        l.merger === input.group &&
        input.prAuthors.get(l.number) !== input.group &&
        input.covered?.has(l.sha) !== true,
    )
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.number - b.number)
    .slice(-MAX_MERGED_LISTED);
  const merged =
    mergedLandings.length === 0
      ? []
      : [
          `### Pull requests they merged: ${mergedLandings
            .map(
              (l) =>
                `#${l.number}${l.title === null ? "" : ` ${quoted(l.title)}`} ${day(l.mergedAt)} (commit:${sha12(l.sha)})`,
            )
            .join(", ")}`,
        ];

  // Trim: periods list fewer subjects, down to one each, then the oldest episodes collapse to
  // one line; nothing is dropped, so past the budget the shortest form stays. Each line is
  // rendered once and the text's length kept as a running sum, so the loop is linear (times the
  // at most 30 periods); estimateTokens of the joined text is exactly what this sum gives.
  const fullLines = episodes.map(full);
  const collapsedLines = episodes.map(collapsed);
  const size = (lines: readonly string[]) => lines.reduce((n, l) => n + l.length + 1, 0);
  const fullSize = fullLines.map(size);
  const collapsedSize = collapsedLines.map(size);
  const fixed = size(header) + size(merged);
  let body = fullSize.reduce((a, b) => a + b, 0);
  const over = () => Math.ceil(Math.max(0, fixed + body - 1) / 2.5) > budget;
  /** Lines each heading shows: a period's heading and its first subjects, or an episode whole. */
  const kept = fullLines.map((lines) => lines.length);
  // Proportionally: one subject at a time from the period showing the most, the oldest on a tie.
  const periods = episodes.flatMap((e, i) => (e.period ? [i] : []));
  while (over()) {
    let i = -1;
    for (const j of periods) if ((kept[j] as number) > Math.max(2, kept[i] ?? 0)) i = j;
    if (i === -1) break;
    kept[i] = (kept[i] as number) - 1;
    body -= ((fullLines[i] as string[])[kept[i] as number] as string).length + 1;
  }
  const isCollapsed = episodes.map(() => false);
  episodes.forEach((e, i) => {
    if (e.period || !over()) return;
    body += (collapsedSize[i] ?? 0) - (fullSize[i] ?? 0);
    isCollapsed[i] = true;
  });
  const text = [
    ...header,
    ...episodes.flatMap((_, i) =>
      isCollapsed[i] ? (collapsedLines[i] ?? []) : (fullLines[i] ?? []).slice(0, kept[i]),
    ),
    ...merged,
  ].join("\n");

  // The citable set: exactly the shas the text shows.
  const shas = new Set<string>();
  const dates = new Map<string, string>();
  const cite = (sha: string, date: string) => {
    shas.add(sha);
    dates.set(sha, date);
  };
  episodes.forEach((e, i) => {
    const commits = isCollapsed[i]
      ? [e.commits[0] as AuthoredCommit, e.commits.at(-1) as AuthoredCommit]
      : e.commits.slice(0, (kept[i] as number) - 1);
    for (const c of commits) cite(c.sha, c.authorDate);
    for (const l of e.landings) cite(l.sha, l.date);
  });
  for (const l of mergedLandings) {
    cite(l.sha, l.mergedAt);
    mergedOnly.add(l.sha);
  }
  return {
    personId: person.id,
    features: person.features.map((f) => f.featureId),
    text,
    tokens: estimateTokens(text),
    shas,
    dates,
    basis,
    mergedOnly: new Set([...mergedOnly].filter((sha) => shas.has(sha))),
    episodes: {
      full: episodes.filter((e, i) => !isCollapsed[i] && kept[i] === e.commits.length + 1).length,
      collapsed: isCollapsed.filter(Boolean).length,
      shortened: episodes.filter((e, i) => kept[i] !== e.commits.length + 1).length,
    },
  };
}

/**
 * The pack of the person `personId` from a refresh (refreshPeople's result), or null when the
 * snapshot has no such human. `covered`, `budgetTokens` and `maxEpisodes` as buildPersonPack
 * takes them.
 */
export function packFor(
  refreshed: Refreshed,
  personId: string,
  manifest: Manifest,
  options: {
    covered?: ReadonlySet<string> | null;
    budgetTokens?: number;
    maxEpisodes?: number;
  } = {},
): PersonPack | null {
  const person = refreshed.snapshot.people.find((p) => p.id === personId && p.kind === "human");
  const group = refreshed.assigned.ids.indexOf(personId);
  if (person === undefined || group === -1) return null;
  const commits = topologicalNewestFirst(refreshed.commits);
  const groupOf = (c: AuthoredCommit) => refreshed.identities.groupOf(c.authorName, c.authorEmail);
  const landings = pullRequestLandings(commits, groupOf);
  return buildPersonPack({
    person,
    group,
    commits,
    groupOf,
    commitFeatures: refreshed.commitFeatures,
    landings,
    prAuthors: pullRequestAuthors(landings, commits, groupOf),
    snapshot: refreshed.snapshot,
    manifest,
    ...options,
  });
}
