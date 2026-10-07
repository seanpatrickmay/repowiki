import {
  cleanPersonName,
  normalizeName,
  type PeopleConfig,
  parseMatchKey,
  saltedKey,
  shownMatchKey,
  withoutEmails,
} from "@repowiki/core";
import type { AuthoredCommit } from "../index/index.ts";
import { applyMailmap, type Mailmap } from "./mailmap.ts";

/** Why two identities are one person (spec v2 #6 R7), as people:suggest shows it. */
export type JoinReason = "same email" | "same login" | "name is login" | "same full name";

/** One distinct (name, email) author pair, as written in the commits. In memory only. */
export interface RawIdentity {
  name: string;
  email: string;
  /** Non-merge commits under the pair, and all of its commits. */
  commits: number;
  allCommits: number;
  /** Author dates of its earliest and latest commit, merges included. */
  first: string;
  last: string;
  /** The pair's salted keys, sorted (the registry tells a split by them, R13). */
  keys: string[];
}

/** One person as the identity rules see them (spec v2 #6 §6). */
export interface IdentityGroup {
  /** The pairs of the group, earliest first. Never stored or exported: emails are in them. */
  identities: RawIdentity[];
  /** Salted SHA-256 keys of every name, email and login of the group, sorted (R10). */
  keys: string[];
  /** The salted keys among `keys` of its emails and of its logins: the registry's strong evidence. */
  emailKeys: string[];
  loginKeys: string[];
  /** The display name (R14). */
  name: string;
  /** Every other cleaned name, sorted, without the display name or a derived login. */
  otherNames: string[];
  kind: "human" | "bot";
  /**
   * True for a human group some (not all) of whose identities look like bots (R11), with no
   * bots: or humans: key deciding it: a group is a bot only when every identity looks like one,
   * and people:suggest flags the mixed ones.
   */
  partlyBot: boolean;
  excluded: boolean;
  /** True when the group is the owner's (planner ruling R3). */
  owner: boolean;
  /** The people-file entry that names the group, its id and narrative flag, or null. */
  entry: number | null;
  id: string | null;
  narrative: boolean | null;
  /** How the automatic rules joined the group's pairs, sorted. */
  reasons: JoinReason[];
  /** GitHub logins derived from noreply addresses and login keys; shown only by people:suggest. */
  logins: string[];
  /** Non-merge commits, and the author dates of the first and last commit, merges included. */
  commits: number;
  firstCommit: string;
  lastCommit: string;
}

export interface IdentityInput {
  commits: readonly AuthoredCommit[];
  mailmap: Mailmap;
  config: PeopleConfig;
  /** The store's salt (Store.getPeopleSalt). */
  salt: string;
  /**
   * The owner's address when the people file names no `owner`: the documented repository's
   * configured user.email (planner ruling R3), or null. Compared, never stored or printed.
   */
  ownerEmail: string | null;
}

export interface ResolvedIdentities {
  /** By first commit, then by first key. */
  groups: IdentityGroup[];
  /** The index in `groups` of the commit author (name, email); -1 for a pair it never saw. */
  groupOf(name: string, email: string): number;
  /** One line each: a key that matched nobody, a pair two entries both claim. No email shown. */
  warnings: string[];
}

/** The fixed list of bots (spec v2 #6 R11), compared without a `[bot]` suffix. */
export const KNOWN_BOTS: ReadonlySet<string> = new Set([
  "dependabot",
  "renovate",
  "github-actions",
  "pre-commit-ci",
  "snyk-bot",
  "greenkeeper",
  "mergify",
  "codecov",
  "allcontributors",
  "imgbot",
]);

const NOREPLY = /^(?:\d+\+)?([a-z0-9-]{1,39}(?:\[bot\])?)@users\.noreply\.github\.com$/;

/** The GitHub login of a `users.noreply.github.com` address, lowercased; else null. */
export function noreplyLogin(email: string): string | null {
  return NOREPLY.exec(email.trim().toLowerCase())?.[1] ?? null;
}

/** A key as the store keeps it (R10): core's, re-exported for the people module. */
export { saltedKey };

/** The earlier (later) of two ISO times; of two at one instant, the smaller string, so order never matters. */
const isoMin = (a: string, b: string) => {
  const d = Date.parse(b) - Date.parse(a);
  return d < 0 || (d === 0 && b < a) ? b : a;
};
const isoMax = (a: string, b: string) => {
  const d = Date.parse(b) - Date.parse(a);
  return d > 0 || (d === 0 && b < a) ? b : a;
};

/**
 * Addresses strangers share (the fix-forward ruling): GitHub's no-reply address, the bare
 * noreply form, and any `noreply@` or `no-reply@` address. Never joined on, and no login is read
 * from one; still a key the people file can match.
 */
export const PLACEHOLDER_EMAILS: ReadonlySet<string> = new Set([
  "noreply@github.com",
  "noreply@users.noreply.github.com",
]);

/** Whether `email` is one strangers share, so the email and login rules never join on it. */
export function isPlaceholderEmail(email: string): boolean {
  const lower = email.trim().toLowerCase();
  return PLACEHOLDER_EMAILS.has(lower) || /^no-?reply@/.test(lower);
}

/** A pair's identity keys, unsalted: `email:`, `name:` and `login:` forms of its raw and mapped values. */
function keysOf(raw: { name: string; email: string }, mapped: { name: string; email: string }) {
  const keys = new Set<string>();
  for (const { name, email } of [raw, mapped]) {
    const lower = email.trim().toLowerCase();
    if (lower !== "") keys.add(`email:${lower}`);
    const normal = normalizeName(name);
    if (normal !== "") keys.add(`name:${normal}`);
    const login = isPlaceholderEmail(email) ? null : noreplyLogin(email);
    if (login !== null) keys.add(`login:${login}`);
  }
  return keys;
}

/** A name of two or more words, as the full-name rule (R7) compares it; null otherwise. */
const fullName = (name: string): string | null => {
  const normal = normalizeName(name);
  return normal.split(" ").length >= 2 ? normal : null;
};

/** Is this pair a bot by its name or login (R11)? */
function looksLikeBot(name: string, logins: readonly string[]): boolean {
  const names = [normalizeName(name), ...logins];
  return names.some((n) => n.endsWith("[bot]") || KNOWN_BOTS.has(n.replace(/\[bot\]$/, "")));
}

class UnionFind {
  readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root] as number;
    while (this.parent[i] !== root) {
      const next = this.parent[i] as number;
      this.parent[i] = root;
      i = next;
    }
    return root;
  }
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    // The smaller index stays the root, so the result never depends on visiting order.
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
    return true;
  }
}

/** The display name (R14): the file's, the mailmap's, the most-used of 2+ words, the most-used. */
function displayName(
  entryName: string | undefined,
  pairs: readonly { raw: RawIdentity; mapped: string; proper: boolean }[],
): string {
  if (entryName !== undefined) return entryName;
  const pick = (names: { name: string; commits: number; first: string }[]): string | null => {
    const tally = new Map<string, { commits: number; first: string }>();
    for (const n of names) {
      const clean = cleanPersonName(n.name);
      if (clean === "") continue;
      const was = tally.get(clean);
      tally.set(clean, {
        commits: (was?.commits ?? 0) + n.commits,
        first: was === undefined ? n.first : isoMin(was.first, n.first),
      });
    }
    const ranked = [...tally].sort(
      ([an, a], [bn, b]) =>
        b.commits - a.commits ||
        Date.parse(a.first) - Date.parse(b.first) ||
        (an < bn ? -1 : an > bn ? 1 : 0),
    );
    return ranked[0]?.[0] ?? null;
  };
  const used = (p: (typeof pairs)[number]) => ({
    name: p.mapped,
    commits: p.raw.allCommits,
    first: p.raw.first,
  });
  const proper = pick(pairs.filter((p) => p.proper).map(used));
  if (proper !== null) return proper;
  const all = pairs.map(used);
  return pick(all.filter((n) => cleanPersonName(n.name).split(" ").length >= 2)) ?? pick(all) ?? "";
}

/**
 * Resolves the commits' authors into people (spec v2 #6 §6, R7, R11, R14): each distinct
 * (name, email) pair through the committed mailmap, then the people file's groups (fenced from
 * the automatic rules), exclusions (beating any group) and bot overrides, then the four automatic
 * joins over the rest: a shared case-folded email, a shared login from a noreply address, a name
 * equal to another pair's login, and a shared name of two or more words. Deterministic: the same
 * commits, mailmap and file give the same groups in the same order.
 */
export function resolveIdentities(input: IdentityInput): ResolvedIdentities {
  const { config } = input;
  // 1. Distinct raw pairs, in order of their earliest commit.
  const pairs = new Map<string, RawIdentity>();
  for (const commit of input.commits) {
    const key = `${commit.authorName}\0${commit.authorEmail}`;
    const merge = commit.parents.length > 1;
    const was = pairs.get(key);
    if (was === undefined) {
      pairs.set(key, {
        name: commit.authorName,
        email: commit.authorEmail,
        commits: merge ? 0 : 1,
        allCommits: 1,
        first: commit.authorDate,
        last: commit.authorDate,
        keys: [],
      });
    } else {
      was.commits += merge ? 0 : 1;
      was.allCommits += 1;
      was.first = isoMin(was.first, commit.authorDate);
      was.last = isoMax(was.last, commit.authorDate);
    }
  }
  const raws = [...pairs.values()].sort(
    (a, b) =>
      Date.parse(a.first) - Date.parse(b.first) ||
      (a.email < b.email ? -1 : a.email > b.email ? 1 : a.name < b.name ? -1 : 1),
  );
  // 2. The mailmap, then each pair's keys.
  const mapped = raws.map((raw) => applyMailmap(raw, input.mailmap));
  const keys = raws.map((raw, i) => keysOf(raw, mapped[i] as { name: string; email: string }));
  raws.forEach((raw, i) => {
    raw.keys = [...(keys[i] as Set<string>)].map((k) => saltedKey(input.salt, k)).sort();
  });
  const logins = keys.map((set) =>
    [...set].filter((k) => k.startsWith("login:")).map((k) => k.slice(6)),
  );
  const matches = (i: number, key: string): boolean => {
    const parsed = parseMatchKey(key);
    return parsed !== null && (keys[i] as Set<string>).has(`${parsed.kind}:${parsed.value}`);
  };
  const warnings: string[] = [];
  const seenKey = (key: string) => raws.some((_, i) => matches(i, key));
  for (const key of [
    ...config.people.flatMap((e) => e.match),
    ...config.exclude,
    ...config.bots,
    ...config.humans,
    ...(config.owner ?? []),
  ]) {
    if (!seenKey(key)) warnings.push(`people file: ${shownMatchKey(key)} matches no author`);
  }

  // 3. The people file's groups, fenced off from the automatic rules.
  const entryOf = raws.map(() => -1);
  raws.forEach((_, i) => {
    const entries = config.people.flatMap((e, n) =>
      e.match.some((k) => matches(i, k)) ? [n] : [],
    );
    const [first, ...others] = entries;
    if (first !== undefined) entryOf[i] = first;
    if (others.length > 0)
      warnings.push(
        `people file: one author matches people[${first}] and people[${others.join("], people[")}]; people[${first}] takes it`,
      );
  });
  const union = new UnionFind(raws.length);
  const reasons = new Map<number, Set<JoinReason>>();
  const fenced = (i: number) => entryOf[i] !== -1;
  // A reason only between two distinct identities, neither of them fenced.
  const join = (a: number, b: number, why: JoinReason) => {
    if (a === b || fenced(a) || fenced(b)) return;
    union.union(a, b);
    const at = Math.min(a, b);
    reasons.set(at, (reasons.get(at) ?? new Set()).add(why));
  };
  // 4. The automatic joins (R7), each over the pairs no entry claims: a fenced pair never holds
  // a key, so the pairs after it that share the key still join among themselves.
  const byKey = (prefix: string, why: JoinReason) => {
    const first = new Map<string, number>();
    keys.forEach((set, i) => {
      if (fenced(i)) return;
      for (const key of set) {
        if (!key.startsWith(prefix)) continue;
        if (prefix === "email:" && isPlaceholderEmail(key.slice(prefix.length))) continue;
        const at = first.get(key);
        if (at === undefined) first.set(key, i);
        else join(at, i, why);
      }
    });
  };
  byKey("email:", "same email");
  byKey("login:", "same login");
  raws.forEach((raw, i) => {
    const name = normalizeName(raw.name);
    logins.forEach((list, j) => {
      if (list.includes(name)) join(i, j, "name is login");
    });
  });
  const byFullName = new Map<string, number>();
  raws.forEach((raw, i) => {
    if (fenced(i)) return;
    for (const name of [raw.name, (mapped[i] as { name: string }).name]) {
      const full = fullName(name);
      if (full === null) continue;
      const at = byFullName.get(full);
      if (at === undefined) byFullName.set(full, i);
      else join(at, i, "same full name");
    }
  });
  config.people.forEach((_, n) => {
    const members = raws.flatMap((_, i) => (entryOf[i] === n ? [i] : []));
    for (const i of members.slice(1)) union.union(members[0] as number, i);
  });

  // 5. Groups, with their kind, exclusion, owner, names and keys.
  const members = new Map<number, number[]>();
  raws.forEach((_, i) => {
    const root = union.find(i);
    members.set(root, [...(members.get(root) ?? []), i]);
  });
  const anyMatch = (list: readonly number[], keyList: readonly string[]) =>
    list.some((i) => keyList.some((k) => matches(i, k)));
  // `owner: []` names no owner: only an absent owner falls back to the configured email.
  const ownerKeys =
    config.owner ?? (input.ownerEmail === null ? [] : [`email:${input.ownerEmail.trim()}`]);
  let unnamed = 0;
  const groups: (IdentityGroup & { at: number[] })[] = [...members.values()].map((list) => {
    const entryIndex = list.map((i) => entryOf[i] as number).find((n) => n !== -1);
    const entry = entryIndex === undefined ? undefined : config.people[entryIndex];
    const groupLogins = [...new Set(list.flatMap((i) => logins[i] as string[]))].sort();
    for (const key of entry?.match ?? []) {
      const parsed = parseMatchKey(key);
      if (parsed?.kind === "login" && !groupLogins.includes(parsed.value))
        groupLogins.push(parsed.value);
    }
    groupLogins.sort();
    const named = list.map((i) => ({
      raw: raws[i] as RawIdentity,
      mapped: (mapped[i] as { name: string }).name,
      proper: (mapped[i] as { properName: boolean }).properName,
    }));
    const human = anyMatch(list, config.humans);
    const botLike = list.filter(
      (i) =>
        looksLikeBot((raws[i] as RawIdentity).name, logins[i] as string[]) ||
        looksLikeBot((mapped[i] as { name: string }).name, logins[i] as string[]),
    ).length;
    // A group is a bot by the file's bots: key, or when every identity in it looks like one.
    const bot = !human && (anyMatch(list, config.bots) || botLike === list.length);
    const name = displayName(entry?.name, named);
    const allNames = new Set(
      named.flatMap((p) => [cleanPersonName(p.raw.name), cleanPersonName(p.mapped)]),
    );
    const loginSet = new Set(groupLogins);
    const otherNames = [...allNames]
      .filter((n) => n !== "" && n !== name && !loginSet.has(n.toLowerCase()))
      .sort()
      .slice(0, 10);
    const groupReasons = new Set<JoinReason>();
    for (const i of list) for (const why of reasons.get(i) ?? []) groupReasons.add(why);
    const ids = list.map((i) => raws[i] as RawIdentity);
    const plain = [
      ...new Set([
        ...list.flatMap((i) => [...(keys[i] as Set<string>)]),
        ...groupLogins.map((login) => `login:${login}`),
      ]),
    ];
    const salted = (prefix: string) =>
      plain
        .filter((k) => k.startsWith(prefix))
        .map((k) => saltedKey(input.salt, k))
        .sort();
    return {
      at: list,
      identities: ids,
      keys: salted(""),
      emailKeys: salted("email:"),
      loginKeys: salted("login:"),
      name,
      otherNames,
      kind: bot ? "bot" : "human",
      partlyBot: !human && !bot && botLike > 0,
      excluded: anyMatch(list, config.exclude),
      owner: anyMatch(list, ownerKeys),
      entry: entryIndex ?? null,
      id: entry?.id ?? null,
      narrative: entry?.narrative ?? null,
      reasons: [...groupReasons].sort(),
      logins: groupLogins,
      commits: ids.reduce((n, r) => n + r.commits, 0),
      firstCommit: ids.map((r) => r.first).reduce(isoMin),
      lastCommit: ids.map((r) => r.last).reduce(isoMax),
    };
  });
  // A total order: first commit, then the salted keys, then the earliest pair (unique per group).
  const keyText = (g: { keys: string[] }) => g.keys.join(",");
  groups.sort(
    (a, b) =>
      Date.parse(a.firstCommit) - Date.parse(b.firstCommit) ||
      (keyText(a) < keyText(b) ? -1 : keyText(a) > keyText(b) ? 1 : 0) ||
      (a.at[0] ?? 0) - (b.at[0] ?? 0),
  );
  // A name that cleans to nothing becomes "Contributor <n>", n in order of first commit.
  for (const group of groups) if (group.name === "") group.name = `Contributor ${++unnamed}`;
  const groupIndex = new Map<string, number>();
  groups.forEach((group, g) => {
    for (const i of group.at) {
      const raw = raws[i] as RawIdentity;
      groupIndex.set(`${raw.name}\0${raw.email}`, g);
    }
  });
  return {
    groups: groups.map(({ at: _at, ...group }) => group),
    groupOf: (name, email) => groupIndex.get(`${name}\0${email}`) ?? -1,
    warnings: warnings.map(withoutEmails),
  };
}

/**
 * Whether People writes a group a narrative (spec v2 #6 R15 under the v2 consent ruling): a
 * human, not excluded, with at least minCommits non-merge commits, whose people-file entry says
 * `narrative: true`, or who is the owner and whose entry does not say `narrative: false`.
 * maxNarratives is applied by the caller, ranking by commits.
 */
export function wantsNarrative(group: IdentityGroup, config: PeopleConfig): boolean {
  if (group.kind !== "human" || group.excluded || group.commits < config.minCommits) return false;
  return group.narrative ?? group.owner;
}
