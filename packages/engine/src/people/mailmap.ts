/** An author identity as a commit records it, or as the mailmap rewrites it. */
export interface Identity {
  name: string;
  email: string;
}

/**
 * One `.mailmap` line (git-check-mailmap(1)): commits whose email (and, when given, name) match
 * take the proper name and/or email. Emails and names match case-insensitively, as git does.
 */
export interface MailmapRule {
  matchEmail: string;
  /** Lowercased; null matches any name with the email. */
  matchName: string | null;
  properName: string | null;
  properEmail: string | null;
}

/** A parsed mailmap: its rules, and how many lines were neither rules nor comments. */
export interface Mailmap {
  rules: MailmapRule[];
  skipped: number;
}

/** `Name <email>`, then optionally a second `Name <email>`; anything after is ignored, as git does. */
const LINE = /^([^<>]*)<([^<>]*)>(?:([^<>]*)<([^<>]*)>)?/;

/**
 * Parses `.mailmap` text, read from the blob at the sha (spec v2 #6 §6.1), never the work tree,
 * in all four of git's forms: `Proper <commit>`, `<proper> <commit>`, `Proper <proper> <commit>`
 * and `Proper <proper> Commit <commit>`. Blank lines and `#` comments are skipped; a malformed
 * line is skipped and counted. Later lines win over earlier ones for the same match.
 */
export function parseMailmap(text: string): Mailmap {
  const rules: MailmapRule[] = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (match === null) {
      skipped++;
      continue;
    }
    const [, firstName = "", firstEmail = "", secondName = "", secondEmail] = match;
    const name1 = firstName.trim();
    const email1 = firstEmail.trim().toLowerCase();
    if (secondEmail === undefined) {
      if (name1 === "" || email1 === "") {
        skipped++;
        continue;
      }
      rules.push({ matchEmail: email1, matchName: null, properName: name1, properEmail: null });
      continue;
    }
    const email2 = secondEmail.trim().toLowerCase();
    const name2 = secondName.trim();
    if (email2 === "" || (name1 === "" && email1 === "")) {
      skipped++;
      continue;
    }
    rules.push({
      matchEmail: email2,
      matchName: name2 === "" ? null : name2.toLowerCase(),
      properName: name1 === "" ? null : name1,
      properEmail: email1 === "" ? null : email1,
    });
  }
  return { rules, skipped };
}

/**
 * The identity after the mailmap: the last rule matching both the email and the name wins, else
 * the last matching the email alone. `properName` is true when a rule gave the name (spec v2 #6
 * R14 ranks the mailmap's proper name second, after the people file's).
 */
export function applyMailmap(
  identity: Identity,
  mailmap: Mailmap,
): Identity & { properName: boolean } {
  const email = identity.email.trim().toLowerCase();
  const name = identity.name.trim().toLowerCase();
  let byEmail: MailmapRule | undefined;
  let byBoth: MailmapRule | undefined;
  for (const rule of mailmap.rules) {
    if (rule.matchEmail !== email) continue;
    if (rule.matchName === null) byEmail = rule;
    else if (rule.matchName === name) byBoth = rule;
  }
  const rule = byBoth ?? byEmail;
  if (rule === undefined) return { ...identity, properName: false };
  return {
    name: rule.properName ?? identity.name,
    email: rule.properEmail ?? identity.email,
    properName: rule.properName !== null,
  };
}
