import { createHash } from "node:crypto";
import { z } from "zod";
import { INVISIBLE_CHARACTERS } from "./alias.ts";
import { PersonId, PersonName } from "./person.ts";

/** What a match key names: an author name, an author email, or a GitHub login (spec v2 #6 §5). */
export type MatchKind = "name" | "email" | "login";

/** A match key with its value normalised the way identities are compared. */
export interface ParsedMatchKey {
  kind: MatchKind;
  value: string;
}

/**
 * A name as People compares names (spec v2 #6 §5): whitespace made spaces, other invisible
 * characters dropped, NFKC, lower case, whitespace collapsed and trimmed.
 */
export function normalizeName(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(INVISIBLE_CHARACTERS, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** A GitHub login as a key holds it: GitHub's characters, with a bot's `[bot]` suffix allowed. */
const LOGIN = /^[a-z0-9-]{1,39}(?:\[bot\])?$/;

/**
 * `name:<text>` (case-insensitive, whitespace-collapsed), `email:<address>` (case-insensitive) or
 * `login:<github-login>`, normalised; null for anything else.
 */
export function parseMatchKey(key: string): ParsedMatchKey | null {
  const colon = key.indexOf(":");
  const kind = key.slice(0, colon);
  const raw = key.slice(colon + 1);
  if (colon === -1) return null;
  if (kind === "name") {
    const value = normalizeName(raw);
    return value === "" ? null : { kind, value };
  }
  if (kind === "email") {
    const value = raw.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+$/.test(value) ? { kind, value } : null;
  }
  if (kind === "login") {
    const value = raw.trim().toLowerCase();
    return LOGIN.test(value) ? { kind, value } : null;
  }
  return null;
}

/** One people-file key. The message never repeats the key, which may be an email address. */
export const MatchKey = z
  .string()
  .refine(
    (key) => parseMatchKey(key) !== null,
    "expected name:<text>, email:<address> or login:<github-login>",
  );
export type MatchKey = z.infer<typeof MatchKey>;

/** One explicit group of the people file: these identities are one person (R7). */
export const PeopleEntry = z.strictObject({
  /** The display name, first in R14's order. */
  name: PersonName.optional(),
  /** The person's id; a change leaves a redirect (R13). */
  id: PersonId.optional(),
  match: z.array(MatchKey).min(1),
  /**
   * Whether People writes this person a narrative (the v2 consent ruling): only the owner's is on
   * by default; `true` turns one on, `false` turns the owner's off.
   */
  narrative: z.boolean().optional(),
});
export type PeopleEntry = z.infer<typeof PeopleEntry>;

export const DEFAULT_MIN_COMMITS = 3;
export const DEFAULT_MAX_NARRATIVES = 25;
export const DEFAULT_OTHERS_MIN_PEOPLE = 1;

const keys = z.array(MatchKey).default([]);

/** Where each key of the file sits, as an error names it: `people[1].match[0]`, `exclude[2]`. */
function placesOf(config: {
  people: readonly { match: readonly string[] }[];
  exclude: readonly string[];
  bots: readonly string[];
  humans: readonly string[];
}): Map<string, { group: string; place: string }[]> {
  const places = new Map<string, { group: string; place: string }[]>();
  const add = (key: string, group: string, place: string) => {
    const parsed = parseMatchKey(key);
    if (parsed === null) return;
    const normal = `${parsed.kind}:${parsed.value}`;
    places.set(normal, [...(places.get(normal) ?? []), { group, place }]);
  };
  config.people.forEach((entry, p) => {
    entry.match.forEach((key, m) => {
      add(key, `people[${p}]`, `people[${p}].match[${m}]`);
    });
  });
  for (const list of ["exclude", "bots", "humans"] as const)
    config[list].forEach((key, i) => {
      add(key, list, `${list}[${i}]`);
    });
  return places;
}

/**
 * The people file (spec v2 #6 R9, §5): explicit groups, exclusions, bot and human overrides, the
 * owner's own keys (planner ruling R3; the documented repository's configured user.email when
 * absent) and the narrative limits. Kept outside the documented repository, never committed.
 */
export const PeopleConfig = z
  .strictObject({
    people: z.array(PeopleEntry).default([]),
    exclude: keys,
    bots: keys,
    humans: keys,
    /** The owner's identities: their narrative is on unless their entry says `narrative: false`. */
    owner: z.array(MatchKey).optional(),
    minCommits: z.int().min(1).max(1_000_000).default(DEFAULT_MIN_COMMITS),
    maxNarratives: z.int().min(0).max(1000).default(DEFAULT_MAX_NARRATIVES),
    ignoreRevs: z.boolean().default(true),
    othersMinPeople: z.int().min(1).max(1000).default(DEFAULT_OTHERS_MIN_PEOPLE),
  })
  .superRefine((config, ctx) => {
    for (const [key, at] of placesOf(config)) {
      const groups = [...new Set(at.map((a) => a.group))];
      const grouped = groups.filter((g) => g.startsWith("people["));
      const clash =
        grouped.length > 1 ||
        (grouped.length > 0 && groups.includes("exclude")) ||
        (groups.includes("bots") && groups.includes("humans"));
      if (!clash) continue;
      const [first, ...rest] = at;
      const kind = key.slice(0, key.indexOf(":"));
      ctx.addIssue({
        code: "custom",
        message: `${first?.place} (${kind === "email" ? "an" : "a"} ${kind}: key) is also ${rest.map((r) => r.place).join(" and ")}`,
        path: [],
      });
    }
    const ids = config.people.flatMap((entry, p) =>
      entry.id === undefined ? [] : [[entry.id, p]],
    );
    const seen = new Map<string, number>();
    for (const [id, p] of ids as [string, number][]) {
      if (seen.has(id))
        ctx.addIssue({
          code: "custom",
          message: `people[${p}] sets the id people[${seen.get(id)}] sets`,
          path: ["people", p, "id"],
        });
      seen.set(id, p);
    }
  });
export type PeopleConfig = z.infer<typeof PeopleConfig>;

/** A JSON key as an error may show it: short and plain, or "?". */
const shownKey = (key: string): string => (/^[A-Za-z0-9_-]{1,40}$/.test(key) ? key : "?");

/** `people[1].match[0]` from zod's path. */
const placeOf = (path: readonly PropertyKey[]): string =>
  path
    .map((part, i) =>
      typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`,
    )
    .join("");

/**
 * Parses a people file's JSON, or says what is wrong with it in lines that name each key's kind
 * and place and never its value (an email key's value is personal data), nor an unknown key that
 * is not a plain word.
 */
export function parsePeopleConfig(
  json: unknown,
): { config: PeopleConfig; problems: [] } | { config: null; problems: string[] } {
  const result = PeopleConfig.safeParse(json);
  if (result.success) return { config: result.data, problems: [] };
  const problems = result.error.issues.map((issue) => {
    const place = placeOf(issue.path) || "the people file";
    if (issue.code === "unrecognized_keys")
      return `${place}: unknown ${issue.keys.length === 1 ? "key" : "keys"} ${issue.keys.map(shownKey).join(", ")}`;
    if (issue.code === "custom" && issue.path.length === 0) return issue.message;
    return `${place}: ${issue.message}`;
  });
  return { config: null, problems };
}

/**
 * A key as a message may show it (a key that matched nobody, say): a name or login key whole,
 * an email key as its kind only, since its value is personal data.
 */
export function shownMatchKey(key: string): string {
  const parsed = parseMatchKey(key);
  if (parsed === null) return "a malformed key";
  return parsed.kind === "email" ? "an email: key" : `${parsed.kind}:${parsed.value}`;
}

/** A key as the store keeps it: SHA-256 of the store's salt and the key (spec v2 #6 R10). */
export function saltedKey(salt: string, key: string): string {
  return createHash("sha256").update(`${salt}\0${key}`).digest("hex");
}

/** What a login, name or email resolves to in the People registry (spec v2 #6 §6). */
export type ResolvedPerson =
  | { kind: "person"; id: string }
  | { kind: "bot" }
  | { kind: "excluded" };

/**
 * The identity keys a query names, as resolveIdentities forms them: `login:` lowercased, `name:`
 * normalized, `email:` trimmed and lowercased. Unusable parts give no key.
 */
export function queryKeys(query: { login?: string; name?: string; email?: string }): string[] {
  const keys = [
    query.login === undefined ? null : parseMatchKey(`login:${query.login.toLowerCase()}`),
    query.name === undefined ? null : parseMatchKey(`name:${query.name}`),
    query.email === undefined ? null : parseMatchKey(`email:${query.email}`),
  ];
  return keys.flatMap((k) => (k === null ? [] : [`${k.kind}:${k.value}`]));
}
