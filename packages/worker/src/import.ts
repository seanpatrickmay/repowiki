import type { PeopleSnapshot, WikiExport } from "@repowiki/core";
import { Facts } from "@repowiki/hosted";
import { authorFacts, type FileFacts, languageShares, pageFeatureIds } from "./facts.ts";
import { AUTHOR_ID } from "./people-file.ts";

/**
 * The worker's `import` mode (M14g, local testing only): instead of cloning and building, it
 * uploads the wiki the user already built (`~/.repowiki/<repo>/export.json`), named by the
 * local profile the server serves as its fake GitHub. No model is called.
 */

type Person = PeopleSnapshot["people"][number];
export interface Author {
  login: string;
  name: string | null;
}

/** `Sean May`, `sean-may` and `SEAN_MAY` all give `sean-may`; empty for a name with no letters. */
const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const keys = (names: readonly string[]) =>
  new Set(names.flatMap((n) => [n.trim().toLowerCase(), slug(n)]).filter((k) => k !== ""));

/**
 * The People snapshot's human whose id, name or other names equal the author's login, or else
 * their display name, ignoring case and spacing. Null when nobody matches or two people do:
 * the author never gets someone else's numbers.
 */
export function matchAuthor(snapshot: PeopleSnapshot, author: Author): Person | null {
  const humans = snapshot.people.filter((p) => p.kind === "human");
  const named = (name: string) => {
    const wanted = keys([name]);
    return humans.filter((p) =>
      [...keys([p.id, p.name, ...p.otherNames])].some((k) => wanted.has(k)),
    );
  };
  for (const name of [author.login, author.name]) {
    if (name === null) continue;
    const found = named(name);
    if (found.length === 1) return found[0] ?? null;
    if (found.length > 1) return null;
  }
  return null;
}

/**
 * A generation's facts from a built export: indexed files and languages from the page
 * infoboxes (each page's lines split evenly across its languages), the author's share from
 * People. Zeros when People is off or does not name the author.
 */
export function exportFacts(exp: WikiExport, author: Author): Facts {
  const files = exp.pages.flatMap(({ infobox }): FileFacts[] => {
    const langs = infobox.languages;
    if (langs.length === 0) return [{ language: null, loc: infobox.loc, skipped: null }];
    return langs.map((language) => ({ language, loc: infobox.loc / langs.length, skipped: null }));
  });
  const featureIds = pageFeatureIds(exp);
  const snapshot = exp.people?.snapshot ?? null;
  const person = snapshot === null ? null : matchAuthor(snapshot, author);
  return Facts.parse({
    languages: languageShares(files),
    indexedFiles: exp.pages.reduce((sum, page) => sum + page.infobox.files, 0),
    featureIds,
    author: authorFacts(
      snapshot && { ...snapshot, people: person === null ? [] : [{ ...person, id: AUTHOR_ID }] },
      featureIds,
    ),
  });
}
