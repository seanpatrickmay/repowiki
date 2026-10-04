import { type Manifest, parseMemberId } from "@repowiki/core";
import type { LedgerTotals } from "@repowiki/llm";

const TOP_FILES = 5;
const count = (n: number): string => n.toLocaleString("en-US");

/** Line breaks would start a new Markdown block, so every model- or repo-supplied value loses them. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ");

/** For titles and aliases, which the model supplies: also escape what breaks a table cell. */
const inline = (text: string): string => oneLine(text).replace(/[\\|]/g, "\\$&");

/**
 * A code span that survives any content (CommonMark): the fence is one backtick longer than the
 * longest run inside, and content that starts or ends with a backtick (or with spaces on both
 * sides, which a parser would trim) is padded with one space.
 */
function codeSpan(text: string): string {
  const flat = oneLine(text);
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = /^`|`$/.test(flat) || /^ .* $/.test(flat) ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** The manifest as Markdown for the owner's review, with the LLM cost of producing it. */
export function renderManifestSummary(
  repoName: string,
  manifest: Manifest,
  totals: LedgerTotals | null,
): string {
  const files = new Map<string, { path: string; weight: number }[]>();
  const symbols = new Map<string, number>();
  for (const [id, { featureId, weight }] of Object.entries(manifest.membership)) {
    const parsed = parseMemberId(id);
    if (parsed === null) continue;
    if (parsed.symbol === null)
      files.set(featureId, [...(files.get(featureId) ?? []), { path: parsed.path, weight }]);
    else symbols.set(featureId, (symbols.get(featureId) ?? 0) + 1);
  }
  const fileTotal = [...files.values()].reduce((n, list) => n + list.length, 0);
  const symbolTotal = [...symbols.values()].reduce((n, k) => n + k, 0);

  const lines = [
    `# Manifest: ${oneLine(repoName)} at ${manifest.sha.slice(0, 7)}`,
    "",
    `${manifest.features.length} features, ${count(fileTotal)} files, ${count(symbolTotal)} symbols.`,
    "",
    "| Feature | Title | Files | Symbols |",
    "|---|---|---:|---:|",
    ...manifest.features.map(
      (f) =>
        `| \`${f.id}\` | ${inline(f.title)} | ${files.get(f.id)?.length ?? 0} | ${symbols.get(f.id) ?? 0} |`,
    ),
  ];
  for (const feature of manifest.features) {
    const top = [...(files.get(feature.id) ?? [])]
      .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : 1))
      .slice(0, TOP_FILES);
    lines.push(
      "",
      `## ${inline(feature.title)} (\`${feature.id}\`)`,
      "",
      `Aliases: ${feature.aliases.map(inline).join(", ")}`,
      "",
      ...top.map((f) => `- ${codeSpan(f.path)} (${f.weight})`),
    );
  }
  if (totals !== null) {
    const t = totals.tokens;
    lines.push(
      "",
      "## LLM cost",
      "",
      `${totals.calls} calls (${totals.batchCalls} batched): ${count(t.in)} input, ${count(t.out)} output, ${count(t.cacheRead)} cache-read, ${count(t.cacheWrite)} cache-write tokens.`,
      "",
      `Cost: $${totals.usd.toFixed(4)}${totals.unpricedCalls > 0 ? ` (plus ${totals.unpricedCalls} calls to unpriced models)` : ""}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
