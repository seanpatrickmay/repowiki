import { z } from "zod";
import { INVISIBLE_CHARACTERS } from "./alias.ts";
import { FeatureId } from "./feature.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";

/** Person ids become URL path segments (`/people/<id>/`), so they are capped like feature ids. */
export const PERSON_ID_MAX_LENGTH = 64;

/**
 * A permanent lowercase kebab-case slug (spec v2 #6 R13), in a namespace of its own: a person id
 * may equal a feature id, since the two live under /people/ and /wiki/.
 */
export const PersonId = z
  .string()
  .max(PERSON_ID_MAX_LENGTH, `person ids are at most ${PERSON_ID_MAX_LENGTH} characters`)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "person ids are lowercase kebab-case slugs");
export type PersonId = z.infer<typeof PersonId>;

/** What an email address looks like in free text: something@something.tld, no spaces. */
const EMAIL_TOKEN =
  /[^\s<>()[\]{}@,;:"'`|\\]+@[^\s<>()[\]{}@,;:"'`|\\]+\.[^\s<>()[\]{}@,;:"'`|\\]+/gu;
const EMAIL_TEST = new RegExp(EMAIL_TOKEN.source, "u");

/**
 * Text with every email-shaped token replaced by "[email]" (planner ruling R5): People never
 * shows an address, even one a commit subject or a pull-request title quotes.
 */
export function withoutEmails(text: string): string {
  return text.replace(EMAIL_TOKEN, "[email]");
}

/** The longest display name, in code points (spec v2 #6 R14: an Architecture title's rule). */
export const PERSON_NAME_MAX_LENGTH = 120;

/**
 * An author name as People shows it (spec v2 #6 §6.1, R14): every control, bidi and invisible
 * character dropped, whitespace collapsed, trimmed and cut to PERSON_NAME_MAX_LENGTH code points.
 * A name that holds an email address is unusable (R10): it cleans to "", as does one with nothing
 * left, and the caller falls back to the next name.
 */
export function cleanPersonName(raw: string): string {
  const flat = raw.replace(INVISIBLE_CHARACTERS, "").replace(/\s+/g, " ").trim();
  if (EMAIL_TEST.test(flat)) return "";
  return [...flat].slice(0, PERSON_NAME_MAX_LENGTH).join("").trimEnd();
}

/** A cleaned, non-empty display name: cleanPersonName leaves it as it is. */
export const PersonName = z
  .string()
  .min(1)
  .refine((name) => cleanPersonName(name) === name, "expected a cleaned person name");
export type PersonName = z.infer<typeof PersonName>;

/** A calendar date as an author wrote it, `YYYY-MM-DD`, that exists. */
export const CalendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((day) => {
    const [year = 0, month = 0, date = 0] = day.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, date));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === date
    );
  }, "expected a real calendar date");
export type CalendarDay = z.infer<typeof CalendarDay>;

const count = z.int().nonnegative();

/** One day's activity: non-merge commits on the authors' calendar day, and their lines (R20). */
export const ActivityDay = z.object({
  day: CalendarDay,
  commits: z.int().positive(),
  added: count,
  deleted: count,
});
export type ActivityDay = z.infer<typeof ActivityDay>;

/** Activity is listed one entry per day with activity, oldest first. */
const activity = z
  .array(ActivityDay)
  .refine(
    (days) => days.every((d, i) => i === 0 || (days[i - 1]?.day ?? "") < d.day),
    "activity days are ascending, one entry per day",
  );

/** The longest pull-request title People keeps, in code points. */
export const PR_TITLE_MAX_LENGTH = 200;

/** A pull-request title: one line with no control or invisible character, and no address. */
export function cleanPullTitle(raw: string): string | null {
  const flat = withoutEmails(raw.replace(INVISIBLE_CHARACTERS, " ").replace(/\s+/g, " ").trim());
  if (flat === "") return null;
  const chars = [...flat];
  return chars.length <= PR_TITLE_MAX_LENGTH
    ? flat
    : `${chars
        .slice(0, PR_TITLE_MAX_LENGTH - 1)
        .join("")
        .trimEnd()}…`;
}

/** A pull request a person authored (spec v2 #6 R6), as the merge commit names it. */
export const PullRequestRef = z.object({
  number: z.int().positive(),
  title: z
    .string()
    .min(1)
    .refine((title) => cleanPullTitle(title) === title, "expected a cleaned pull-request title")
    .nullable(),
  mergedAt: IsoDateTime,
});
export type PullRequestRef = z.infer<typeof PullRequestRef>;

export const PersonKind = z.enum(["human", "bot"]);
export type PersonKind = z.infer<typeof PersonKind>;

/** The most other names a person's facts list. */
export const MAX_OTHER_NAMES = 10;

const ascendingNumbers = (numbers: readonly number[]) =>
  numbers.every((n, i) => i === 0 || (numbers[i - 1] ?? 0) < n);

/** One feature a person's work touches (spec v2 #6 §7): their commits in it and their lines now. */
export const PersonFeature = z
  .object({ featureId: FeatureId, commits: count, currentLines: count })
  .refine((f) => f.commits + f.currentLines > 0, "a listed feature has commits or lines");
export type PersonFeature = z.infer<typeof PersonFeature>;

/**
 * Everything People computes about one person from git, with no model call (spec v2 #6 §5).
 * Names are the person's, never an email or a login People derived.
 */
export const PersonFacts = z
  .object({
    id: PersonId,
    name: PersonName,
    /** Other cleaned names the person committed under, sorted, at most MAX_OTHER_NAMES. */
    otherNames: z.array(PersonName).max(MAX_OTHER_NAMES),
    kind: PersonKind,
    /** Author dates of the person's first and last commit, merges included. */
    firstCommit: IsoDateTime,
    lastCommit: IsoDateTime,
    /** Non-merge commits, and their lines added and deleted (R20's exclusions applied). */
    commits: count,
    added: count,
    deleted: count,
    /** Lines at the snapshot's sha that blame gives the person (R1). */
    currentLines: count,
    /** Pull requests they authored and merged (R6), ascending by number. */
    prsAuthored: z.array(PullRequestRef),
    prsMerged: z.array(z.int().positive()),
    /** By currentLines descending, then commits descending, then id. */
    features: z.array(PersonFeature),
    activity,
  })
  .superRefine((person, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    const others = person.otherNames;
    if (!others.every((n, i) => i === 0 || (others[i - 1] ?? "") < n))
      issue("other names are sorted, without repeats", ["otherNames"]);
    if (others.includes(person.name))
      issue("the name is not one of the other names", ["otherNames"]);
    if (Date.parse(person.firstCommit) > Date.parse(person.lastCommit))
      issue("the first commit is not after the last", ["firstCommit"]);
    if (!ascendingNumbers(person.prsAuthored.map((pr) => pr.number)))
      issue("pull requests are ascending by number", ["prsAuthored"]);
    if (!ascendingNumbers(person.prsMerged)) issue("merged pull requests ascend", ["prsMerged"]);
    const ids = person.features.map((f) => f.featureId);
    if (new Set(ids).size !== ids.length) issue("a feature is listed twice", ["features"]);
    const ordered = person.features.every((f, i) => {
      const prev = person.features[i - 1];
      if (prev === undefined) return true;
      if (prev.currentLines !== f.currentLines) return prev.currentLines > f.currentLines;
      if (prev.commits !== f.commits) return prev.commits > f.commits;
      return prev.featureId < f.featureId;
    });
    if (!ordered) issue("features are by current lines, then commits, then id", ["features"]);
  });
export type PersonFacts = z.infer<typeof PersonFacts>;

/** An id merged into another person (R13): its page redirects to `to`. */
export const PersonRedirect = z.object({ from: PersonId, to: PersonId });
export type PersonRedirect = z.infer<typeof PersonRedirect>;

/**
 * Every computed People fact at one sha (spec v2 #6 §5): the same repository, sha, people file and
 * stored registry give byte-identical JSON. Excluded people are not in it (R12): their activity is
 * the anonymous `others`, their lines `unattributedLines`.
 */
export const PeopleSnapshot = z
  .object({
    sha: GitSha,
    commitDate: IsoDateTime,
    /** Every non-merge commit reachable from sha, excluded people's included. */
    commits: count,
    /** Sorted by id; humans and bots; no excluded person. */
    people: z.array(PersonFacts),
    /** Merged-away ids, sorted by `from`; no chains and no cycles. */
    redirects: z.array(PersonRedirect),
    /** Excluded people's activity, anonymous; empty below othersMinPeople (planner ruling R15). */
    others: activity,
    /** Current lines per feature at sha, the share denominator; keys sorted. */
    featureLines: z.record(FeatureId, count),
    totalLines: count,
    /** Lines whose author is excluded, or whose blame timed out. */
    unattributedLines: count,
  })
  .superRefine((snapshot, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    const ids = snapshot.people.map((p) => p.id);
    if (!ids.every((id, i) => i === 0 || (ids[i - 1] ?? "") < id))
      issue("people are sorted by id, without repeats", ["people"]);
    const people = new Map(snapshot.people.map((p) => [p.id, p]));
    const froms = snapshot.redirects.map((r) => r.from);
    if (!froms.every((from, i) => i === 0 || (froms[i - 1] ?? "") < from))
      issue("redirects are sorted by source, without repeats", ["redirects"]);
    snapshot.redirects.forEach((redirect, r) => {
      if (people.has(redirect.from))
        issue(`${redirect.from} redirects but is a person`, ["redirects", r, "from"]);
      if (people.get(redirect.to)?.kind !== "human")
        issue(`${redirect.to} is not a person with a page`, ["redirects", r, "to"]);
    });
    const keys = Object.keys(snapshot.featureLines);
    if (!keys.every((key, i) => i === 0 || (keys[i - 1] ?? "") < key))
      issue("feature lines are keyed in sorted order", ["featureLines"]);
    const lines = snapshot.people.reduce((n, p) => n + p.currentLines, 0);
    if (lines + snapshot.unattributedLines !== snapshot.totalLines)
      issue("people's lines and unattributed lines add up to the total", ["totalLines"]);
  });
export type PeopleSnapshot = z.infer<typeof PeopleSnapshot>;
