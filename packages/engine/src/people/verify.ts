import {
  type Citation,
  type Claim,
  cleanPersonName,
  featureLinkTargets,
  holdsEmail,
  type Manifest,
  normalizedText,
  normalizeName,
  type PersonSectionKey,
  personClaimViolations,
  withoutEmails,
} from "@repowiki/core";
import type { AuthoredCommit } from "../index/index.ts";
import { claimTextProblems, quote, resolveReference, type VerifyContext } from "../verify/index.ts";
import type { IdentityGroup } from "./identities.ts";
import type { PersonPack } from "./pack.ts";
import type { PersonDraftClaim } from "./prompt.ts";
import type { Refreshed } from "./refresh.ts";
import { type Landing, pullRequestLandings, topologicalNewestFirst } from "./snapshot.ts";

/**
 * Words no person claim may use (spec v2 #6 §8.1, R18): the people style guide's evaluative and
 * martial words, and the feature pages' banned words, which People also enforces.
 */
export const PEOPLE_BANNED_WORDS: readonly string[] = [
  "prolific",
  "tireless",
  "heroic",
  "hero",
  "brilliant",
  "genius",
  "legendary",
  "valiant",
  "battle",
  "war",
  "fought",
  "conquered",
  "crusade",
  "single-handedly",
  "lazy",
  "sloppy",
  "best",
  "worst",
  "rockstar",
  "ninja",
  "simply",
  "just",
  "robust",
  "powerful",
  "clearly",
  "obviously",
  "seamless",
  "seamlessly",
  "elegant",
  "easy",
  "easily",
  "leverage",
  "cutting-edge",
  "best-in-class",
];

/** The shortest name of another person the check looks for (R18): shorter ones are words. */
export const MIN_NAMED_LENGTH = 4;

/** What a person claim is checked against. */
export interface PersonVerifyContext {
  /** The snapshot's sha and every commit reachable from it, for resolving references. */
  verify: VerifyContext;
  pack: PersonPack;
  /** The person's first and last author dates: a lead's date range (R18). */
  firstCommit: string;
  lastCommit: string;
  /**
   * Every other identity's display and other names, excluded people's included, normalized to
   * lower case: none may appear in a claim. Never shown in a problem.
   */
  otherNames: readonly string[];
  /** The features a cited commit touches: a non-merge commit's (R19), a PR merge's commits'. */
  featuresOf(sha: string): readonly string[];
  /** Active feature ids at the head: what an areas claim may link. */
  features: ReadonlySet<string>;
  /** Each active feature's title, by id: how a chronicle claim can name a feature in words. */
  featureTitles: ReadonlyMap<string, string>;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
/** A month's name, written out or cut to three letters (four for "Sept"), with an optional dot. */
const MONTH = `(?:${MONTHS.join("|")}|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec).?`;
/** A day of the month, with an optional ordinal suffix ("15th"). */
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
/**
 * "14 March 2026", "15th Mar 2026", "March 14, 2026", "March 2026", "2026-03-14" (an ISO time
 * after it allowed), "2026-03" or a lone "2026".
 */
const DATE = new RegExp(
  `\\b(?:${DAY}\\s+(${MONTH})\\s+(\\d{4})|(${MONTH})\\s+${DAY},?\\s+(\\d{4})|(${MONTH})\\s+(\\d{4})|(\\d{4})-(\\d{2})(?:-(\\d{2})(?:T[\\d:.]+(?:Z|[+-]\\d{2}:?\\d{2})?)?)?|((?:19|20)\\d{2}))(?![\\p{L}\\p{N}])`,
  "giu",
);
/**
 * A range whose first month has no year of its own: "between January and March 2026", "from
 * January to March 2026". The first month takes the year that closes the range (R17's §19 delta).
 */
const MONTH_RANGE = new RegExp(
  `\\b(?:between|from)\\s+(${MONTH})\\s+(?:and|to|until|through)\\s+(${MONTH})\\s+(\\d{4})(?![\\p{L}\\p{N}])`,
  "giu",
);

/** A date a claim states, as the inclusive range of calendar days it names. */
export interface StatedDate {
  text: string;
  /** "YYYY-MM-DD" bounds; both "" for a day that does not exist, such as 31 February. */
  from: string;
  to: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** A month's number, 1 to 12, from its name or abbreviation; 0 for none. */
const monthOf = (name: string | undefined): number =>
  name === undefined
    ? 0
    : MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().replace(".", "").slice(0, 3))) + 1;

/**
 * The dates a claim states (R18), each at the granularity it is written: a day, a month or a year.
 * A month without a year counts only where a range joins it to the year that closes it
 * ("between January and March 2026" states January 2026 and March 2026); any other bare month is
 * not a date. A day or month that does not exist (31 February, month 00, day 0) is refused.
 */
export function statedDates(text: string): StatedDate[] {
  const out: StatedDate[] = [];
  const add = (match: string, year: number, mon: number, day: number, bad: boolean) => {
    if (bad || mon > 12 || (mon > 0 && day > lastDay(year, mon))) {
      out.push({ text: match, from: "", to: "" });
      return;
    }
    const from = `${year}-${pad(mon || 1)}-${pad(day || 1)}`;
    const to = `${year}-${pad(mon || 12)}-${pad(day || (mon === 0 ? 31 : lastDay(year, mon)))}`;
    out.push({ text: match, from, to });
  };
  for (const m of text.matchAll(MONTH_RANGE))
    add(m[1] ?? "", Number(m[3]), monthOf(m[1]), 0, false);
  for (const m of text.matchAll(DATE)) {
    if (m[1] !== undefined)
      add(m[0], Number(m[3]), monthOf(m[2]), Number(m[1]), Number(m[1]) === 0);
    else if (m[4] !== undefined)
      add(m[0], Number(m[6]), monthOf(m[4]), Number(m[5]), Number(m[5]) === 0);
    else if (m[7] !== undefined) add(m[0], Number(m[8]), monthOf(m[7]), 0, false);
    else if (m[9] !== undefined) {
      const mon = Number(m[10]);
      const day = m[11] === undefined ? 0 : Number(m[11]);
      add(m[0], Number(m[9]), mon, day, mon === 0 || (m[11] !== undefined && day === 0));
    } else add(m[0], Number(m[12]), 0, 0, false);
  }
  return out;
}

/** Number words a count may be written in (R18): one to twenty, the tens, and the large ones. */
const NUMBER_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|dozen|dozens|hundred|hundreds|thousand|thousands|half";
/** A digit run that ends on a digit, so a year's comma never joins what follows it. */
const DIGITS = "\\d(?:[\\d,.]*\\d)?";
/** What a statistic counts (R18). */
const COUNTED = "(?:commits?|lines?|files?|pull[\\s-]requests?|PRs?)";
/** Words that may not stand between a number and what it counts: "In 2026 the files moved". */
const NOT_ADJECTIVE =
  "the|a|an|and|or|but|to|in|on|at|by|for|from|with|her|his|their|its|this|that|these|those|which|who|were|was|is|are|of";
/**
 * "a number followed by commits, lines, files, pull requests, PRs or %" (R18), the number in
 * digits or words, as "12 commits", "three commits", "a dozen commits", "3 new files", "12 of
 * the commits", "forty percent" or "40%". A four-digit year is a count only right before the
 * noun ("2026 commits"), never across another word.
 */
const STATISTIC = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:(?:${DIGITS}|${NUMBER_WORDS})\\s*(?:%|percent\\b)|\\p{L}+\\s+percent\\b|${DIGITS}\\s*${COUNTED}\\b|(?!(?:19|20)\\d\\d(?![\\d,.]))(?:${DIGITS}|${NUMBER_WORDS})\\s+(?:of\\s+the\\s+|(?!(?:${NOT_ADJECTIVE})\\s)[\\p{L}-]+\\s+)${COUNTED}\\b|(?:${NUMBER_WORDS})\\s+${COUNTED}\\b)`,
  "iu",
);
/** Text the banned-word check skips: code spans and link targets (a feature id is not prose). */
const NOT_PROSE = /`[^`]+`|\[\[[^\]|]+\|([^\]]+)\]\]|\[\[[^\]]+\]\]/g;
const prose = (text: string) => text.replace(NOT_PROSE, (_, label?: string) => ` ${label ?? ""} `);
const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (word: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}-])${escaped(word)}(?![\\p{L}\\p{N}-])`, "iu");
/**
 * The text the name check reads (I2): emphasis markers dropped, then normalizeName's form (NFKC,
 * every whitespace one space, invisible characters dropped, lower case), as the names are.
 */
const nameForm = (text: string) => normalizeName(text.replace(/[*_]+/g, ""));
/** Each context's other names as whole-word patterns, compiled once per context. */
const namePatterns = new WeakMap<readonly string[], RegExp[]>();
const patternsOf = (names: readonly string[]): RegExp[] => {
  let patterns = namePatterns.get(names);
  if (patterns === undefined) {
    patterns = names.filter((n) => n.length >= MIN_NAMED_LENGTH).map(wholeWord);
    namePatterns.set(names, patterns);
  }
  return patterns;
};
const BANNED = PEOPLE_BANNED_WORDS.map((w) => ({ word: w, pattern: wholeWord(w) }));

/**
 * The features a claim names (the I2 ruling): those it links, and those whose title it writes as
 * whole words, in the name check's normalised form.
 */
function namedFeatures(text: string, ctx: PersonVerifyContext): string[] {
  const form = nameForm(text);
  const linked = new Set(featureLinkTargets(text).map((t) => t.trim()));
  return [...ctx.featureTitles].flatMap(([id, title]) => {
    const words = normalizeName(title);
    return linked.has(id) || (words !== "" && wholeWord(words).test(form)) ? [id] : [];
  });
}

/** R18's mechanical checks, for a claim whose citations resolved to `cited`. */
function factProblems(
  key: PersonSectionKey,
  text: string,
  cited: readonly Citation[],
  ctx: PersonVerifyContext,
): string[] {
  const problems: string[] = [];
  // Only the banned words skip code spans and link targets (I1): a name, a count or a date
  // there still shows on the page.
  const words = prose(text);
  const dates = statedDates(text);
  const days = cited.flatMap((c) => {
    const date = c.kind === "commit" ? ctx.pack.dates.get(c.sha) : undefined;
    return date === undefined ? [] : [date.slice(0, 10)];
  });
  const range =
    key === "lead"
      ? [ctx.firstCommit.slice(0, 10), ctx.lastCommit.slice(0, 10)]
      : [
          days.reduce((a, b) => (b < a ? b : a), "9999"),
          days.reduce((a, b) => (b > a ? b : a), "0000"),
        ];
  const [first = "", last = ""] = range;
  if (key === "lead" || days.length > 0) {
    for (const date of dates) {
      if (date.from === "") problems.push("the claim states a day or month that does not exist");
      else if (date.to < first || date.from > last)
        problems.push(
          `the claim states a date outside its ${key === "lead" ? "person's" : "cited commits'"} dates ${first} to ${last}`,
        );
    }
  }
  if (key === "chronicle" && dates.length === 0)
    problems.push('a chronicle claim opens with its date, such as "In March 2026,"');
  if (holdsEmail(text)) problems.push("the claim holds an email address; never write one");
  if (STATISTIC.test(normalizedText(text)))
    problems.push("the claim states a statistic; the infobox has the numbers, so leave them out");
  const named = nameForm(text);
  if (patternsOf(ctx.otherNames).some((pattern) => pattern.test(named)))
    problems.push("the claim names another person; name no one but the page's subject");
  const banned = BANNED.filter((b) => b.pattern.test(words)).map((b) => quote(b.word));
  if (banned.length > 0)
    problems.push(
      `the claim uses the banned ${banned.length === 1 ? "word" : "words"} ${banned.join(", ")}`,
    );
  // A merge of a pull request the person did not write credits them with the merge only (I2).
  const mergedOnly = cited.filter((c) => c.kind === "commit" && ctx.pack.mergedOnly.has(c.sha));
  if (key === "areas" && mergedOnly.length > 0)
    problems.push(
      `the claim cites ${mergedOnly.map((c) => (c.kind === "commit" ? `commit:${c.sha.slice(0, 12)}` : "")).join(", ")}, the merge of a pull request the person did not write; areas cite only the person's own commits`,
    );
  if (key === "chronicle" && mergedOnly.length > 0) {
    if (mergedOnly.length === cited.length && !/\bmerg(?:e|ed|es|ing)\b/i.test(words))
      problems.push(
        "the claim cites only merges of pull requests the person did not write; say that they merged them",
      );
    const own = new Set(ctx.pack.features);
    if (namedFeatures(text, ctx).some((id) => !own.has(id)))
      problems.push(
        "the claim cites the merge of a pull request the person did not write and names a feature they have no commits in; describe only the merge",
      );
  }
  if (key === "areas") {
    const [target] = featureLinkTargets(text);
    if (target !== undefined && !ctx.features.has(target.trim()))
      problems.push("the claim links a target that is not a feature of this wiki");
    else if (target !== undefined) {
      const away = cited.filter(
        (c) => c.kind === "commit" && !ctx.featuresOf(c.sha).includes(target.trim()),
      );
      if (away.length > 0)
        problems.push(
          `the claim cites ${away.map((c) => `commit:${c.sha.slice(0, 12)}`).join(", ")}, which ${away.length === 1 ? "does" : "do"} not touch the feature ${target.trim()}; cite the commits that changed it`,
        );
    }
  }
  return problems;
}

/**
 * A v1 text problem without the model's text in it (I4): the one that quotes the citation-shaped
 * tokens it found becomes a fixed phrase; the others name only the rule.
 */
const unquoted = (problem: string): string =>
  problem.startsWith("the claim text holds a citation") ||
  problem.startsWith("the claim text holds citations")
    ? 'the claim text holds a citation; citations go only in "cite", never in the text'
    : problem;

export type VerifiedPersonClaim =
  | { claim: Claim; problems: [] }
  | { claim: null; problems: string[] };

/**
 * Checks one claim of a person narrative (spec v2 #6 §8.4), in order: v1's text checks; each
 * reference a commit that resolves; authorship (R17: only shas the pack shows); R18's mechanical
 * checks; and core's personClaimViolations. A lead's citations are dropped, not refused. Commit
 * subjects are stored without emails. Problems never quote the model's text (fixed phrases naming
 * the rule, a citation's place in the list, and ids), so they never name a person.
 */
export function verifyPersonClaim(
  key: PersonSectionKey,
  draft: PersonDraftClaim,
  ctx: PersonVerifyContext,
): VerifiedPersonClaim {
  const problems: string[] = [];
  const text = draft.text.trim();
  if (draft.id === "") problems.push("the claim has no id");
  problems.push(...claimTextProblems(text, ctx.verify).map(unquoted));
  const citations: Citation[] = [];
  let unresolved = false;
  for (const [i, ref] of (key === "lead" ? [] : draft.cite).entries()) {
    // Problems name a citation by its place in the cite list, never by its text (I4).
    const nth = `citation ${i + 1}`;
    if (!/^\s*commit:/i.test(ref)) {
      problems.push(`${nth} is not a commit; person claims cite commits only`);
      unresolved = true;
      continue;
    }
    const one = resolveReference(ref, ctx.verify);
    if ("problem" in one) {
      problems.push(
        `${nth} names no single commit of this history; give at least 7 hex digits of a sha the pack shows`,
      );
      unresolved = true;
      continue;
    }
    const c = one.citation;
    if (c.kind !== "commit" || !ctx.pack.shas.has(c.sha)) {
      problems.push(`${nth} is not one of this person's commits the pack shows; cite only those`);
      unresolved = true;
      continue;
    }
    if (citations.some((x) => x.kind === "commit" && x.sha === c.sha)) continue;
    citations.push({ ...c, subject: withoutEmails(c.subject) });
  }
  if (text !== "") problems.push(...factProblems(key, text, citations, ctx));
  const claim: Claim = {
    id: draft.id,
    text: text === "" ? "-" : text,
    kind: key === "chronicle" ? "history" : "fact",
    citations,
    supports: key === "lead" ? draft.supports : [],
    staleSince: null,
    hook: false,
  };
  if (key !== "lead" && draft.supports.length > 0)
    problems.push("only lead claims may support other claims");
  if (!unresolved) problems.push(...personClaimViolations(key, claim));
  return problems.length === 0 ? { claim, problems: [] } : { claim: null, problems };
}

/**
 * featuresOf for a person context: a non-merge commit's features (R19), and a pull request
 * landing's the union of its commits' (a merge changes nothing of its own).
 */
export function commitFeatureLookup(
  commits: readonly AuthoredCommit[],
  commitFeatures: ReadonlyMap<string, readonly string[]>,
  landings: ReadonlyMap<number, Landing>,
): (sha: string) => readonly string[] {
  const merged = new Map<string, Set<string>>();
  const landingOf = new Map([...landings.values()].map((l) => [l.number, l.sha]));
  for (const c of commits) {
    const landing = c.pr === null ? undefined : landingOf.get(c.pr);
    if (landing === undefined || landing === c.sha || c.parents.length > 1) continue;
    const set = merged.get(landing) ?? new Set<string>();
    for (const f of commitFeatures.get(c.sha) ?? []) set.add(f);
    merged.set(landing, set);
  }
  return (sha) => commitFeatures.get(sha) ?? [...(merged.get(sha) ?? [])].sort();
}

/**
 * The verify context of the person with identity group `group` (spec v2 #6 §8.4), from a refresh
 * and their pack: every commit for resolving, the pack's citable shas, every other group's names
 * (excluded people's included; a name the person also bears is theirs to use), and the features
 * each commit touches.
 */
export function personVerifyContext(
  refreshed: Pick<Refreshed, "sha" | "commits" | "identities" | "commitFeatures">,
  group: number,
  pack: PersonPack,
  manifest: Manifest,
): PersonVerifyContext {
  const { groups } = refreshed.identities;
  const self = groups[group];
  const normal = (names: readonly string[]) =>
    names.map((n) => normalizeName(cleanPersonName(n))).filter((n) => n !== "");
  // Every name a group was ever written under, those the mailmap replaced included.
  const namesOf = (g: IdentityGroup) =>
    normal([g.name, ...g.otherNames, ...g.replacedNames, ...g.identities.map((p) => p.name)]);
  // The person's own names are only those People shows: a name the mailmap replaced is no
  // narrative's to use, theirs included (the I1 ruling).
  const own = new Set(
    self === undefined
      ? []
      : normal([self.name, ...self.otherNames, ...self.identities.map((p) => p.shownName)]),
  );
  const otherNames = [...new Set(groups.flatMap(namesOf))].filter((n) => !own.has(n));
  const commits = topologicalNewestFirst(refreshed.commits);
  const groupOf = (c: AuthoredCommit) => refreshed.identities.groupOf(c.authorName, c.authorEmail);
  return {
    verify: {
      sha: refreshed.sha,
      sources: new Map(),
      symbolsOf: () => [],
      commits: commits.map((c) => ({
        sha: c.sha,
        parents: c.parents,
        date: c.commitDate,
        subject: c.subject,
        files: c.files.map((f) => f.path),
        pr: c.pr,
      })),
    },
    pack,
    firstCommit: self?.firstCommit ?? "",
    lastCommit: self?.lastCommit ?? "",
    otherNames,
    featuresOf: commitFeatureLookup(
      commits,
      refreshed.commitFeatures,
      pullRequestLandings(commits, groupOf),
    ),
    features: new Set(manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id)),
    featureTitles: new Map(
      manifest.features.filter((f) => f.status.kind === "active").map((f) => [f.id, f.title]),
    ),
  };
}
