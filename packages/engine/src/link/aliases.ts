import { aliasProblem, aliasSlug, type Manifest, parseMemberId } from "@repowiki/core";

/** A pattern for one kind of code identifier; group 1 is the identifier as written. */
interface IdentifierPattern {
  kind: "route" | "table" | "env" | "command";
  pattern: RegExp;
  /** The pattern matches `receiver.method(...)`; skip a match whose receiver is an HTTP client. */
  receiverCall?: true;
}

/** One name part of a possibly schema-qualified SQL table name: "x", `x`, [x] or a bare word. */
const SQL_NAME_PART = String.raw`(?:"[^"\s.]+"|\`[^\`\s.]+\`|\[[^\]\s.]+\]|\w+)`;
const ENV_NAME = "[A-Z][A-Z0-9_]{2,}";
const HTTP_METHODS = "get|post|put|patch|delete";

/**
 * Code identifiers that name a feature to a reader (spec §7.3, F01): HTTP routes (Flask or
 * FastAPI decorators on any receiver, Express-style calls on any receiver), table names (SQLAlchemy,
 * SQL, Alembic), environment variables (Python, Node, Vite) and CLI commands (Click or Typer
 * decorators, argparse subcommands). A decorated route matches only the first route pattern and a
 * plain call only the second, so every occurrence counts once.
 *
 * These run over repository text an attacker may write, so each must stay linear-time: no
 * quantifier is nested inside another, no two adjacent quantifiers can match the same text, and
 * the qualified-name repeat is bounded.
 */
export const IDENTIFIER_PATTERNS: readonly IdentifierPattern[] = [
  {
    kind: "route",
    pattern: new RegExp(
      String.raw`@\w+(?:\.\w+)*\.(?:${HTTP_METHODS}|route|api_route)\(\s*["'](\/[^"'\s]+)["']`,
      "g",
    ),
  },
  {
    kind: "route",
    pattern: new RegExp(
      String.raw`(?<![@\w.])\w+(?:\.\w+)*\.(?:${HTTP_METHODS}|all|use)\(\s*["'\`](\/[^"'\`\s]+)["'\`]`,
      "g",
    ),
    receiverCall: true,
  },
  { kind: "table", pattern: /__tablename__\s*=\s*["'](\w+)["']/g },
  {
    kind: "table",
    pattern: new RegExp(
      String.raw`\bCREATE\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:${SQL_NAME_PART}\.){0,3}(${SQL_NAME_PART})\s*\(`,
      "gi",
    ),
  },
  { kind: "table", pattern: /\bop\.create_table\(\s*["'](\w+)["']/g },
  {
    kind: "env",
    pattern: new RegExp(
      String.raw`\bos\.(?:environ\.(?:get|setdefault|pop)|getenv)\(\s*["'](${ENV_NAME})["']`,
      "g",
    ),
  },
  {
    kind: "env",
    pattern: new RegExp(String.raw`\bos\.environ\[\s*["'](${ENV_NAME})["']\s*\]`, "g"),
  },
  {
    kind: "env",
    pattern: new RegExp(String.raw`\b(?:process\.env|import\.meta\.env)\.(${ENV_NAME})\b`, "g"),
  },
  {
    kind: "env",
    pattern: new RegExp(
      String.raw`\b(?:process\.env|import\.meta\.env)\[\s*["'](${ENV_NAME})["']\s*\]`,
      "g",
    ),
  },
  { kind: "command", pattern: /@\w+(?:\.\w+)*\.command\(\s*(?:name\s*=\s*)?["']([\w:-]+)["']/g },
  { kind: "command", pattern: /\badd_parser\(\s*["']([\w:-]+)["']/g },
];

/** Code aliases added per feature; the LLM's 3-8 synonyms come first. */
export const MAX_CODE_ALIASES = 10;
const MIN_IDENTIFIER_LENGTH = 2;

/** Variables nearly every service reads: they name the platform, not a feature. */
const UBIQUITOUS_ENV = new Set([
  "NODE_ENV",
  "PORT",
  "HOST",
  "DEBUG",
  "ENV",
  "PATH",
  "HOME",
  "PWD",
  "USER",
  "TZ",
  "LANG",
  "CI",
  "PYTHONPATH",
  "LOG_LEVEL",
]);

/**
 * Receivers of `.get("/path")` that call out to a server rather than declare a route: HTTP client
 * libraries and the clients and sessions built from them (`apiClient`, `authSession`).
 */
const HTTP_CLIENTS = new Set([
  "requests",
  "httpx",
  "axios",
  "http",
  "https",
  "client",
  "session",
  "request",
  "superagent",
  "got",
  "ky",
  "supertest",
  "fetch",
]);

/** True when the call `receiver.method(` that starts `matched` is on an HTTP client. */
function isClientCall(matched: string): boolean {
  const callee = matched.slice(0, matched.indexOf("("));
  const receiver = callee.slice(0, callee.lastIndexOf(".")).split(".").pop()?.toLowerCase() ?? "";
  return HTTP_CLIENTS.has(receiver) || receiver.endsWith("client") || receiver.endsWith("session");
}

/**
 * tests/, __tests__/, fixtures/ and __fixtures__/ directories, *.test.* and *.spec.* files,
 * test_*.py, *_test.py, tests.py and conftest.py.
 */
export function isTestFile(path: string): boolean {
  const segments = path.split("/");
  const name = segments.pop() ?? "";
  return (
    segments.some((s) => ["tests", "__tests__", "fixtures", "__fixtures__"].includes(s)) ||
    name === "tests.py" ||
    name === "conftest.py" ||
    /\.(?:test|spec)\.[^.]+$/.test(name) ||
    /^test_.*\.py$/.test(name) ||
    /_test\.py$/.test(name)
  );
}

/** Core's aliasSlug, the slug the reader site routes an alias by: one slug is one route. */
const slugOf = aliasSlug;

/** True when `run` occurs in `tokens` as consecutive tokens. */
function isTokenRun(run: readonly string[], tokens: readonly string[]): boolean {
  for (let i = 0; i + run.length <= tokens.length; i++) {
    if (run.every((token, j) => tokens[i + j] === token)) return true;
  }
  return false;
}

/** A Greek -sis noun (analysis, crisis); a word of four letters or fewer is no stem to share. */
function isSisNoun(word: string): boolean {
  return word.length > 4 && word.endsWith("sis");
}

/**
 * A word in its plain English singular: ies → y, (s|x|z|ch|sh)es → -es, s → -s (not ss). A
 * Greek -sis noun and its -ses plural meet on the same stem (analysis and analyses → analys).
 */
function singularOf(word: string): string {
  if (isSisNoun(word)) return `${word.slice(0, -3)}s`;
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * True when a table name shares a word, singular or plural, with one of its feature's own
 * names. A shared models file declares every feature's tables, so a table that shares none
 * names some other subject and is no alias of the file's feature.
 */
function sharesOwnWord(identifier: string, own: readonly (readonly string[])[]): boolean {
  const words = new Set(own.flat().map(singularOf));
  return slugOf(identifier)
    .split("-")
    .some((token) => words.has(singularOf(token)));
}

/** The plain English plurals of a word: +s, +es, y → ies, and sis → ses. */
function pluralsOf(word: string): string[] {
  return [
    `${word}s`,
    `${word}es`,
    ...(/[^aeiou]y$/.test(word) ? [`${word.slice(0, -1)}ies`] : []),
    ...(isSisNoun(word) ? [`${word.slice(0, -2)}es`] : []),
  ];
}

/**
 * True when an identifier names another feature's subject (spec §7.3 aliases point at one page):
 * its slug is a run of whole tokens in that feature's id, title slug or an alias slug
 * ("deliverables" in deliverables-management, "agents" in ai-agents), or, for a one-word table
 * name, a plural of one of their tokens ("milestones" for milestone-tracking).
 */
function namesOtherSubject(
  identifier: string,
  table: boolean,
  others: readonly (readonly string[])[],
): boolean {
  const run = slugOf(identifier).split("-");
  return others.some(
    (tokens) =>
      isTokenRun(run, tokens) ||
      (table && run.length === 1 && tokens.some((t) => pluralsOf(t).includes(run[0] ?? ""))),
  );
}

/** The forms a name is compared in: lowercased and slugified (empty slugs left out). */
function keysOf(name: string): string[] {
  const slug = slugOf(name);
  return slug === "" ? [name.toLowerCase()] : [...new Set([name.toLowerCase(), slug])];
}

/** `/x?y=1#z` is the route `/x`; null for `/` and routes made only of parameters. */
function cleanRoute(raw: string): string | null {
  const route = raw.replace(/[?#].*$/s, "");
  const parameter = /^(?:\{[^}]*\}|:\w+|<[^>]*>)$/;
  return route.split("/").every((part) => part === "" || parameter.test(part)) ? null : route;
}

/** The identifier a match names, or null when it is not worth an alias. */
function cleanIdentifier(kind: IdentifierPattern["kind"], raw: string): string | null {
  if (kind === "route") return cleanRoute(raw);
  if (kind === "table") return raw.replace(/^["`[]|["`\]]$/g, "");
  if (kind === "env") return UBIQUITOUS_ENV.has(raw) ? null : raw;
  return raw;
}

/**
 * Code identifiers to add as aliases, per active feature: those found in its (non-test) member
 * files and in no other feature's, that collide with no feature's id or title and no other
 * feature's alias (compared lowercased and as site slugs), that name no other active feature's
 * subject (`namesOtherSubject`: a shared models file's tables), and, for a table name, that share
 * a word with the feature's own names (`sharesOwnWord`), most frequent first, at most
 * MAX_CODE_ALIASES. An identifier two features share names neither, so it is left out, which keeps
 * every alias pointing at one page. One that could not be a manifest alias (core's aliasProblem:
 * too long, or holding a control or bidi character) is skipped, never cut.
 *
 * A feature's own aliases do not count against it, but every other feature's do, code aliases
 * included, so on an amended manifest this can return a shorter list than the first run did (an
 * identifier that names another feature's new alias drops out). Adding it again changes nothing,
 * because aliases are only ever added.
 */
export function codeAliases(
  manifest: Manifest,
  sources: ReadonlyMap<string, string>,
): Record<string, string[]> {
  const fixed = new Set<string>();
  const aliasOwners = new Map<string, Set<string>>();
  for (const feature of manifest.features) {
    for (const name of [feature.id, feature.title]) for (const key of keysOf(name)) fixed.add(key);
    for (const alias of feature.aliases) {
      for (const key of keysOf(alias)) {
        aliasOwners.set(key, (aliasOwners.get(key) ?? new Set()).add(feature.id));
      }
    }
  }
  const active = new Set(
    manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id),
  );
  // Each active feature's id, title and alias slugs, as token lists.
  const subjects = new Map(
    manifest.features
      .filter((f) => active.has(f.id))
      .map((f) => [
        f.id,
        [f.id, f.title, ...f.aliases]
          .map(slugOf)
          .filter((slug) => slug !== "")
          .map((slug) => slug.split("-")),
      ]),
  );
  const tables = new Set<string>();
  // identifier -> feature -> occurrences; key -> features using any spelling of it.
  const counts = new Map<string, Map<string, number>>();
  const users = new Map<string, Set<string>>();
  for (const [member, { featureId }] of Object.entries(manifest.membership)) {
    if (!active.has(featureId)) continue;
    const parsed = parseMemberId(member);
    if (parsed === null || parsed.symbol !== null || isTestFile(parsed.path)) continue;
    const text = sources.get(parsed.path);
    if (text === undefined) continue;
    for (const { kind, pattern, receiverCall } of IDENTIFIER_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        if (receiverCall && isClientCall(match[0])) continue;
        const identifier = cleanIdentifier(kind, match[1] ?? "");
        if (identifier === null || identifier.length < MIN_IDENTIFIER_LENGTH) continue;
        if (aliasProblem(identifier) !== null || slugOf(identifier) === "") continue;
        if (kind === "table") tables.add(identifier);
        const perFeature = counts.get(identifier) ?? new Map<string, number>();
        perFeature.set(featureId, (perFeature.get(featureId) ?? 0) + 1);
        counts.set(identifier, perFeature);
        for (const key of keysOf(identifier)) {
          users.set(key, (users.get(key) ?? new Set()).add(featureId));
        }
      }
    }
  }
  const perFeature = new Map<string, { identifier: string; count: number }[]>();
  for (const [identifier, byFeature] of counts) {
    const [featureId] = [...byFeature.keys()];
    if (byFeature.size !== 1 || featureId === undefined) continue;
    const keys = keysOf(identifier);
    // Taken by an id, a title, or another feature's alias; or used by another feature.
    if (keys.some((key) => fixed.has(key))) continue;
    if (keys.some((key) => [...(aliasOwners.get(key) ?? [])].some((id) => id !== featureId))) {
      continue;
    }
    if (keys.some((key) => users.get(key)?.size !== 1)) continue;
    const others = [...subjects].flatMap(([id, names]) => (id === featureId ? [] : names));
    if (namesOtherSubject(identifier, tables.has(identifier), others)) continue;
    if (tables.has(identifier) && !sharesOwnWord(identifier, subjects.get(featureId) ?? [])) {
      continue;
    }
    const list = perFeature.get(featureId) ?? [];
    list.push({ identifier, count: byFeature.get(featureId) ?? 0 });
    perFeature.set(featureId, list);
  }
  const out: Record<string, string[]> = {};
  for (const [featureId, list] of [...perFeature].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Spellings that share a lowercase or slug form ("users", "USERS", "/users") are one name for
    // the reader: keep the most frequent.
    const seen = new Set<string>();
    out[featureId] = list
      .sort((a, b) => b.count - a.count || (a.identifier < b.identifier ? -1 : 1))
      .filter(({ identifier }) => {
        const keys = keysOf(identifier);
        if (keys.some((key) => seen.has(key))) return false;
        for (const key of keys) seen.add(key);
        return true;
      })
      .slice(0, MAX_CODE_ALIASES)
      .map(({ identifier }) => identifier);
  }
  return out;
}
