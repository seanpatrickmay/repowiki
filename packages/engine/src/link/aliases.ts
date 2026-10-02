import { aliasProblem, FEATURE_ID_MAX_LENGTH, type Manifest, parseMemberId } from "@repowiki/core";

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

/**
 * The URL slug the reader site gives an alias (a copy of aliasSlug in packages/site/src/model.ts,
 * which the engine cannot import): two names with one slug are one page's route.
 */
function slugOf(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FEATURE_ID_MAX_LENGTH)
    .replace(/-+$/, "");
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
 * feature's alias (compared lowercased and as site slugs), most frequent first, at most
 * MAX_CODE_ALIASES. An identifier two features share names neither, so it is left out, which keeps
 * every alias pointing at one page. One that could not be a manifest alias (core's aliasProblem:
 * too long, or holding a control or bidi character) is skipped, never cut.
 *
 * A feature's own aliases do not count against it, so running this on an amended manifest returns
 * the same list again and adding it again changes nothing.
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
