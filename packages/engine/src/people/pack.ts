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

/** Repository text as one line of the pack: no email, no break, nothing that forges structure. */
export const packText = (text: string, max = MAX_TEXT): string => {
  const line = clean(
    withoutEmails(text)
      .replace(/[\s\u0085]+/g, " ")
      .trim(),
  );
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
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
  /** "PR #n …" or "Commits outside pull requests, yyyy-mm". */
  heading: string;
  /** The heading's own citable sha (an authored or merged PR's merge commit), or null. */
  landing: { sha: string; date: string } | null;
  /** Oldest first. */
  commits: AuthoredCommit[];
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
    let heading: string;
    let own: Episode["landing"] = null;
    if (landing !== undefined) {
      key = `pr-${landing.number}`;
      const citable =
        landing.sha !== commit.sha &&
        (input.prAuthors.get(landing.number) === input.group || landing.merger === input.group);
      if (citable) own = { sha: landing.sha, date: landing.mergedAt };
      const title = landing.title === null ? "" : ` ${quoted(landing.title)}`;
      heading = `PR #${landing.number}${title}`;
      const merged = `merged ${day(landing.mergedAt)}${own === null ? "" : ` (commit:${sha12(own.sha)})`}`;
      heading = `${heading}, {range}, ${merged}`;
    } else {
      key = `month-${commit.authorDate.slice(0, 7)}`;
      heading = `Commits outside pull requests, ${commit.authorDate.slice(0, 7)}`;
    }
    const episode = byKey.get(key) ?? { heading, landing: own, commits: [] };
    episode.commits.push(commit);
    byKey.set(key, episode);
  }
  const episodes = [...byKey.values()].sort(
    (a, b) =>
      Date.parse(a.commits[0]?.authorDate ?? "") - Date.parse(b.commits[0]?.authorDate ?? "") ||
      (a.heading < b.heading ? -1 : 1),
  );

  const commitLine = (c: AuthoredCommit) => {
    const features = input.commitFeatures.get(c.sha) ?? [];
    const paths = c.files.map((f) => packText(f.path));
    const more = paths.length > MAX_PATHS ? `, and ${paths.length - MAX_PATHS} more` : "";
    return `- commit:${sha12(c.sha)} ${day(c.authorDate)} ${quoted(c.subject)} — features: ${features.length === 0 ? "none" : features.join(", ")} — files: ${paths.slice(0, MAX_PATHS).join(", ") || "none"}${more}`;
  };
  const rangeOf = (e: Episode) => {
    const first = day(e.commits[0]?.authorDate ?? "");
    const last = day(e.commits.at(-1)?.authorDate ?? "");
    return first === last ? first : `${first} to ${last}`;
  };
  const full = (e: Episode) => [
    `### ${e.heading.replace("{range}", rangeOf(e))}`,
    ...e.commits.map(commitLine),
  ];
  const collapsed = (e: Episode) => {
    const first = e.commits[0] as AuthoredCommit;
    const last = e.commits.at(-1) as AuthoredCommit;
    const name = e.heading.replace(/, \{range\}.*$/, "");
    const ends =
      first === last
        ? `commit:${sha12(first.sha)}`
        : `commit:${sha12(first.sha)} … commit:${sha12(last.sha)}`;
    const merged = e.landing === null ? "" : ` (merged: commit:${sha12(e.landing.sha)})`;
    return [
      `- ${name}, ${rangeOf(e).replace(" to ", "–")}, ${e.commits.length} ${e.commits.length === 1 ? "commit" : "commits"}: ${ends}${merged}`,
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
    .sort((a, b) => a.number - b.number)
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

  // Trim: collapse the oldest episodes, then drop the oldest collapsed ones.
  let collapsedCount = 0;
  let dropped = 0;
  const render = () => {
    const kept = episodes.slice(dropped);
    const body = kept.flatMap((e, i) => (i + dropped < collapsedCount ? collapsed(e) : full(e)));
    const earlier =
      dropped === 0 ? [] : [`- and ${dropped} earlier ${dropped === 1 ? "episode" : "episodes"}`];
    return [...header, ...earlier, ...body, ...merged].join("\n");
  };
  let text = render();
  while (estimateTokens(text) > budget && collapsedCount < episodes.length) {
    collapsedCount++;
    text = render();
  }
  while (estimateTokens(text) > budget && dropped < episodes.length) {
    dropped++;
    text = render();
  }

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
    if (e.landing !== null) cite(e.landing.sha, e.landing.date);
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
 * snapshot has no such human. `covered` and `budgetTokens` as buildPersonPack takes them.
 */
export function packFor(
  refreshed: Refreshed,
  personId: string,
  manifest: Manifest,
  options: { covered?: ReadonlySet<string> | null; budgetTokens?: number } = {},
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
