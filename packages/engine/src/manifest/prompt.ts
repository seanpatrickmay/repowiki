import type { ClusterSummary } from "../cluster/index.ts";

/** Instructions for the manifest call. Frozen text: it heads the prompt-cached prefix. */
export const MANIFEST_INSTRUCTIONS = `You are the editor of RepoWiki, a Wikipedia-style wiki that documents one git repository. Pages are scoped by feature, not by folder. Your job is to decide the wiki's feature pages.

You receive clusters of files. Each cluster was computed from the repository's import graph, from which files change together in commits, and weakly from directories. A cluster lists its size, languages, directories, its best-connected files, exported symbols, the packages it imports from outside the repository, and the clusters it is most connected to. You never see source code.

How to group clusters into features:
- A feature is a capability a reader would look up: "Signal ingestion", "GitHub integration", "Deployment infrastructure". It is not a folder name and not a layer such as "utils" or "models".
- Prefer focused pages: most clusters become a feature of their own. Merge clusters only when they implement the same capability, and keep them apart when they serve different purposes, even if they share a directory.
- Tests, fixtures, scripts, configuration, CI and documentation join the feature they serve. Make a separate feature (for example "Continuous integration" or "Developer tooling") only for a cluster that serves the repository as a whole.

Return two lists.

features: one entry per feature, with
- id: a permanent URL slug, lowercase kebab-case (a-z, 0-9, single hyphens), 2 to 4 words, at most 40 characters, unique, e.g. "signal-ingestion". Ids are never reused, so name the capability, not the current folder.
- title: a Wikipedia article title in sentence case, e.g. "Signal ingestion". Titles are unique.
- aliases: 3 to 8 other names a reader might search for: synonyms, abbreviations, and names taken from the code (module, class, route, table or command names). Do not repeat the title.

clusters: exactly one entry per cluster, in cluster id order, with
- cluster: the cluster id.
- feature: the id of the feature it belongs to.
- role: "core" when the cluster implements the feature, "supporting" when it holds tests, fixtures, configuration or documentation for it.

Every feature needs at least one cluster. Answer with the JSON object only.`;

/**
 * Rough token count, deliberately pessimistic: path-heavy digests measured 2.7 characters per
 * token on Haiku 4.5, so this assumes 2.5.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

/** Longest repository-controlled string put in the prompt, in code points, before the "…". */
const MAX_NAME_LENGTH = 200;
/** C0 and C1 controls (newline, tab and DEL included: Cc) and U+2028 / U+2029 (Zl, Zp). */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/**
 * A repository-controlled string (path, directory, symbol, package or repository name), safe to
 * put in the prompt. Git paths can hold newlines and any other text, so a path could otherwise
 * start a forged line or heading. Control characters become U+FFFD, one for one, and anything
 * past 200 code points is cut and marked with "…". Pure, so the prompt stays byte-identical.
 */
function plain(text: string): string {
  const chars = [...text.replace(CONTROL_CHARACTERS, "\uFFFD")];
  if (chars.length <= MAX_NAME_LENGTH) return chars.join("");
  return `${chars.slice(0, MAX_NAME_LENGTH).join("")}…`;
}

function renderCluster(summary: ClusterSummary): string {
  const more = summary.fileCount - summary.files.length;
  const lines = [
    `## ${summary.id}: ${summary.fileCount} files, ${summary.symbolCount} symbols (${summary.languages.join(", ")})`,
    `directories: ${summary.directories.map((d) => `${plain(d.dir)} (${d.files})`).join(", ")}`,
    `files: ${summary.files.map(plain).join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
  ];
  if (summary.symbols.length > 0) lines.push(`symbols: ${summary.symbols.map(plain).join(", ")}`);
  if (summary.externalImports.length > 0) {
    lines.push(`external imports: ${summary.externalImports.map(plain).join(", ")}`);
  }
  if (summary.neighbours.length > 0) {
    lines.push(
      `connected to: ${summary.neighbours.map((n) => `${n.id} (${n.weight})`).join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** The cached prefix: instructions, then every cluster. Deterministic for a given index. */
export function manifestSystemPrompt(
  repoName: string,
  sha: string,
  summaries: readonly ClusterSummary[],
): string {
  return [
    MANIFEST_INSTRUCTIONS,
    `# Repository ${plain(repoName)} at ${sha}: ${summaries.length} clusters`,
    ...summaries.map(renderCluster),
  ].join("\n\n");
}

export const MANIFEST_REQUEST = "Group these clusters into the wiki's feature pages.";

/** The retry turn: the rejected answer and why it was rejected (spec §6.3: retry once). */
export function retryMessages(rejected: string, problems: readonly string[]) {
  return [
    { role: "assistant" as const, content: rejected },
    {
      role: "user" as const,
      content: `That answer was rejected:\n${problems.map((p) => `- ${p}`).join("\n")}\nReturn the corrected JSON object.`,
    },
  ];
}
