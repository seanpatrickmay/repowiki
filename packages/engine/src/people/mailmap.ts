/** An author identity as a commit records it, or as the mailmap rewrites it. */
export interface Identity {
  name: string;
  email: string;
}

/** What a mailmap entry gives a commit: a proper name, a proper email, or both. */
export interface MailmapInfo {
  name: string | null;
  email: string | null;
}

/**
 * Everything a mailmap says about one commit email, as git keeps it (mailmap.c): the simple entry
 * (lines with no commit name, merged: each sets the name or the email it gives), and the entries
 * for a commit name, each the last line naming it, whole.
 */
export interface MailmapEntry extends MailmapInfo {
  /** By the commit name, ASCII-lowercased. */
  named: Map<string, MailmapInfo>;
}

/** A parsed mailmap: its entries by commit email, and how many lines git ignores. */
export interface Mailmap {
  /** By the commit email, ASCII-lowercased (git compares with strcasecmp). */
  entries: Map<string, MailmapEntry>;
  skipped: number;
}

/** strcasecmp's folding: ASCII letters only. */
const folded = (text: string): string => text.replace(/[A-Z]+/g, (s) => s.toLowerCase());

/** C's isspace, which git trims names with. */
const SPACE = "[ \\t\\n\\v\\f\\r]";
const TRIM = new RegExp(`^${SPACE}+|${SPACE}+$`, "g");

/**
 * git's parse_name_and_email: a name before the first `<`, trimmed (null when empty), and the
 * email up to the next `>`, as written; the rest of the line. Null without both brackets, or for
 * an empty email unless `emptyEmail`.
 */
function nameAndEmail(
  text: string,
  emptyEmail: boolean,
): { name: string | null; email: string; rest: string } | null {
  const left = text.indexOf("<");
  if (left === -1) return null;
  const right = text.indexOf(">", left + 1);
  if (right === -1 || (!emptyEmail && right === left + 1)) return null;
  const name = text.slice(0, left).replace(TRIM, "");
  return {
    name: name === "" ? null : name,
    email: text.slice(left + 1, right),
    rest: text.slice(right + 1),
  };
}

/**
 * Parses `.mailmap` text, read from the blob at the sha (spec v2 #6 §6.1), never the work tree,
 * exactly as git reads it (mailmap.c, checked against `git check-mailmap`): every form
 * (`Proper <commit>`, `<proper> <commit>`, `Proper <proper> <commit>`, `Proper <proper> Commit
 * <commit>`); a line starting with `#` is a comment; a first email must not be empty, so
 * `Name <> <old>` is ignored; text after the last email is ignored. Lines with no commit name
 * for one email merge (each sets the name or the email it gives); a line naming a commit name
 * replaces that name's entry whole. A line git ignores, or one that gives no name and no email,
 * is counted in `skipped`, blank ones aside.
 */
export function parseMailmap(text: string): Mailmap {
  const entries = new Map<string, MailmapEntry>();
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const first = nameAndEmail(line, false);
    if (first === null) {
      if (line.trim() !== "") skipped++;
      continue;
    }
    const second = first.rest === "" ? null : nameAndEmail(first.rest, true);
    // One email: it is the commit's, and the line gives a name only.
    const commitEmail = second === null ? first.email : second.email;
    const properEmail = second === null ? null : first.email;
    const commitName = second?.name ?? null;
    if (first.name === null && properEmail === null) {
      // `<only@x>` names an email and gives it nothing.
      skipped++;
      continue;
    }
    const key = folded(commitEmail);
    const entry = entries.get(key) ?? { name: null, email: null, named: new Map() };
    entries.set(key, entry);
    if (commitName === null) {
      if (first.name !== null) entry.name = first.name;
      if (properEmail !== null) entry.email = properEmail;
    } else entry.named.set(folded(commitName), { name: first.name, email: properEmail });
  }
  return { entries, skipped };
}

/**
 * The identity after the mailmap, as git's map_user gives it: the entry for the commit email;
 * within it, the entry for the commit name if one exists, else the simple one; each of its name
 * and email replaces the commit's. `properName` is true when the mailmap gave the name (spec v2
 * #6 R14 ranks the mailmap's proper name second, after the people file's).
 */
export function applyMailmap(
  identity: Identity,
  mailmap: Mailmap,
): Identity & { properName: boolean } {
  const entry = mailmap.entries.get(folded(identity.email));
  const info = entry === undefined ? undefined : (entry.named.get(folded(identity.name)) ?? entry);
  if (info === undefined || (info.name === null && info.email === null))
    return { ...identity, properName: false };
  return {
    name: info.name ?? identity.name,
    email: info.email ?? identity.email,
    properName: info.name !== null,
  };
}
