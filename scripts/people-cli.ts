import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type PeopleConfig, parsePeopleConfig } from "@repowiki/core";
import {
  maskEmail,
  type PeopleRead,
  suggestionSnippet,
  suggestMerges,
  wantsNarrative,
} from "@repowiki/engine";
import { CliError } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { badOption, cell, count, once } from "./wiki-cli.ts";

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
 * The people file at `path`, parsed (R9); every default when there is none. A file that is not
 * JSON or fails the schema is a usage error listing what is wrong, never an email key's value.
 */
export function loadPeopleFile(path: string): PeopleConfig {
  if (!existsSync(path)) return parsePeopleConfig({}).config as PeopleConfig;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`${path} is not a JSON people file`);
  }
  const parsed = parsePeopleConfig(json);
  if (parsed.config === null)
    throw new CliError(`${path} is not a valid people file: ${parsed.problems.join("; ")}`);
  return parsed.config;
}

/**
 * people:suggest's report (spec v2 #6 §6 step 6): one row per person with their names, masked
 * emails, logins, commits, how the rules joined them and whether they get a narrative; then each
 * suggested merge with its rule and the people-file entry to paste. Every string is a code span
 * (`cell`), so no name can break the table or reach the terminal raw.
 */
export function renderSuggest(read: PeopleRead, config: PeopleConfig): string {
  const { groups } = read.identities;
  const narrative = (g: (typeof groups)[number]) =>
    !wantsNarrative(g, config) ? "no" : g.narrative === true ? "yes (people file)" : "yes (owner)";
  const lines = [
    "| Id | Name | Other names | Emails | Logins | Commits | Joined by | Narrative |",
    "|---|---|---|---|---|---:|---|---|",
    ...groups.map((g, i) => {
      const id = g.excluded
        ? "excluded"
        : g.kind === "bot"
          ? `${cell(read.assigned.ids[i] ?? "")} (bot)`
          : cell(read.assigned.ids[i] ?? "");
      const emails = [...new Set(g.identities.map((p) => maskEmail(p.email.toLowerCase())))];
      return [
        "",
        id,
        cell(g.name),
        g.otherNames.map(cell).join(", "),
        emails.map(cell).join(", "),
        g.logins.map(cell).join(", "),
        count(g.commits),
        g.reasons.join(", "),
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
        `- ${cell(groups[s.handle]?.name ?? "")} and ${cell(groups[s.name]?.name ?? "")}: ${s.rule}`,
        `  ${suggestionSnippet(groups, s)}`,
      );
    }
  }
  return lines.join("\n");
}
