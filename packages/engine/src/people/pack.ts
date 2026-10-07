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
  /** The newest of the person's commits the narrative will cover: the revision's basis (R25). */
  basis: string;
  /** Episodes shown in full, collapsed to one line, and dropped (R8.2's trimming). */
  episodes: { full: number; collapsed: number; dropped: number };
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
  /** `PR #n "title"` or "Commits outside pull requests, yyyy-mm": each part already packText. */
  name: string;
  /** A pull request's "merged yyyy-mm-dd" (with its citable merge), or null for a month. */
  merged: string | null;
  /** The heading's own citable shas (an authored or merged PR's merge commit): none, or one each. */
  landings: { sha: string; date: string }[];
  /** Oldest first. */
  commits: AuthoredCommit[];
  /** For a group of episodes, each member's name (and merge); null for one episode. */
  parts: string[] | null;
}

/** Episodes as one: their commits oldest first, their landings, and each one's name. */
function groupOf(members: readonly Episode[]): Episode {
  if (members.length === 1) return members[0] as Episode;
  return {
    name: `${members.length} episodes grouped`,
    merged: null,
    landings: members.flatMap((m) => m.landings),
    commits: members
      .flatMap((m) => m.commits)
      .sort((a, b) => Date.parse(a.authorDate) - Date.parse(b.authorDate)),
    parts: members.map((m) => (m.merged === null ? m.name : `${m.name}, ${m.merged}`)),
  };
}

/**
 * At most `limit` episodes, oldest first: past it, the oldest are grouped into runs of equal
 * size (R15's collapse order) until the count fits, so the newest stay apart longest.
 */
function capped(episodes: readonly Episode[], limit: number): Episode[] {
  if (episodes.length <= limit) return [...episodes];
  const size = Math.ceil(episodes.length / limit);
  const out: Episode[] = [];
  let i = 0;
  while (out.length + (episodes.length - i) > limit) {
    out.push(groupOf(episodes.slice(i, i + size)));
    i += size;
  }
  return [...out, ...episodes.slice(i)];
}

/**
 * The person's user turn (spec v2 #6 §8.2): who they are, their features, their episodes oldest
 * first (a pull request's commits together, the rest by month), and the pull requests they merged.
 * Every repository string is one neutralised line (packText). Over the budget, the oldest episodes
 * are collapsed to one line, one at a time, then the oldest collapsed lines are dropped for "and N
 * earlier episodes". Every sha the pack shows is citable and no other is (R17).
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
  const basis = mine[0]?.sha ?? input.snapshot.sha;

  // Episodes: a pull request's commits together, the rest by author month.
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
      parts: null,
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
    const paths = c.files.slice(0, MAX_PATHS).map((f) => packText(f.path));
    const more = c.files.length > MAX_PATHS ? `, and ${c.files.length - MAX_PATHS} more` : "";
    return `- commit:${sha12(c.sha)} ${day(c.authorDate)} ${quoted(c.subject)} — features: ${features.length === 0 ? "none" : features.join(", ")} — files: ${paths.join(", ") || "none"}${more}`;
  };
  const rangeOf = (e: Episode) => {
    const first = day(e.commits[0]?.authorDate ?? "");
    const last = day(e.commits.at(-1)?.authorDate ?? "");
    return first === last ? first : `${first} to ${last}`;
  };
  const heading = (e: Episode) =>
    e.parts !== null
      ? `${e.name}, ${rangeOf(e)}: ${e.parts.join("; ")}`
      : `${e.name}${e.merged === null ? "" : `, ${rangeOf(e)}, ${e.merged}`}`;
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
    input.covered == null ? "## Episodes, oldest first" : "## New episodes, oldest first",
  ];
  const mergedLandings = [...input.landings.values()]
    .filter((l) => l.merger === input.group && input.covered?.has(l.sha) !== true)
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

  // Trim: collapse the oldest episodes, then drop the oldest collapsed ones. Each episode is
  // rendered once both ways, and the text's length is kept as a running sum, so the loop is
  // linear; estimateTokens of the joined text is exactly what this sum gives.
  const fullLines = episodes.map(full);
  const collapsedLines = episodes.map(collapsed);
  const size = (lines: readonly string[]) => lines.reduce((n, l) => n + l.length + 1, 0);
  const fullSize = fullLines.map(size);
  const collapsedSize = collapsedLines.map(size);
  const earlierLine = (n: number) => `- and ${n} earlier ${n === 1 ? "episode" : "episodes"}`;
  const fixed = size(header) + size(merged);
  let body = fullSize.reduce((a, b) => a + b, 0);
  /** The episodes the first `n` shown units hold: a group counts each of its members. */
  const members = (n: number) =>
    episodes.slice(0, n).reduce((sum, e) => sum + (e.parts?.length ?? 1), 0);
  const tokensOf = (dropped: number) =>
    Math.ceil(
      Math.max(
        0,
        fixed + body + (dropped === 0 ? 0 : earlierLine(members(dropped)).length + 1) - 1,
      ) / 2.5,
    );
  let collapsedCount = 0;
  let dropped = 0;
  while (tokensOf(0) > budget && collapsedCount < episodes.length) {
    body += (collapsedSize[collapsedCount] ?? 0) - (fullSize[collapsedCount] ?? 0);
    collapsedCount++;
  }
  while (tokensOf(dropped) > budget && dropped < episodes.length) {
    body -= collapsedSize[dropped] ?? 0;
    dropped++;
  }
  const text = [
    ...header,
    ...(dropped === 0 ? [] : [earlierLine(members(dropped))]),
    ...episodes.slice(dropped).flatMap((_, j) => {
      const i = j + dropped;
      return (i < collapsedCount ? collapsedLines[i] : fullLines[i]) ?? [];
    }),
    ...merged,
  ].join("\n");

  // The citable set: exactly the shas the text shows.
  const shas = new Set<string>();
  const dates = new Map<string, string>();
  const cite = (sha: string, date: string) => {
    shas.add(sha);
    dates.set(sha, date);
  };
  episodes.slice(dropped).forEach((e, i) => {
    const commits =
      i + dropped < collapsedCount
        ? [e.commits[0] as AuthoredCommit, e.commits.at(-1) as AuthoredCommit]
        : e.commits;
    for (const c of commits) cite(c.sha, c.authorDate);
    for (const l of e.landings) cite(l.sha, l.date);
  });
  for (const l of mergedLandings) cite(l.sha, l.mergedAt);
  return {
    personId: person.id,
    text,
    tokens: estimateTokens(text),
    shas,
    dates,
    basis,
    episodes: {
      full: episodes.length - Math.max(collapsedCount, dropped),
      collapsed: Math.max(0, collapsedCount - dropped),
      dropped,
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
