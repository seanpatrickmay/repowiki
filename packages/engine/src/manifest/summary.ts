import { type Manifest, parseMemberId } from "@repowiki/core";
import type { LedgerTotals } from "@repowiki/llm";

const TOP_FILES = 5;
const count = (n: number): string => n.toLocaleString("en-US");

/**
 * Titles and aliases come from the model. Collapse line breaks and escape backslashes and pipes so
 * a value cannot break a table row or start a new Markdown block.
 */
const inline = (text: string): string =>
  text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").replace(/[\\|]/g, "\\$&");

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
    `# Manifest: ${repoName} at ${manifest.sha.slice(0, 7)}`,
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
      ...top.map((f) => `- \`${f.path}\` (${f.weight})`),
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
