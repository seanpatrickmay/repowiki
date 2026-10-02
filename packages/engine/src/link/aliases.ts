import { aliasProblem, type Manifest, parseMemberId } from "@repowiki/core";

/** A pattern for one kind of code identifier; group 1 is the identifier. */
interface IdentifierPattern {
  kind: "route" | "table" | "env" | "command";
  pattern: RegExp;
}

/**
 * Code identifiers that name a feature to a reader (spec §7.3, F01): HTTP routes (FastAPI or Flask
 * decorators, Express calls), table names (SQLAlchemy, SQL, Alembic), environment variables
 * (Python, Node, Vite) and CLI commands (Click or Typer decorators, argparse subcommands).
 *
 * These run over repository text an attacker may write, so each must stay linear-time: no
 * quantifier is nested inside another, and no two adjacent quantifiers can match the same text.
 */
export const IDENTIFIER_PATTERNS: readonly IdentifierPattern[] = [
  {
    kind: "route",
    pattern: /@\w+(?:\.\w+)*\.(?:get|post|put|patch|delete)\(\s*["'](\/[^"'\s]+)["']/g,
  },
  {
    kind: "route",
    pattern: /\b(?:app|router)\.(?:get|post|put|patch|delete)\(\s*["'`](\/[^"'`\s]+)["'`]/g,
  },
  { kind: "table", pattern: /__tablename__\s*=\s*["'](\w+)["']/g },
  { kind: "table", pattern: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi },
  { kind: "table", pattern: /\bop\.create_table\(\s*["'](\w+)["']/g },
  { kind: "env", pattern: /\bos\.(?:environ\.get|getenv)\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g },
  { kind: "env", pattern: /\bos\.environ\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g },
  { kind: "env", pattern: /\b(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]{2,})\b/g },
  { kind: "command", pattern: /@\w+(?:\.\w+)*\.command\(\s*(?:name\s*=\s*)?["']([\w:-]+)["']/g },
  { kind: "command", pattern: /\badd_parser\(\s*["']([\w:-]+)["']/g },
];

/** Code aliases added per feature; the LLM's 3-8 synonyms come first. */
export const MAX_CODE_ALIASES = 10;
const MIN_IDENTIFIER_LENGTH = 2;

/**
 * Code identifiers to add as aliases, per active feature: those found in its member files and in
 * no other feature's, that collide with no feature's id, title or alias (case-insensitive), most
 * frequent first, at most MAX_CODE_ALIASES. An identifier two features share names neither, so
 * it is left out, which keeps every alias pointing at one page. An identifier that could not be
 * a manifest alias (too long, or holding a control or bidi character) is skipped, never cut.
 */
export function codeAliases(
  manifest: Manifest,
  sources: ReadonlyMap<string, string>,
): Record<string, string[]> {
  const taken = new Set<string>();
  for (const feature of manifest.features) {
    for (const name of [feature.id, feature.title, ...feature.aliases])
      taken.add(name.toLowerCase());
  }
  const found = new Map<string, { features: Set<string>; counts: Map<string, number> }>();
  // Who uses a name in any letter case: "Users" in one feature and "users" in another still clash.
  const owners = new Map<string, Set<string>>();
  for (const [member, { featureId }] of Object.entries(manifest.membership)) {
    const parsed = parseMemberId(member);
    const text = parsed?.symbol === null ? sources.get(parsed.path) : undefined;
    if (text === undefined) continue;
    for (const { pattern } of IDENTIFIER_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const identifier = match[1] ?? "";
        if (identifier.length < MIN_IDENTIFIER_LENGTH || aliasProblem(identifier) !== null)
          continue;
        const entry = found.get(identifier) ?? { features: new Set(), counts: new Map() };
        entry.features.add(featureId);
        entry.counts.set(featureId, (entry.counts.get(featureId) ?? 0) + 1);
        found.set(identifier, entry);
        const key = identifier.toLowerCase();
        owners.set(key, (owners.get(key) ?? new Set()).add(featureId));
      }
    }
  }
  const active = new Set(
    manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id),
  );
  const perFeature = new Map<string, { identifier: string; count: number }[]>();
  for (const [identifier, { features, counts }] of found) {
    const [featureId] = [...features];
    if (features.size !== 1 || featureId === undefined || !active.has(featureId)) continue;
    if (taken.has(identifier.toLowerCase())) continue;
    if ((owners.get(identifier.toLowerCase())?.size ?? 0) !== 1) continue;
    const list = perFeature.get(featureId) ?? [];
    list.push({ identifier, count: counts.get(featureId) ?? 0 });
    perFeature.set(featureId, list);
  }
  const out: Record<string, string[]> = {};
  for (const [featureId, list] of [...perFeature].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Case-insensitive duplicates ("users" and "USERS") keep the most frequent spelling.
    const seen = new Set<string>();
    out[featureId] = list
      .sort((a, b) => b.count - a.count || (a.identifier < b.identifier ? -1 : 1))
      .filter(({ identifier }) => {
        const key = identifier.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_CODE_ALIASES)
      .map(({ identifier }) => identifier);
  }
  return out;
}
