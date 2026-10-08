import { normalizeName } from "@repowiki/core";
import type { IdentityGroup } from "./identities.ts";

/**
 * An email as people:suggest may show it (spec v2 #6 R10): the first three characters of the
 * local part, then "…@" and the domain. Nothing else in RepoWiki prints an address at all.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "…";
  return `${[...email.slice(0, at)].slice(0, 3).join("")}…@${email.slice(at + 1)}`;
}

/** Why two people may be one (R8): a rule people:suggest names and never applies. */
export type SuggestRule =
  | "handle = first name + last initial"
  | "handle = first.last"
  | "handle = first initial + last name"
  | "an email's local part is the handle";

export interface Suggestion {
  /** Indexes into the groups: the handle's, and the full name's. */
  handle: number;
  name: number;
  rule: SuggestRule;
}

const letters = (text: string) => text.replace(/[^a-z0-9.]/g, "");

/** The rule by which `handle` abbreviates the full name `full`, or null. */
function abbreviates(handle: string, full: string): SuggestRule | null {
  const words = full
    .split(" ")
    .map(letters)
    .filter((w) => w !== "");
  const first = words[0];
  const last = words.at(-1);
  if (words.length < 2 || first === undefined || last === undefined) return null;
  if (handle === `${first}${last[0]}`) return "handle = first name + last initial";
  if (handle === `${first}.${last}`) return "handle = first.last";
  if (handle === `${first[0]}${last}`) return "handle = first initial + last name";
  return null;
}

/**
 * Fuzzy matches between people the automatic rules kept apart (spec v2 #6 R8): a one-word handle
 * that abbreviates another person's full name (`wyattb` and "Wyatt B…", `w.brown`, `wbrown`), or
 * an email local part of one equal to the other's handle. Humans only, excluded people never.
 * Suggested to the owner, never applied: a wrong merge would publish one person's work under
 * another's name.
 */
export function suggestMerges(groups: readonly IdentityGroup[]): Suggestion[] {
  const out: Suggestion[] = [];
  const candidate = (g: IdentityGroup) => g.kind === "human" && !g.excluded;
  groups.forEach((a, i) => {
    if (!candidate(a)) return;
    // A handle is a one-word name: `wyattb`, `w.brown`.
    const handles = [
      ...new Set(
        a.identities
          .map((p) => normalizeName(p.name))
          .filter((name) => name !== "" && !name.includes(" "))
          .map(letters),
      ),
    ].filter((h) => h !== "");
    if (handles.length === 0) return;
    groups.forEach((b, j) => {
      if (i === j || !candidate(b)) return;
      const fulls = b.identities.map((p) => normalizeName(p.name)).filter((n) => n.includes(" "));
      let rule: SuggestRule | null = null;
      for (const handle of handles) for (const full of fulls) rule ??= abbreviates(handle, full);
      const locals = b.identities.map((p) =>
        p.email.slice(0, p.email.lastIndexOf("@")).toLowerCase(),
      );
      if (rule === null && locals.some((local) => handles.includes(local)))
        rule = "an email's local part is the handle";
      if (rule !== null) out.push({ handle: i, name: j, rule });
    });
  });
  return out;
}

/** The people-file entry that would apply a suggestion: name keys only, so no email is shown. */
export function suggestionSnippet(
  groups: readonly IdentityGroup[],
  suggestion: Suggestion,
): string {
  const handle = groups[suggestion.handle] as IdentityGroup;
  const full = groups[suggestion.name] as IdentityGroup;
  const keys = [
    ...new Set(
      [...full.identities, ...handle.identities].map((p) => `name:${normalizeName(p.name)}`),
    ),
  ];
  return JSON.stringify({ name: full.name, match: keys });
}
