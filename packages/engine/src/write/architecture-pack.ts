import {
  ARCHITECTURE_TITLE_MAX_LENGTH,
  INVISIBLE_CHARACTERS,
  type Manifest,
  type Revision,
} from "@repowiki/core";
import type { RepoIndex } from "../index/index.ts";
import { estimateTokens } from "../manifest/index.ts";
import { sourceLines } from "../verify/index.ts";
import { type CrossFeatureEdge, edgeWeightLabel } from "./architecture-edges.ts";
import { CHARS_PER_TOKEN, clean, clip, numbered, signatureLines } from "./pack.ts";
import { languageName } from "./page.ts";
import { featureFiles } from "./prompt.ts";

export interface ArchitecturePackInput {
  /** The project's name (projectTitle). */
  title: string;
  manifest: Manifest;
  index: RepoIndex;
  /** Text of every readable file at the index's sha. */
  sources: ReadonlyMap<string, string>;
  /** The current page of every feature the article covers. */
  pages: readonly Revision[];
  /** crossFeatureEdges among those features. */
  edges: readonly CrossFeatureEdge[];
  /** Token budget for the whole pack (estimateTokens). */
  budgetTokens: number;
}

/** The Architecture call's user turn (spec §7.4). */
export interface ArchitecturePack {
  text: string;
  /** Estimated tokens of `text`: at most the budget, unless the layout alone exceeds it. */
  tokens: number;
  /** Ids of the features it covers, sorted: the pages an Architecture claim may name. */
  features: string[];
  /**
   * Path to the 1-based lines the pack showed: the numbered lines it printed (README, documents,
   * infrastructure outlines, entry-point signatures) and the edge sites it gave. An article claim
   * may cite only these.
   */
  shown: ReadonlyMap<string, ReadonlySet<number>>;
}

/** A pack line, or block, and the file lines it shows. */
interface Shown {
  text: string;
  shows: readonly { path: string; lines: readonly number[] }[];
}

/**
 * Over a feature page's 30,000: the pack is one call per build, covers every feature, and
 * carries the README and top-level docs.
 */
export const DEFAULT_ARCHITECTURE_BUDGET_TOKENS = 50_000;
/** The README's first lines shown, and each other document's. */
const MAX_README_LINES = 120;
const MAX_DOC_LINES = 60;
/** Other documents shown besides the README. */
const MAX_DOCS = 3;
const MAX_TITLE_SCAN_LINES = 200;
const MAX_LAYOUT_DIRECTORIES = 40;
const MAX_LANGUAGES = 8;
const MAX_FEATURE_DIRECTORIES = 3;
const MAX_OUTLINED_FILES = 8;
const MAX_LISTED_INFRA_FILES = 30;
const MAX_OUTLINE_LINES = 15;
const MAX_ENTRY_LINES = 20;
const MAX_LEAD_LENGTH = 1200;
/**
 * Room kept for the headings and "and N more" lines of the sections filled after the budget runs
 * out: five headings of at most 90 characters and five lines of at most 50, with slack.
 */
const SECTION_RESERVE = 800;

/**
 * Infrastructure and configuration files, indexed at file level (spec §4): Terraform and HCL,
 * Dockerfiles, Compose files, GitHub Actions workflows and Procfiles.
 */
export const INFRA_FILE =
  /^(?!(?:.*\/)?\.terraform\.lock\.hcl$)[\s\S]*(?:\.(?:tf|tfvars|hcl)$|(?:^|\/)(?:Dockerfile|Containerfile)(?:\.(?!md$)[^/.]+)?$|(?:^|\/)(?:docker-)?compose(?:\.[^/]*)?\.ya?ml$|^\.github\/workflows\/[^/]+\.ya?ml$|(?:^|\/)Procfile$)/;
/** A top-level line of a file: it starts in column 1 and is not a comment or a closing bracket. */
const OUTLINE_LINE = /^(?![\s#/*})\]]|<!--|--)\S/;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A top-level README, in any of the usual spellings. */
const README = /^readme(?:\.(?:md|markdown|rst|txt))?$/i;
/**
 * Top-level Markdown files and docs/*.md that are not a README, licence, changelog, contributing
 * guide, nor a list of the project's people, history or policies (authors, adopters, maintainers,
 * governance, support, history, changes, notice), nor an instruction file for a coding agent
 * (CLAUDE, AGENTS, GEMINI): those address a model, not a reader. The exclusions match the whole
 * file name, so `security-model.md` stays.
 */
const DOC =
  /^(?:docs\/)?(?!(?:readme|license|licence|changelog|contributing|code_of_conduct|security|claude|agents|gemini|authors|adopters|maintainers|governance|support|history|changes|notice)\.md$)[^/]+\.md$/i;
/** A docs/ file whose name says it describes the design. */
const DESIGN_DOC = /^docs\/[^/]*(?:architecture|overview|design|guide)[^/]*$/i;

/** A document's rank: docs/ design documents, then other docs/ files, then top-level files. */
const docRank = (path: string): number =>
  DESIGN_DOC.test(path) ? 0 : path.startsWith("docs/") ? 1 : 2;
const INVISIBLE = new RegExp(INVISIBLE_CHARACTERS.source, "gu");

/** The repository's README: a top-level README file, Markdown first, then by path. */
export function readmePath(sources: ReadonlyMap<string, string>): string | undefined {
  return [...sources.keys()]
    .filter((path) => README.test(path))
    .sort((a, b) => Number(!/\.md$/i.test(a)) - Number(!/\.md$/i.test(b)) || byText(a, b))[0];
}

/**
 * A heading or a repository name as a title: images and HTML tags (a `<` that starts with a letter
 * or `/`) dropped, links reduced to their words, Markdown emphasis and code marks removed (an
 * underscore only where it is not inside a word, so `my_repo` keeps it), whitespace collapsed
 * (before the invisible characters go, so a tab is a space), control and invisible characters
 * removed, and cut to ARCHITECTURE_TITLE_MAX_LENGTH code points.
 */
function titleText(text: string): string {
  const words = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/[*`]/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/g, " ")
    .replace(INVISIBLE, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return [...words].slice(0, ARCHITECTURE_TITLE_MAX_LENGTH).join("").trim();
}

/** A line without its `<!-- ... -->` comments; `open` says whether one is still open at its end. */
function outsideComments(line: string, open: boolean): { text: string; open: boolean } {
  let text = "";
  let rest = line;
  let inside = open;
  while (rest !== "") {
    if (inside) {
      const end = rest.indexOf("-->");
      if (end < 0) break;
      rest = rest.slice(end + 3);
      inside = false;
    } else {
      const start = rest.indexOf("<!--");
      if (start < 0) {
        text += rest;
        break;
      }
      text += rest.slice(0, start);
      rest = rest.slice(start + 4);
      inside = true;
    }
  }
  return { text, open: inside };
}

/** The README's first level-1 heading (`# Title`, or a line underlined with `===`), outside code. */
function firstHeading(text: string): string | undefined {
  const lines = sourceLines(text).slice(0, MAX_TITLE_SCAN_LINES);
  let fenced = false;
  let commented = false;
  for (const [i, raw] of lines.entries()) {
    const visible = outsideComments(raw, commented);
    const line = visible.text;
    commented = visible.open;
    if (/^\s{0,3}(?:```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const atx = /^\s{0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*\r?$/.exec(line);
    if (atx !== null) return atx[1];
    if (line.trim() !== "" && /^\s{0,3}=+[ \t]*\r?$/.test(lines[i + 1] ?? "")) return line;
  }
  return undefined;
}

/**
 * The project's name, the article's title (spec §7.4), never the model's: the README's first
 * level-1 heading as plain text, else the repository's name, each through titleText; "Project"
 * if both come out empty. Deterministic.
 */
export function projectTitle(repoName: string, sources: ReadonlyMap<string, string>): string {
  const path = readmePath(sources);
  const heading = path === undefined ? undefined : firstHeading(sources.get(path) ?? "");
  return titleText(heading ?? "") || titleText(repoName) || "Project";
}

/** Counts sorted by count, then name; "Python 12, TSX 3". */
function counted(counts: ReadonlyMap<string, number>, limit: number): string {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || byText(a, b))
    .slice(0, limit)
    .map(([name, n]) => `${clean(name)} ${n}`)
    .join(", ");
}

const bump = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1);

/** The directory part of a path ("" at the top). */
const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);

/**
 * Builds the Architecture call's pack (spec §7.4): the project's title; the repository's
 * top-level layout and languages; the README (its first 120 lines) and up to three other
 * documents (60 lines each, docs/ design documents first), numbered so a claim can cite them;
 * every covered feature with its file count, main directories and its page's lead; the
 * cross-feature edges, each with the lines that prove it; the top-level lines of
 * infrastructure files; and the signatures of each feature's first entry point. Sections are
 * filled in that order, item by item, while the pack fits `budgetTokens`; what does not fit is
 * counted in an "and N more" line. Every repository- or model-derived string goes through
 * `clean`. Deterministic.
 */
export function buildArchitecturePack(input: ArchitecturePackInput): ArchitecturePack {
  const { manifest, index, sources } = input;
  const pages = [...input.pages].sort((a, b) => byText(a.featureId, b.featureId));
  const titles = new Map(manifest.features.map((f) => [f.id, f.title]));
  const budgetChars = input.budgetTokens * CHARS_PER_TOKEN - SECTION_RESERVE;
  const tail = "Write the article.";
  const parts: string[] = [];
  let used = tail.length;
  const shown = new Map<string, Set<number>>();

  /**
   * Adds a section: each item that fits (one that does not is skipped, so a smaller one after it
   * can still fit), then "and N more" for the items left out plus `omitted`, the ones the caller
   * has already left out; "(none)" when there is nothing at all.
   */
  const section = (
    heading: string,
    items: readonly (string | Shown)[],
    more: (n: number) => string,
    omitted = 0,
  ) => {
    const lines = [heading];
    let length = 2 + heading.length;
    let kept = 0;
    for (const entry of items) {
      const item = typeof entry === "string" ? entry : entry.text;
      const rest = items.length - kept - 1 + omitted;
      const reserve = rest > 0 ? 1 + more(rest).length : 0;
      if (used + length + 1 + item.length + reserve > budgetChars) continue;
      lines.push(item);
      length += 1 + item.length;
      kept += 1;
      for (const { path, lines: numbers } of typeof entry === "string" ? [] : entry.shows) {
        const set = shown.get(path) ?? new Set<number>();
        for (const n of numbers) set.add(n);
        shown.set(path, set);
      }
    }
    if (items.length === 0 && omitted === 0) lines.push("(none)");
    else if (kept < items.length || omitted > 0) lines.push(more(items.length - kept + omitted));
    const text = lines.join("\n");
    used += 2 + text.length;
    parts.push(text);
  };

  const header = `# Project: ${clean(input.title)} (${pages.length} features with pages, ${index.files.length} files)`;
  used += header.length;
  parts.push(header);

  const directories = new Map<string, { files: number; languages: Map<string, number> }>();
  const languages = new Map<string, number>();
  for (const file of index.files) {
    const top = file.path.includes("/") ? `${file.path.slice(0, file.path.indexOf("/"))}/` : "";
    const entry = directories.get(top) ?? { files: 0, languages: new Map<string, number>() };
    entry.files += 1;
    const name = languageName(file.path, file.language);
    if (name !== undefined) {
      bump(entry.languages, name);
      bump(languages, name);
    }
    directories.set(top, entry);
  }
  const layout = [...directories]
    .sort(([a, x], [b, y]) => y.files - x.files || byText(a, b))
    .map(([dir, { files, languages: langs }]) => {
      const shown = langs.size === 0 ? "" : ` (${counted(langs, MAX_LANGUAGES)})`;
      return `- ${dir === "" ? "(top-level files)" : clean(dir)}: ${files} ${files === 1 ? "file" : "files"}${shown}`;
    });
  section(
    `## Repository layout\nLanguages: ${counted(languages, MAX_LANGUAGES) || "(none)"}`,
    layout.slice(0, MAX_LAYOUT_DIRECTORIES),
    (n) => `- and ${n + Math.max(0, layout.length - MAX_LAYOUT_DIRECTORIES)} more directories`,
  );

  const indexed = new Set(index.files.filter((f) => f.skipped === null).map((f) => f.path));
  const readme = readmePath(sources);
  const docs = [...sources.keys()]
    .filter((path) => path !== readme && DOC.test(path) && indexed.has(path))
    .sort((a, b) => docRank(a) - docRank(b) || byText(a, b));
  const documents = [
    ...(readme !== undefined && indexed.has(readme)
      ? [{ path: readme, max: MAX_README_LINES }]
      : []),
    ...docs.slice(0, MAX_DOCS).map((path) => ({ path, max: MAX_DOC_LINES })),
  ].map(({ path, max }) => {
    const lines = sourceLines(sources.get(path) ?? "");
    const shown = Math.min(lines.length, max);
    const numbers = Array.from({ length: shown }, (_, i) => i + 1);
    const width = String(shown).length;
    const range =
      shown === lines.length ? `${lines.length} lines` : `lines 1-${shown} of ${lines.length}`;
    return {
      text: `### ${clean(path)} (${range})\n${numbered(lines, numbers, width)}`,
      shows: [{ path, lines: numbers }],
    };
  });
  section(
    "## Project documents",
    documents,
    (n) => `- and ${n} more documents`,
    Math.max(0, docs.length - MAX_DOCS),
  );

  const features = pages.map((page) => {
    const files = featureFiles(manifest, page.featureId);
    const dirs = new Map<string, number>();
    for (const path of files) bump(dirs, directoryOf(path) || "(top level)");
    const lead = page.sections.find((s) => s.key === "lead")?.claims ?? [];
    return [
      `### ${clean(page.featureId)} (${clean(titles.get(page.featureId) ?? page.featureId)})`,
      `Files: ${files.length}${dirs.size === 0 ? "" : ` in ${counted(dirs, MAX_FEATURE_DIRECTORIES)}`}`,
      "Lead:",
      ...lead.map((claim) => `- ${clip(clean(claim.text), MAX_LEAD_LENGTH)}`),
    ].join("\n");
  });
  section("## Features", features, (n) => `- and ${n} more features not shown`);

  const edges = input.edges.map((edge) => {
    // Each site on its own line, in the form a claim cites it, so the edge is never copied.
    const sites = edge.sites.map((s) => `\n  - ${clean(s.path)}:${s.line} (${s.kind})`).join("");
    return {
      text: `- ${clean(edge.from)} -> ${clean(edge.to)}: ${edgeWeightLabel(edge)}${sites}`,
      shows: edge.sites.map((s) => ({ path: s.path, lines: [s.line] })),
    };
  });
  section(
    "## Cross-feature edges (heaviest first; from the feature that imports or calls)",
    edges,
    (n) => `- and ${n} lighter edges`,
  );

  const infra = index.files
    .filter((f) => f.skipped === null && INFRA_FILE.test(f.path) && sources.has(f.path))
    .map((f) => f.path)
    .sort(byText);
  const outlines = infra.slice(0, MAX_OUTLINED_FILES).flatMap((path): Shown[] => {
    const lines = sourceLines(sources.get(path) ?? "");
    const numbers = lines
      .map((line, i) => (OUTLINE_LINE.test(line) ? i + 1 : 0))
      .filter((n) => n > 0)
      .slice(0, MAX_OUTLINE_LINES);
    if (numbers.length === 0) return [];
    const width = String(lines.length).length;
    // Only the key of a line that sets a value: `db_password = "..."`, `ENV TOKEN=...`.
    const keys = lines.map((line) => {
      const equals = line.indexOf("=");
      return equals < 0 ? line : `${line.slice(0, equals).trimEnd()} = \u2026`;
    });
    return [
      {
        text: `### ${clean(path)} (${lines.length} lines; top-level lines)\n${numbered(keys, numbers, width)}`,
        shows: [{ path, lines: numbers }],
      },
    ];
  });
  const listed = infra.slice(MAX_OUTLINED_FILES, MAX_OUTLINED_FILES + MAX_LISTED_INFRA_FILES);
  const others = listed.length === 0 ? [] : [`Also: ${listed.map(clean).join(", ")}`];
  const unlisted = Math.max(0, infra.length - MAX_OUTLINED_FILES - MAX_LISTED_INFRA_FILES);
  section(
    "## Infrastructure and configuration files",
    [...outlines, ...others, ...(unlisted > 0 ? [`- and ${unlisted} more files`] : [])],
    (n) => `- and ${n} more not shown`,
  );

  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const entries = pages.flatMap((page): Shown[] => {
    const path = page.infobox.entryPoints[0];
    const file = path === undefined ? undefined : byPath.get(path);
    const text = path === undefined ? undefined : sources.get(path);
    if (path === undefined || file === undefined || text === undefined || file.skipped !== null)
      return [];
    const lines = sourceLines(text);
    const numbers = [
      ...new Set(file.symbols.flatMap((s) => signatureLines(lines, s, file.language))),
    ]
      .sort((a, b) => a - b)
      .slice(0, MAX_ENTRY_LINES);
    if (numbers.length === 0) return [];
    const width = String(lines.length).length;
    return [
      {
        text: `### ${clean(path)} (${clean(page.featureId)}; ${lines.length} lines; signatures only)\n${numbered(lines, numbers, width)}`,
        shows: [{ path, lines: numbers }],
      },
    ];
  });
  section("## Entry points", entries, (n) => `- and ${n} more entry points not shown`);

  const text = [...parts, tail].join("\n\n");
  return {
    text,
    tokens: estimateTokens(text),
    features: pages.map((p) => p.featureId),
    shown,
  };
}
