import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type PeopleConfig,
  PersonId,
  parseMatchKey,
  parsePeopleConfig,
  withoutEmails,
} from "@repowiki/core";
import {
  markdownCodeSpan,
  maskEmail,
  type PeopleRead,
  suggestionSnippet,
  suggestMerges,
  wantsNarrative,
} from "@repowiki/engine";
import type { LedgerTotals } from "@repowiki/llm";
import { CliError } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { acquireBuildLock, badOption, cell, costLines, count, once, priced } from "./wiki-cli.ts";

export const SUGGEST_USAGE =
  "usage: pnpm people:suggest <repo-path> [--out dir] [--people-file file]";

export interface SuggestArgs {
  repo: string;
  out: string | null;
  peopleFile: string | null;
}

/** `<repo>` plus spec v2 #6 §10's flags, by wiki:build's rules: a repeat or an empty value is exit 2. */
export function parseSuggestArgs(argv: readonly string[]): SuggestArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        out: { type: "string", multiple: true },
        "people-file": { type: "string", multiple: true },
      },
    });
  } catch (err) {
    throw badOption(err, SUGGEST_USAGE);
  }
  const [repo, ...extra] = parsed.positionals;
  if (repo === undefined || extra.length > 0) throw new CliError(SUGGEST_USAGE);
  if (repo === "") throw new CliError(`<repo-path> must not be empty; ${SUGGEST_USAGE}`);
  const v = parsed.values as Record<string, string[] | undefined>;
  return {
    repo,
    out: once("--out", v.out, SUGGEST_USAGE) ?? null,
    peopleFile: once("--people-file", v["people-file"], SUGGEST_USAGE) ?? null,
  };
}

/** The people file's name in the out dir (spec v2 #6 R9). */
export const PEOPLE_FILE = "people.json";

/**
 * The people file's path (R9): `--people-file`, else `<out>/people.json`. A path inside the
 * documented repository, or one that resolves there through a link, is a usage error: the file
 * names people who asked not to appear, so it must never be committed.
 */
export function peopleFilePath(repo: string, out: string, flag: string | null): string {
  const path = resolve(flag ?? join(out, PEOPLE_FILE));
  const refuse = () =>
    new CliError(
      "refusing a people file inside the documented repository; keep it outside, such as in the out dir",
    );
  const dir = resolveOutDir(repo, dirname(path));
  if (dir === null) throw refuse();
  const file = join(dir, basename(path));
  if (existsSync(file) && resolveOutDir(repo, dirname(realpathSync(file))) === null) throw refuse();
  return file;
}

/**
 * The people file at `path`, parsed (R9); every default when there is none. A broken link or an
 * unreadable file is a usage error, never the defaults (they would publish an excluded person),
 * as is a file that is not JSON or fails the schema, listing what is wrong, never an email key's
 * value.
 */
export function loadPeopleFile(path: string): PeopleConfig {
  if (!existsSync(path)) {
    if (isEntry(path)) throw new CliError(`the people file ${path} is a broken link`);
    return parsePeopleConfig({}).config as PeopleConfig;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CliError(`cannot read the people file ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CliError(`${path} is not a JSON people file`);
  }
  const parsed = parsePeopleConfig(json);
  if (parsed.config === null)
    throw new CliError(`${path} is not a valid people file: ${parsed.problems.join("; ")}`);
  return parsed.config;
}

/** Whether anything, a dangling link included, is at `path`. */
function isEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * people:suggest's report (spec v2 #6 §6 step 6): one row per person with their names, masked
 * emails, logins, commits, how the rules joined them and whether they get a narrative (consent,
 * then maxNarratives by rank, as planNarratives ranks); then each suggested merge with its rule
 * and the people-file entry to paste. Every string is a code span (`cell`), so no name can break
 * the table, and every part but the masked addresses (built from the parsed address and stripped
 * of control characters by maskEmail) passes withoutEmails as a final guard (R10).
 */
export function renderSuggest(read: PeopleRead, config: PeopleConfig): string {
  const { groups } = read.identities;
  const ids = read.assigned.ids;
  const guarded = (text: string) => cell(withoutEmails(text));
  const ranked = groups
    .map((g, i) => ({ g, id: ids[i] ?? "" }))
    .filter(({ g }) => wantsNarrative(g, config))
    .sort((a, b) => b.g.commits - a.g.commits || (a.id < b.id ? -1 : 1));
  const rank = new Map(ranked.map(({ g }, r) => [g, r]));
  const narrative = (g: (typeof groups)[number]) => {
    const r = rank.get(g);
    if (r === undefined) return "no";
    if (r >= config.maxNarratives) return `no (over the cap of ${config.maxNarratives})`;
    return g.narrative === true ? "yes (people file)" : "yes (owner)";
  };
  const lines = [
    "| Id | Name | Other names | Emails | Logins | Commits | Joined by | Narrative |",
    "|---|---|---|---|---|---:|---|---|",
    ...groups.map((g, i) => {
      const id = g.excluded
        ? "excluded"
        : g.kind === "bot"
          ? `${guarded(ids[i] ?? "")} (bot)`
          : guarded(ids[i] ?? "");
      const emails = [...new Set(g.identities.map((p) => maskEmail(p.email.toLowerCase())))];
      return [
        "",
        id,
        guarded(g.name),
        g.otherNames.map(guarded).join(", "),
        emails.map(cell).join(", "),
        g.logins.map(guarded).join(", "),
        count(g.commits),
        withoutEmails(g.reasons.join(", ")),
        narrative(g),
        "",
      ]
        .join(" | ")
        .trim();
    }),
  ];
  const suggestions = suggestMerges(groups);
  lines.push("");
  if (suggestions.length === 0) lines.push("No suggested merges.");
  else {
    lines.push(
      'Suggested merges (not applied; paste an entry into the people file\'s "people" list):',
    );
    for (const s of suggestions) {
      lines.push(
        `- ${guarded(groups[s.handle]?.name ?? "")} and ${guarded(groups[s.name]?.name ?? "")}: ${s.rule}`,
        ...suggestionSnippet(groups, ids, s).map((line) => `  ${withoutEmails(line)}`),
      );
    }
  }
  return lines.join("\n");
}

export const PEOPLE_USAGE =
  "usage: pnpm wiki:people <repo-path> [--out dir] [--people-file file] [--config file.json] [--no-narrative] [--only <person-id>]... [--rebuild-blame] [--no-batch] [--max-usd N] [--dry-run] [--disable] [--forget <match-key>] [--verbose]";

/** wiki:people's narrative ceiling unless --max-usd says otherwise (R26). */
export const DEFAULT_PEOPLE_MAX_USD = 1;
/** wiki:update's and wiki:replay's People ceiling unless --people-max-usd says otherwise (R26). */
export const DEFAULT_PEOPLE_UPDATE_MAX_USD = 0.5;
/** The highest ceiling: a typo of a few zeros must not lift it. */
const MAX_MAX_USD = 100;

/** A dollar ceiling as eval:run parses --max-usd: digits, above 0, at most $100. */
export function parseUsd(
  flag: string,
  text: string | undefined,
  fallback: number,
  usage: string,
): number {
  if (text === undefined) return fallback;
  const usd = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || !(usd > 0 && usd <= MAX_MAX_USD))
    throw new CliError(
      `${flag} must be a number of dollars above 0 and up to ${MAX_MAX_USD}; ${usage}`,
    );
  return usd;
}

export interface PeopleArgs {
  repo: string;
  out: string | null;
  peopleFile: string | null;
  config: string | null;
  narrative: boolean;
  only: string[];
  rebuildBlame: boolean;
  batch: boolean;
  maxUsd: number;
  dryRun: boolean;
  disable: boolean;
  /** A people-file match key (spec v2 #6 §9); an email key's value is never echoed. */
  forget: string | null;
  verbose: boolean;
}

/**
 * wiki:people's arguments (spec v2 #6 §10) by wiki-cli's rules: a repeated flag, an empty value
 * or an unknown flag is a usage error. `--only` takes person ids and may repeat. `--disable` and
 * `--forget` each stand alone: neither refreshes or writes a narrative.
 */
export function parsePeopleArgs(argv: readonly string[]): PeopleArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        out: { type: "string", multiple: true },
        "people-file": { type: "string", multiple: true },
        config: { type: "string", multiple: true },
        "no-narrative": { type: "boolean", multiple: true },
        only: { type: "string", multiple: true },
        "rebuild-blame": { type: "boolean", multiple: true },
        "no-batch": { type: "boolean", multiple: true },
        "max-usd": { type: "string", multiple: true },
        "dry-run": { type: "boolean", multiple: true },
        disable: { type: "boolean", multiple: true },
        forget: { type: "string", multiple: true },
        verbose: { type: "boolean", multiple: true },
      },
    });
  } catch (err) {
    throw badOption(err, PEOPLE_USAGE);
  }
  const [repo, ...extra] = parsed.positionals;
  if (repo === undefined || extra.length > 0) throw new CliError(PEOPLE_USAGE);
  if (repo === "") throw new CliError(`<repo-path> must not be empty; ${PEOPLE_USAGE}`);
  const v = parsed.values as Record<string, (string | boolean)[] | undefined>;
  const text = (flag: string) => once(`--${flag}`, v[flag] as string[] | undefined, PEOPLE_USAGE);
  const flag = (name: string) =>
    once(`--${name}`, v[name] as boolean[] | undefined, PEOPLE_USAGE) === true;
  const only = (v.only as string[] | undefined) ?? [];
  for (const id of only)
    if (!PersonId.safeParse(id).success)
      throw new CliError(`--only takes a person id such as ada-lovelace; ${PEOPLE_USAGE}`);
  const forget = text("forget") ?? null;
  if (forget !== null && parseMatchKey(forget) === null)
    throw new CliError(
      `--forget takes a people-file match key: name:<text>, email:<address> or login:<github-login>; ${PEOPLE_USAGE}`,
    );
  const args: PeopleArgs = {
    repo,
    out: text("out") ?? null,
    peopleFile: text("people-file") ?? null,
    config: text("config") ?? null,
    narrative: !flag("no-narrative"),
    only,
    rebuildBlame: flag("rebuild-blame"),
    batch: !flag("no-batch"),
    maxUsd: parseUsd("--max-usd", text("max-usd"), DEFAULT_PEOPLE_MAX_USD, PEOPLE_USAGE),
    dryRun: flag("dry-run"),
    disable: flag("disable"),
    forget,
    verbose: flag("verbose"),
  };
  const alone = args.disable ? "--disable" : args.forget !== null ? "--forget" : null;
  const others =
    !args.narrative ||
    args.only.length > 0 ||
    args.rebuildBlame ||
    !args.batch ||
    v["max-usd"] !== undefined ||
    args.dryRun ||
    (args.disable && args.forget !== null);
  if (alone !== null && others)
    throw new CliError(`${alone} takes no other run flag; ${PEOPLE_USAGE}`);
  return args;
}

/** Output tokens a narrative is assumed to take before any is written (spec v2 #6 §8.5). */
export const ASSUMED_PERSON_OUTPUT_TOKENS = 2500;

/**
 * One narrative's ceiling (R26): its call and a retry that resends the turn and the draft, each
 * with the system prompt, priced at the model's rates, halved when batched; no cache hit.
 */
export function narrativeCeilingUsd(
  turnTokens: number,
  systemTokens: number,
  model: string,
  batch: boolean,
): number {
  const input = 2 * (systemTokens + turnTokens) + ASSUMED_PERSON_OUTPUT_TOKENS;
  return priced(model, input, 2 * ASSUMED_PERSON_OUTPUT_TOKENS, batch);
}

/**
 * The narratives a ceiling allows (R26, C12): in the order given (rank), each counted at its
 * ceiling, taken while the next fits; the rest are over budget and stay due.
 */
export function withinBudget<T>(
  items: readonly T[],
  costOf: (item: T) => number,
  maxUsd: number,
): { taken: T[]; over: T[]; usd: number } {
  let usd = 0;
  let i = 0;
  for (; i < items.length; i++) {
    const cost = costOf(items[i] as T);
    if (usd + cost > maxUsd) break;
    usd += cost;
  }
  return { taken: items.slice(0, i), over: items.slice(i), usd };
}

/** One person's row of the People summary and the dry run's table. */
export interface PeopleRow {
  id: string;
  name: string;
  kind: "human" | "bot";
  commits: number;
  /** What happened to the narrative: written, appended, carried, failed: …, over budget, … */
  narrative: string;
  dropped: number;
}

/** The people table: every string a code span, so no name can break a row (spec v2 #6 §10). */
export function peopleTable(rows: readonly PeopleRow[]): string[] {
  return [
    "| Person | Name | Commits | Narrative | Dropped |",
    "|---|---|---:|---|---:|",
    ...rows.map(
      (r) =>
        `| ${cell(r.id)}${r.kind === "bot" ? " (bot)" : ""} | ${cell(r.name)} | ${count(r.commits)} | ${r.narrative} | ${r.dropped} |`,
    ),
  ];
}

/**
 * The People summary `people-<sha7>.md` (spec v2 #6 §10): each person's row, the notes (an
 * exclusion's caveats, skipped narratives), then the LLM cost block in the build summary's format.
 */
export function renderPeopleSummary(
  repoName: string,
  sha: string,
  rows: readonly PeopleRow[],
  notes: readonly string[],
  totals: LedgerTotals,
  estimateUsd: number | null,
): string {
  const humans = rows.filter((r) => r.kind === "human").length;
  const upFront =
    estimateUsd === null ? "." : ` (estimated up front: at most $${estimateUsd.toFixed(4)}).`;
  const lines = [
    `# People: ${markdownCodeSpan(repoName)} at ${sha.slice(0, 7)}`,
    "",
    `${rows.length} people (${humans} with a page, ${rows.length - humans} bots).`,
    "",
    ...peopleTable(rows),
    "",
    ...notes.flatMap((n) => [n, ""]),
    ...costLines(totals, upFront, estimateUsd !== null, PEOPLE_ESTIMATE_NOTE),
  ];
  return `${lines.join("\n")}\n`;
}

/** What a People summary says of its estimate. */
export const PEOPLE_ESTIMATE_NOTE =
  "The estimate counts each narrative's call and a retry, with no cache hits: an upper-side figure.";

/**
 * What wiki:people says when the people file excludes someone (spec v2 #6 R12, §12): repository
 * text naming them is not rewritten, and with exactly one excluded person the anonymous series
 * names them by elimination.
 */
export function exclusionNotes(excluded: number, othersShown: boolean): string[] {
  if (excluded === 0) return [];
  const notes = [
    `${excluded} ${excluded === 1 ? "person is" : "people are"} excluded: no page, name or id of theirs is generated; repository text that names them (commit subjects, pull request titles) is not rewritten.`,
  ];
  if (excluded === 1 && othersShown)
    notes.push(
      'With exactly one person excluded, the "other contributors" series is theirs by elimination; set othersMinPeople to 2 to leave it out.',
    );
  return notes;
}

/** The prefix of a throwaway store copy's directory in the out dir. */
export const PEOPLE_SCRATCH_PREFIX = ".people-scratch-";

/**
 * A throwaway copy of the out dir's wiki.db, taken under the build lock (planner ruling R17):
 * people:suggest and wiki:people --dry-run read and refresh it, so the real store is never
 * written or migrated. The copy holds names and salted keys, so it goes under the out dir
 * (`<out>/.people-scratch-*`), which is outside the documented repository, never under TMPDIR,
 * which may not be. `remove` deletes the copy.
 */
export function storeCopy(out: string): { path: string; remove: () => void } {
  const db = join(out, "wiki.db");
  const scratch = mkdtempSync(join(out, PEOPLE_SCRATCH_PREFIX));
  const remove = () => rmSync(scratch, { recursive: true, force: true });
  try {
    const release = acquireBuildLock(out, (line) => console.error(line));
    try {
      for (const suffix of ["", "-wal", "-shm"])
        if (existsSync(`${db}${suffix}`))
          copyFileSync(`${db}${suffix}`, join(scratch, `wiki.db${suffix}`));
    } finally {
      release();
    }
  } catch (err) {
    remove();
    throw err;
  }
  return { path: join(scratch, "wiki.db"), remove };
}

/** A People round's ledger run ids start with this, then the sha and the start time. */
export const WIKI_PEOPLE_RUN_PREFIX = "wiki-people-";
