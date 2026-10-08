import { z } from "zod";
import { INFLIGHT_FILLERS, INVISIBLE_CHARACTERS } from "./alias.ts";
import { Claim } from "./claim.ts";
import { FeatureId } from "./feature.ts";
import { hasVisibleText, holdsEmail, withoutEmails } from "./plain-text.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
import { TokenUsage } from "./revision.ts";
import { addSectionStructureIssues, addUpdateParentIssue } from "./revision-rules.ts";

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

/** The longest display name, in code points (spec v2 #6 R14: an Architecture title's rule). */
export const PERSON_NAME_MAX_LENGTH = 120;

/** Every whitespace character, as normalizedText reads it: `\s` (U+2028 and U+2029 in it) and NEL. */
const WHITESPACE = /[\s\u0085]+/gu;

/** `text` well formed, every whitespace character a space, and every invisible one `to`. */
const flattened = (text: string, to: "" | " "): string =>
  text
    .toWellFormed()
    .replace(WHITESPACE, " ")
    .replace(INVISIBLE_CHARACTERS, to)
    .replace(INFLIGHT_FILLERS, to)
    .replace(/ +/g, " ")
    .trim();

/**
 * An author name as People shows it (spec v2 #6 §6.1, R14, the fix-forward ruling): every
 * whitespace character (NEL and U+2028/9 included) a space, every other control, bidi, invisible
 * or filler character dropped, a lone surrogate made U+FFFD, spaces collapsed, trimmed and cut to
 * PERSON_NAME_MAX_LENGTH code points. A name that holds an email address, raw, normalized or once
 * cleaned (with or without its spaces), is unusable (R10), as is one with no visible character:
 * it cleans to "", and the caller falls back to the next name.
 */
export function cleanPersonName(raw: string): string {
  if (holdsEmail(raw)) return "";
  const flat = flattened(raw, "");
  if (holdsEmail(flat) || holdsEmail(flat.replace(/ /g, ""))) return "";
  const cut = [...flat].slice(0, PERSON_NAME_MAX_LENGTH).join("").trimEnd();
  return hasVisibleText(cut) ? cut : "";
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

/**
 * A pull-request title (the fix-forward ruling): addresses removed first, then one line, every
 * control or invisible character a space, spaces collapsed, checked for an address again, cut to
 * PR_TITLE_MAX_LENGTH code points with "…"; null when nothing visible is left.
 */
export function cleanPullTitle(raw: string): string | null {
  const flat = withoutEmails(flattened(withoutEmails(raw), " "));
  if (!hasVisibleText(flat)) return null;
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
    // JavaScript lists integer-like keys first, in numeric order, whatever order they were
    // written in (the Task 2 review's M1): only the other keys' order can be checked.
    const keys = Object.keys(snapshot.featureLines).filter(
      (key) => !/^(?:0|[1-9]\d{0,8})$/.test(key),
    );
    if (!keys.every((key, i) => i === 0 || (keys[i - 1] ?? "") < key))
      issue("feature lines are keyed in sorted order", ["featureLines"]);
    const lines = snapshot.people.reduce((n, p) => n + p.currentLines, 0);
    if (lines + snapshot.unattributedLines !== snapshot.totalLines)
      issue("people's lines and unattributed lines add up to the total", ["totalLines"]);
  });
export type PeopleSnapshot = z.infer<typeof PeopleSnapshot>;

/** The sections of a person page's narrative, in page order (spec v2 #6 §8.1). */
export const PersonSectionKey = z.enum(["lead", "chronicle", "areas"]);
export type PersonSectionKey = z.infer<typeof PersonSectionKey>;

/** "build" writes the narrative whole; "update" appends to the stored chronicle (R25). */
export const PersonRevisionReason = z.enum(["build", "update"]);
export type PersonRevisionReason = z.infer<typeof PersonRevisionReason>;

/** The reader's tokens: a code span is held aside before a [[link]] token is read. */
const READER_TOKEN = /`[^`]+`|\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/**
 * The targets of a claim's feature link tokens, in order: `[[id]]` and `[[id|words]]`, not wp:,
 * and only targets FeatureId accepts (spec v2 #6 §5 rule 1: `[[featureId]]`), so `[[ ]]` or
 * `[[Not A Feature]]` is no feature link.
 */
export function featureLinkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(READER_TOKEN)) {
    const target = match[1]?.trim();
    if (target !== undefined && FeatureId.safeParse(target).success) targets.push(target);
  }
  return targets;
}

/**
 * Every rule a person claim breaks in a section (spec v2 #6 §5 rule 1): a lead claim cites
 * nothing and supports a body claim; a chronicle claim is a history claim citing a commit; an
 * areas claim is a fact citing a commit and linking exactly one feature. No person claim cites
 * code or is a hook, so people never reach "Did you know…".
 */
export function personClaimViolations(key: PersonSectionKey, claim: Claim): string[] {
  const violations: string[] = [];
  const kind = key === "chronicle" ? "history" : "fact";
  if (claim.kind !== kind) violations.push(`${key} claims must be ${kind} claims`);
  if (claim.hook) violations.push("person claims are never Main Page hooks");
  if (claim.citations.some((c) => c.kind !== "commit"))
    violations.push("person claims cite commits only, never code");
  if (key === "lead") {
    if (claim.citations.length > 0)
      violations.push("lead claims carry no citations; list the body claims they support");
    if (claim.supports.length === 0)
      violations.push("lead claims must support at least one body claim");
    return violations;
  }
  if (claim.supports.length > 0) violations.push("only lead claims may support other claims");
  if (claim.citations.length === 0) violations.push(`${key} claims need a commit citation`);
  if (key === "areas" && featureLinkTargets(claim.text).length !== 1)
    violations.push("an areas claim links exactly one feature");
  return violations;
}

export const PersonSection = z
  .object({ key: PersonSectionKey, claims: z.array(Claim).min(1) })
  .superRefine((section, ctx) => {
    section.claims.forEach((claim, index) => {
      for (const message of personClaimViolations(section.key, claim))
        ctx.addIssue({ code: "custom", message, path: ["claims", index] });
    });
  });
export type PersonSection = z.infer<typeof PersonSection>;

const REVISION_ID = /^person-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{12}-[1-9][0-9]*$/;
const SECTION_ORDER = PersonSectionKey.options;

/**
 * One revision of a person's narrative (spec v2 #6 §5, R27): a chain like the Architecture
 * article's, stored whole; the export carries only the current one. `basis` is the head commit
 * the round that wrote it ran at, so a commit of the person it does not reach makes the narrative
 * due (R25, the Task 21 ruling). `groupFingerprint` is the SHA-256 of the person's sorted salted
 * identity keys when it was written: a different one today means the person was regrouped, so
 * the narrative is rewritten whole. It stays in the store (null in the export) and is null on a
 * revision stored before it existed.
 */
export const PersonRevision = z
  .object({
    /** `person-<personId>-<sha12>-<n>`: n is the revision's 1-based place in the person's chain. */
    id: z.string().regex(REVISION_ID, "expected an id like person-<id>-<sha12>-<n>"),
    personId: PersonId,
    sha: GitSha,
    commitDate: IsoDateTime,
    generatedAt: IsoDateTime,
    parentId: z.string().min(1).nullable(),
    reason: PersonRevisionReason,
    model: z.string().min(1),
    tokens: TokenUsage,
    basis: GitSha,
    groupFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .default(null),
    sections: z.array(PersonSection).min(1),
  })
  .superRefine((revision, ctx) => {
    const prefix = `person-${revision.personId}-${revision.sha.slice(0, 12)}-`;
    if (
      !revision.id.startsWith(prefix) ||
      !/^[1-9][0-9]*$/.test(revision.id.slice(prefix.length))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "the id must be person-<person id>-<first 12 characters of the sha>-<n>",
        path: ["id"],
      });
    }
    addSectionStructureIssues(revision.sections, ctx);
    const order = revision.sections.map((s) => SECTION_ORDER.indexOf(s.key));
    if (!order.every((n, i) => i === 0 || (order[i - 1] ?? 0) < n)) {
      ctx.addIssue({
        code: "custom",
        message: "sections are lead, chronicle, areas, in that order",
        path: ["sections"],
      });
    }
    addUpdateParentIssue(revision, ctx);
  });
export type PersonRevision = z.infer<typeof PersonRevision>;

/**
 * People in the export (spec v2 #6 §5, R28): the snapshot and each human's current narrative
 * revision. The registry and older revisions stay in the store (R27, rule 5).
 */
export const PeopleExport = z
  .object({ snapshot: PeopleSnapshot, pages: z.array(PersonRevision) })
  .superRefine((people, ctx) => {
    const humans = new Set(
      people.snapshot.people.filter((p) => p.kind === "human").map((p) => p.id),
    );
    const seen = new Set<string>();
    people.pages.forEach((page, index) => {
      if (!humans.has(page.personId))
        ctx.addIssue({
          code: "custom",
          message: `${page.personId} is not a person of the snapshot with a page`,
          path: ["pages", index, "personId"],
        });
      if (seen.has(page.personId))
        ctx.addIssue({
          code: "custom",
          message: `two pages for ${page.personId}`,
          path: ["pages", index, "personId"],
        });
      seen.add(page.personId);
    });
  });
export type PeopleExport = z.infer<typeof PeopleExport>;

/**
 * What makes People disagree with the export it rides in (spec v2 #6 §5 rule 2): a feature id
 * the manifest lacks, in a person's features or the snapshot's feature lines. Paths are relative
 * to `people`. buildExport leaves People out (null) rather than fail on one.
 */
export function peopleProblems(
  people: PeopleExport,
  wiki: { manifest: { features: readonly { id: string }[] } },
): { message: string; path: (string | number)[] }[] {
  const known = new Set(wiki.manifest.features.map((f) => f.id));
  const problems: { message: string; path: (string | number)[] }[] = [];
  people.snapshot.people.forEach((person, p) => {
    person.features.forEach((feature, f) => {
      if (!known.has(feature.featureId))
        problems.push({
          message: `${feature.featureId} is not in the manifest`,
          path: ["snapshot", "people", p, "features", f, "featureId"],
        });
    });
  });
  for (const id of Object.keys(people.snapshot.featureLines)) {
    if (!known.has(id))
      problems.push({
        message: `${id} is not in the manifest`,
        path: ["snapshot", "featureLines", id],
      });
  }
  return problems;
}

/** One row of a feature's Main contributors (R23). `share` is lines / the feature's lines. */
export interface Contributor {
  id: string;
  name: string;
  lines: number;
  share: number;
}

/**
 * A feature's main contributors (spec v2 #6 R23): the `limit` humans with the most current lines
 * in its files, most first (ties by id), with each one's share, and how many more have lines
 * there. Bots and excluded people have no page, so they are not listed. Empty when the feature
 * has no blamed lines, or the export has no People.
 */
export function contributorsOf(
  people: PeopleExport | null,
  featureId: string,
  limit = 5,
): { contributors: Contributor[]; more: number } {
  const total = people === null ? 0 : (people.snapshot.featureLines[featureId] ?? 0);
  if (people === null || total === 0 || !Object.hasOwn(people.snapshot.featureLines, featureId))
    return { contributors: [], more: 0 };
  const all = people.snapshot.people.flatMap((person) => {
    const lines = person.features.find((f) => f.featureId === featureId)?.currentLines ?? 0;
    return person.kind === "human" && lines > 0
      ? [{ id: person.id, name: person.name, lines, share: lines / total }]
      : [];
  });
  all.sort((a, b) => b.lines - a.lines || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { contributors: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

/**
 * One row of the People registry (spec v2 #6 §5 rule 5): a person id ever assigned, with the
 * salted identity keys it stands for. Private: it never leaves the store, since even salted keys
 * of an excluded person's emails are theirs. A redirect row names the id it now points to and
 * keeps no keys; an excluded row keeps its keys so the person stays excluded.
 */
export const RegistryRow = z
  .object({
    id: PersonId,
    /** Creation order: R13's "oldest row" breaks a tie, and a new id never reuses a row's. */
    order: count,
    name: PersonName,
    kind: PersonKind,
    status: z.enum(["active", "redirect", "excluded"]),
    to: PersonId.nullable(),
    /** Salted SHA-256 identity keys, sorted, without repeats. */
    keys: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .superRefine((row, ctx) => {
    if ((row.status === "redirect") !== (row.to !== null))
      ctx.addIssue({ code: "custom", message: "only a redirect names a target", path: ["to"] });
    if (row.to === row.id)
      ctx.addIssue({ code: "custom", message: "a row cannot redirect to itself", path: ["to"] });
    if (!row.keys.every((k, i) => i === 0 || (row.keys[i - 1] ?? "") < k))
      ctx.addIssue({ code: "custom", message: "keys are sorted, without repeats", path: ["keys"] });
  });
export type RegistryRow = z.infer<typeof RegistryRow>;
