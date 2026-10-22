import {
  CLAIM_TEXT_MAX_LENGTH,
  type Claim,
  type Infobox,
  IsoDateTime,
  type Manifest,
  type Revision,
  type Section,
  type SectionKey,
  type TokenUsage,
} from "@repowiki/core";
import {
  type CommitInfo,
  languageForPath,
  type RepoIndex,
  type SourceLanguage,
} from "../index/index.ts";
import {
  createPageLinker,
  isTestFile,
  linkTokensIn,
  linkViolations,
  seeAlsoFor,
  textLinkViolations,
  unlinkText,
} from "../link/index.ts";
import { type DraftDiagram, diagramProblems } from "../verify/index.ts";
import { renderDiagram } from "./diagram.ts";
import type { ContextPack } from "./pack.ts";
import { featureFiles } from "./prompt.ts";

/** Section order on a page (spec §5). */
export const SECTION_ORDER: readonly SectionKey[] = [
  "lead",
  "overview",
  "how-it-works",
  "data-flow",
  "results",
  "history",
  "known-limitations",
];

/** A claim that opens by naming its subject in bold: "**Signal ingestion** is …". */
const BOLD_OPENING = /^\*\*[^*]+\*\*/;

/**
 * Puts verified claims into page order and gives them the page's own ids (c1, c2, …, lead
 * first, the claim that names the subject in bold before the other lead claims), mapping lead
 * supports to the new ids. Lead supports resolve against body claim ids only, so a lead claim may
 * share an id with a body claim. A lead claim left supporting no surviving
 * body claim is dropped, and so is an empty section. Null when no lead or no body claim survives:
 * such a page is not stored (spec §6.3). `order` lists the section keys, "lead" among them; a
 * feature page's is SECTION_ORDER, the Architecture article's its own.
 */
export function orderedSections<
  K extends string,
  C extends { id: string; text: string; supports: string[] },
>(order: readonly K[], claims: ReadonlyMap<K, readonly C[]>): { key: K; claims: C[] }[] | null {
  const leadKey = order.find((k) => k === "lead");
  const bodyKeys = order.filter((k) => k !== "lead" && (claims.get(k) ?? []).length > 0);
  const bodyIds = new Set(bodyKeys.flatMap((k) => (claims.get(k) ?? []).map((c) => c.id)));
  const kept = (leadKey === undefined ? [] : (claims.get(leadKey) ?? []))
    .map((c) => ({ ...c, supports: [...new Set(c.supports.filter((s) => bodyIds.has(s)))] }))
    .filter((c) => c.supports.length > 0);
  // The claim that names the subject in bold opens the lead, whatever order the model gave.
  const defining = kept.findIndex((c) => BOLD_OPENING.test(c.text));
  const lead =
    defining <= 0 ? kept : [kept[defining] as C, ...kept.filter((_, i) => i !== defining)];
  if (leadKey === undefined || lead.length === 0 || bodyKeys.length === 0) return null;

  // Lead claims are numbered first, then the body claims in page order.
  let next = lead.length;
  const bodyNewIds = new Map<string, string>();
  const body = bodyKeys.map((key) => ({
    key,
    claims: (claims.get(key) ?? []).map((claim) => {
      next += 1;
      const id = `c${next}`;
      if (!bodyNewIds.has(claim.id)) bodyNewIds.set(claim.id, id);
      return { claim, id };
    }),
  }));
  const supportId = (id: string) => bodyNewIds.get(id) ?? id;
  return [
    {
      key: leadKey,
      claims: lead.map((c, i) => ({ ...c, id: `c${i + 1}`, supports: c.supports.map(supportId) })),
    },
    ...body.map(({ key, claims: entries }) => ({
      key,
      claims: entries.map(({ claim, id }) => ({
        ...claim,
        id,
        supports: claim.supports.map(supportId),
      })),
    })),
  ];
}

/**
 * History claims oldest first, by the earliest commit each cites (the model's order drifts). Claims
 * with the same date keep their order; one whose commits are not in `commits` goes last.
 */
export function oldestFirst(claims: readonly Claim[], commits: readonly CommitInfo[]): Claim[] {
  const when = new Map(commits.map((c) => [c.sha, Date.parse(c.date)]));
  const first = (claim: Claim): number =>
    Math.min(
      ...claim.citations.map((c) =>
        c.kind === "commit" ? (when.get(c.sha) ?? Infinity) : Infinity,
      ),
    );
  return claims
    .map((claim) => ({ claim, at: first(claim) }))
    .sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1))
    .map((c) => c.claim);
}

/** A feature page's sections in SECTION_ORDER (see orderedSections). */
export function pageSections(claims: ReadonlyMap<SectionKey, readonly Claim[]>): Section[] | null {
  return orderedSections(SECTION_ORDER, claims);
}

const LANGUAGE_NAMES: Record<SourceLanguage, string> = {
  python: "Python",
  typescript: "TypeScript",
  tsx: "TSX",
  rust: "Rust",
};
/** Names for file-level languages, by extension; other extensions are left out. */
const EXTENSION_NAMES: Record<string, string> = {
  ".tf": "Terraform",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".md": "Markdown",
  ".json": "JSON",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".sql": "SQL",
  ".sh": "Shell",
  ".css": "CSS",
  ".html": "HTML",
  ".toml": "TOML",
};
const MAX_LANGUAGES = 5;

/** The language a file is counted under: its parser's, else its extension's; undefined if neither. */
export function languageName(
  path: string,
  language: SourceLanguage | null | undefined,
): string | undefined {
  const extension = /\.[^./]+$/.exec(path)?.[0] ?? "";
  return language ? LANGUAGE_NAMES[language] : EXTENSION_NAMES[extension];
}

/** The language an infobox names for a file, from its path alone. */
export function pathLanguageName(path: string): string | undefined {
  return languageName(path, languageForPath(path));
}
const MAX_ENTRY_POINTS = 3;

/** Orders ISO 8601 date-times by instant, then by code-unit order of the text for equal instants. */
function byInstant(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The infobox, computed from the index and git (spec §7.3): member files and their lines, the
 * languages with the most files, the entry points, and the dates of the first and last commit
 * that touched a member file. Entry points are member code files no other member imports that
 * import a member themselves; failing that, the heaviest code file. Test files are never entry
 * points, and their imports do not count. Commit dates keep the
 * committer's own offset (`Infobox` takes an ISO 8601 date-time with an offset or `Z`) and are
 * compared as instants; history is newest first by commit date, which clock skew can break.
 * With no usable commit, both dates are `commitDate`, which must be an ISO 8601 date-time.
 */
export function computeInfobox(
  featureId: string,
  manifest: Manifest,
  index: RepoIndex,
  commits: readonly CommitInfo[],
  commitDate: string,
): Infobox {
  if (!IsoDateTime.safeParse(commitDate).success) {
    throw new Error("commitDate must be an ISO 8601 date-time");
  }
  const files = featureFiles(manifest, featureId);
  const mine = new Set(files);
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const languages = new Map<string, number>();
  let loc = 0;
  for (const path of files) {
    const file = byPath.get(path);
    loc += file?.loc ?? 0;
    const name = languageName(path, file?.language);
    if (name !== undefined) languages.set(name, (languages.get(name) ?? 0) + 1);
  }
  // Tests import the code and nothing imports them, so they are left out of the rule entirely.
  const code = files.filter((path) => byPath.get(path)?.language && !isTestFile(path));
  const isCode = new Set(code);
  const internal = index.imports.filter(
    (e) => e.from !== e.to && isCode.has(e.from) && isCode.has(e.to),
  );
  const imported = new Set(internal.map((e) => e.to));
  const importing = new Set(internal.map((e) => e.from));
  const roots = code.filter((path) => importing.has(path) && !imported.has(path));
  const entryPoints = (roots.length > 0 ? roots : code.slice(0, 1)).slice(0, MAX_ENTRY_POINTS);
  const dates = commits
    .filter((c) => c.files.some((path) => mine.has(path)) && IsoDateTime.safeParse(c.date).success)
    .map((c) => c.date)
    .sort(byInstant);
  return {
    files: files.length,
    loc,
    languages: [...languages]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
      .slice(0, MAX_LANGUAGES)
      .map(([name]) => name),
    entryPoints,
    firstCommitDate: dates[0] ?? commitDate,
    lastCommitDate: dates.at(-1) ?? commitDate,
  };
}

/**
 * Links one page's claims, in the order they are given (spec §7.3): the page linker's output if
 * it is short enough and every link in it names an active page or a Wikipedia title that checked
 * out; otherwise its links as plain words (`unlinkText`), first from the linker's output, then,
 * if the feature titles made even that too long, from the claim as verified, which fit. `pageId`
 * is the page's own feature id, never linked; "" for a page that is no feature's.
 */
export function createClaimLinker(
  manifest: Manifest,
  pageId: string,
  wikipedia: ReadonlyMap<string, string | null>,
): <C extends Claim>(claim: C) => C {
  const link = createPageLinker(manifest, pageId, wikipedia);
  const titles = new Map(manifest.features.map((f) => [f.id, f.title]));
  const checked = new Set(
    [...wikipedia.values()].flatMap((title) => (title === null ? [] : [title.trim()])),
  );
  const linksOk = (text: string): boolean =>
    textLinkViolations(text, manifest).length === 0 &&
    linkTokensIn(text).every(
      (t) => !t.target.startsWith("wp:") || checked.has(t.target.slice(3).trim()),
    );
  return <C extends Claim>(claim: C): C => {
    const linked = link(claim.text);
    if (linked.length <= CLAIM_TEXT_MAX_LENGTH && linksOk(linked))
      return { ...claim, text: linked };
    const plain = unlinkText(linked, titles);
    return {
      ...claim,
      text: plain.length <= CLAIM_TEXT_MAX_LENGTH ? plain : unlinkText(claim.text),
    };
  };
}

/** Everything a page's revision is made from once its claims are verified. */
export interface RevisionParts {
  featureId: string;
  index: RepoIndex;
  manifest: Manifest;
  commitDate: string;
  generatedAt: string;
  model: string;
  tokens: TokenUsage;
  /** Verified claims with unique draft ids, in any order. */
  claims: readonly { key: SectionKey; claim: Claim }[];
  diagram: DraftDiagram;
  pack: ContextPack;
  /** Every commit reachable from the page's commit: History claims carried from a merged page cite theirs. */
  history: readonly CommitInfo[];
  neighbours: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Normalized Wikipedia title → canonical title, or null for plain text. */
  wikipedia: ReadonlyMap<string, string | null>;
}

const NO_PAGE = "no lead or no body claim survived verification";

export type Assembled =
  | { revision: Revision; failure: null; diagramProblems: string[] }
  | { revision: null; failure: string };

/**
 * A build revision for one page: sections ordered and renumbered first, then the survivors'
 * claims linked in page order (spec §7.3) so a claim that is dropped never uses up a concept's
 * first mention, the infobox, See also, and the diagram, which is dropped (and its problems
 * returned) if the verifier refuses it.
 *
 * Each linked claim is checked again: if it holds a link to anything but an active page, a
 * Wikipedia link that did not check out, or is longer than `CLAIM_TEXT_MAX_LENGTH`, its links
 * become plain words (`unlinkText`), first from the linker's output, then, if the feature titles
 * made even that too long, from the claim as verified, which fit. The claim as written is never
 * stored, because it may hold link tokens the linker neutralised. A claim blank after linking is
 * dropped. A page whose links name no page even so is not written (`failure`), never an exception.
 */
export function assembleRevision(parts: RevisionParts): Assembled {
  const { featureId, index, manifest } = parts;
  const linkClaim = createClaimLinker(manifest, featureId, parts.wikipedia);

  const bySection = new Map<SectionKey, Claim[]>();
  for (const key of SECTION_ORDER) {
    const mine = parts.claims.filter((v) => v.key === key).map((v) => v.claim);
    bySection.set(key, key === "history" ? oldestFirst(mine, parts.history) : mine);
  }
  const ordered = pageSections(bySection);
  if (ordered === null) return { revision: null, failure: NO_PAGE };
  let dropped = false;
  const linkedSections = ordered.map((section) => ({
    key: section.key,
    claims: section.claims.flatMap((claim) => {
      const linked = linkClaim(claim);
      if (linked.text.trim() !== "") return [linked];
      dropped = true;
      return [];
    }),
  }));
  // Dropping a claim can leave a lead claim without support, or a page without a body.
  const sections = dropped
    ? pageSections(new Map(linkedSections.map((s) => [s.key, s.claims])))
    : linkedSections;
  if (sections === null) return { revision: null, failure: NO_PAGE };

  let diagram = renderDiagram(parts.diagram, parts.pack.candidates);
  const refused = diagram === null ? [] : diagramProblems(diagram);
  if (refused.length > 0) diagram = null;
  const revision: Revision = {
    id: `${featureId}-${index.sha.slice(0, 12)}`,
    featureId,
    sha: index.sha,
    commitDate: parts.commitDate,
    generatedAt: parts.generatedAt,
    parentId: null,
    reason: "build",
    pr: null,
    model: parts.model,
    tokens: parts.tokens,
    infobox: computeInfobox(featureId, manifest, index, parts.pack.commits, parts.commitDate),
    diagram,
    seeAlso: seeAlsoFor(featureId, parts.neighbours, manifest),
    sections,
  };
  // The checks above make this unreachable; it stays as the last word on spec §8.
  const violations = linkViolations(revision, manifest);
  if (violations.length > 0) {
    return { revision: null, failure: `links to nowhere: ${violations.join("; ")}` };
  }
  return { revision, failure: null, diagramProblems: refused };
}
