import {
  type Citation,
  type Claim,
  cleanPersonName,
  featureLinkTargets,
  type Manifest,
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
const MONTH = MONTHS.join("|");
/** "14 March 2026", "March 14, 2026", "March 2026", "2026-03-14", "2026-03" or a lone "2026". */
const DATE = new RegExp(
  `\\b(?:(\\d{1,2})\\s+(${MONTH})\\s+(\\d{4})|(${MONTH})\\s+(\\d{1,2}),?\\s+(\\d{4})|(${MONTH})\\s+(\\d{4})|(\\d{4})-(\\d{2})(?:-(\\d{2}))?|((?:19|20)\\d{2}))\\b`,
  "gi",
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

/**
 * The dates a claim states (R18), each at the granularity it is written: a day, a month or a year.
 * A month without a year ("Between January and February 2026") is read only where the year
 * follows it; the bare "January" there is not a date (planner ruling R25).
 */
export function statedDates(text: string): StatedDate[] {
  const out: StatedDate[] = [];
  for (const m of text.matchAll(DATE)) {
    const month = (name: string | undefined) => MONTHS.indexOf((name ?? "").toLowerCase()) + 1;
    let year: number;
    let mon = 0;
    let day = 0;
    if (m[1] !== undefined) [day, mon, year] = [Number(m[1]), month(m[2]), Number(m[3])];
    else if (m[4] !== undefined) [mon, day, year] = [month(m[4]), Number(m[5]), Number(m[6])];
    else if (m[7] !== undefined) [mon, year] = [month(m[7]), Number(m[8])];
    else if (m[9] !== undefined) {
      [year, mon] = [Number(m[9]), Number(m[10])];
      day = m[11] === undefined ? 0 : Number(m[11]);
    } else year = Number(m[12]);
    if (mon > 12 || (mon > 0 && (day > lastDay(year, mon) || (m[9] !== undefined && mon === 0)))) {
      out.push({ text: m[0], from: "", to: "" });
      continue;
    }
    const from = `${year}-${pad(mon || 1)}-${pad(day || 1)}`;
    const to = `${year}-${pad(mon || 12)}-${pad(day || (mon === 0 ? 31 : lastDay(year, mon)))}`;
    out.push({ text: m[0], from, to });
  }
  return out;
}

/** "a number followed by commits, lines, files, pull requests, PRs or %" (R18). */
const STATISTIC =
  /\b\d[\d,.]*\s*(?:%|percent\b|commits?\b|lines?\b|files?\b|pull requests?\b|PRs?\b)/i;
/** Text the word checks skip: code spans and link targets (a feature id is not prose). */
const NOT_PROSE = /`[^`]+`|\[\[[^\]|]+\|([^\]]+)\]\]|\[\[[^\]]+\]\]/g;
const prose = (text: string) => text.replace(NOT_PROSE, (_, label?: string) => ` ${label ?? ""} `);
const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (word: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}-])${escaped(word)}(?![\\p{L}\\p{N}-])`, "iu");
const BANNED = PEOPLE_BANNED_WORDS.map((w) => ({ word: w, pattern: wholeWord(w) }));

/** R18's mechanical checks, for a claim whose citations resolved to `cited`. */
function factProblems(
  key: PersonSectionKey,
  text: string,
  cited: readonly Citation[],
  ctx: PersonVerifyContext,
): string[] {
  const problems: string[] = [];
  const words = prose(text);
  const dates = statedDates(words);
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
      if (date.from === "")
        problems.push(`the claim states ${quote(date.text)}, which is not a date`);
      else if (date.to < first || date.from > last)
        problems.push(
          `the claim states ${quote(date.text)}, outside its ${key === "lead" ? "person's" : "cited commits'"} dates ${first} to ${last}`,
        );
    }
  }
  if (key === "chronicle" && dates.length === 0)
    problems.push('a chronicle claim opens with its date, such as "In March 2026,"');
  if (withoutEmails(text) !== text)
    problems.push("the claim holds an email address; never write one");
  if (STATISTIC.test(words))
    problems.push("the claim states a statistic; the infobox has the numbers, so leave them out");
  if (ctx.otherNames.some((name) => name.length >= MIN_NAMED_LENGTH && wholeWord(name).test(words)))
    problems.push("the claim names another person; name no one but the page's subject");
  const banned = BANNED.filter((b) => b.pattern.test(words)).map((b) => quote(b.word));
  if (banned.length > 0)
    problems.push(
      `the claim uses the banned ${banned.length === 1 ? "word" : "words"} ${banned.join(", ")}`,
    );
  if (key === "areas") {
    const [target] = featureLinkTargets(text);
    if (target !== undefined && !ctx.features.has(target.trim()))
      problems.push(`the claim links ${quote(target)}, which is not a feature of this wiki`);
    else if (target !== undefined) {
      const away = cited.filter(
        (c) => c.kind === "commit" && !ctx.featuresOf(c.sha).includes(target.trim()),
      );
      if (away.length > 0)
        problems.push(
          `the claim cites ${away.map((c) => quote(`commit:${c.sha.slice(0, 12)}`)).join(", ")}, which ${away.length === 1 ? "does" : "do"} not touch ${quote(target.trim())}; cite the commits that changed it`,
        );
    }
  }
  return problems;
}

export type VerifiedPersonClaim =
  | { claim: Claim; problems: [] }
  | { claim: null; problems: string[] };

/**
 * Checks one claim of a person narrative (spec v2 #6 §8.4), in order: v1's text checks; each
 * reference a commit that resolves; authorship (R17: only shas the pack shows); R18's mechanical
 * checks; and core's personClaimViolations. A lead's citations are dropped, not refused. Commit
 * subjects are stored without emails. Problems quote model text only through quote() and never
 * name a person.
 */
export function verifyPersonClaim(
  key: PersonSectionKey,
  draft: PersonDraftClaim,
  ctx: PersonVerifyContext,
): VerifiedPersonClaim {
  const problems: string[] = [];
  const text = draft.text.trim();
  if (draft.id === "") problems.push("the claim has no id");
  problems.push(...claimTextProblems(text, ctx.verify));
  const citations: Citation[] = [];
  let unresolved = false;
  for (const ref of key === "lead" ? [] : draft.cite) {
    if (!/^\s*commit:/i.test(ref)) {
      problems.push(`citation ${quote(ref)} is not a commit; person claims cite commits only`);
      unresolved = true;
      continue;
    }
    const one = resolveReference(ref, ctx.verify);
    if ("problem" in one) {
      problems.push(one.problem);
      unresolved = true;
      continue;
    }
    const c = one.citation;
    if (c.kind !== "commit" || !ctx.pack.shas.has(c.sha)) {
      problems.push(
        `citation ${quote(ref)} is not one of this person's commits the pack shows; cite only those`,
      );
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
  const namesOf = (g: IdentityGroup) =>
    [g.name, ...g.otherNames, ...g.identities.map((p) => cleanPersonName(p.name))]
      .map(normalizeName)
      .filter((n) => n !== "");
  const own = new Set(self === undefined ? [] : namesOf(self));
  const otherNames = [...new Set(groups.flatMap((g, i) => (i === group ? [] : namesOf(g))))].filter(
    (n) => !own.has(n),
  );
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
  };
}
