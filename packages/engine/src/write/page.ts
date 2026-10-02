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
import type { CommitInfo, RepoIndex, SourceLanguage } from "../index/index.ts";
import { createPageLinker, linkViolations, seeAlsoFor, unlinkText } from "../link/index.ts";
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
  "history",
  "known-limitations",
];

/**
 * Puts verified claims into page order and gives them the page's own ids (c1, c2, …, lead
 * first), mapping lead supports to the new ids. Lead supports resolve against body claim ids only,
 * so a lead claim may share an id with a body claim. A lead claim left supporting no surviving
 * body claim is dropped, and so is an empty section. Null when no lead or no body claim survives:
 * such a page is not stored (spec §6.3).
 */
export function pageSections(claims: ReadonlyMap<SectionKey, readonly Claim[]>): Section[] | null {
  const bodyKeys = SECTION_ORDER.filter((k) => k !== "lead" && (claims.get(k) ?? []).length > 0);
  const bodyIds = new Set(bodyKeys.flatMap((k) => (claims.get(k) ?? []).map((c) => c.id)));
  const lead = (claims.get("lead") ?? [])
    .map((c) => ({ ...c, supports: [...new Set(c.supports.filter((s) => bodyIds.has(s)))] }))
    .filter((c) => c.supports.length > 0);
  if (lead.length === 0 || bodyKeys.length === 0) return null;

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
      key: "lead",
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

const LANGUAGE_NAMES: Record<SourceLanguage, string> = {
  python: "Python",
  typescript: "TypeScript",
  tsx: "TSX",
};
/** Names for file-level languages, by extension; other extensions are left out. */
const EXTENSION_NAMES: Record<string, string> = {
  ".tf": "Terraform",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
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
const MAX_ENTRY_POINTS = 3;

/** Orders ISO 8601 date-times by instant, then by code-unit order of the text for equal instants. */
function byInstant(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The infobox, computed from the index and git (spec §7.3): member files and their lines, the
 * languages with the most files, the entry points, and the dates of the first and last commit
 * that touched a member file. Entry points are member code files no other member imports that
 * import a member themselves; failing that, the heaviest code file. Commit dates keep the
 * committer's own offset (`Infobox` takes an ISO 8601 date-time with an offset or `Z`) and are
 * compared as instants; history is newest first by commit date, which clock skew can break.
 * With no usable commit, both dates are `commitDate`.
 */
export function computeInfobox(
  featureId: string,
  manifest: Manifest,
  index: RepoIndex,
  commits: readonly CommitInfo[],
  commitDate: string,
): Infobox {
  const files = featureFiles(manifest, featureId);
  const mine = new Set(files);
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const languages = new Map<string, number>();
  let loc = 0;
  for (const path of files) {
    const file = byPath.get(path);
    loc += file?.loc ?? 0;
    const extension = /\.[^./]+$/.exec(path)?.[0] ?? "";
    const name = file?.language ? LANGUAGE_NAMES[file.language] : EXTENSION_NAMES[extension];
    if (name !== undefined) languages.set(name, (languages.get(name) ?? 0) + 1);
  }
  const internal = index.imports.filter(
    (e) => e.from !== e.to && mine.has(e.from) && mine.has(e.to),
  );
  const imported = new Set(internal.map((e) => e.to));
  const importing = new Set(internal.map((e) => e.from));
  const code = files.filter((path) => byPath.get(path)?.language);
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
  neighbours: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Normalized Wikipedia title → canonical title, or null for plain text. */
  wikipedia: ReadonlyMap<string, string | null>;
}

export type Assembled =
  | { revision: Revision; failure: null; diagramProblems: string[] }
  | { revision: null; failure: string };

/**
 * A build revision for one page: claims linked in page order (spec §7.3), sections ordered and
 * renumbered, the infobox, See also, and the diagram, which is dropped (and its problems
 * returned) if the verifier refuses it. Throws if a link still points nowhere: the linker never
 * writes one, so that is a bug, not a page to skip.
 *
 * Linking can lengthen a claim past `CLAIM_TEXT_MAX_LENGTH` (a link writes the id and the words).
 * Such a claim keeps no link: its links become their plain words, first from the linker's output,
 * then, if the feature titles made even that too long, from the claim as verified, which fit. The
 * claim as written is never stored, because it may hold link tokens the linker neutralised.
 */
export function assembleRevision(parts: RevisionParts): Assembled {
  const { featureId, index, manifest } = parts;
  const link = createPageLinker(manifest, featureId, parts.wikipedia);
  const titles = new Map(manifest.features.map((f) => [f.id, f.title]));
  const linkClaim = (claim: Claim): Claim => {
    const linked = link(claim.text);
    if (linked.length <= CLAIM_TEXT_MAX_LENGTH) return { ...claim, text: linked };
    const plain = unlinkText(linked, titles);
    return {
      ...claim,
      text: plain.length <= CLAIM_TEXT_MAX_LENGTH ? plain : unlinkText(claim.text),
    };
  };
  const bySection = new Map<SectionKey, Claim[]>();
  for (const key of SECTION_ORDER) {
    bySection.set(
      key,
      parts.claims.filter((v) => v.key === key).map((v) => linkClaim(v.claim)),
    );
  }
  const sections = pageSections(bySection);
  if (sections === null) {
    return { revision: null, failure: "no lead or no body claim survived verification" };
  }
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
  const violations = linkViolations(revision, manifest);
  if (violations.length > 0) {
    throw new Error(`the linker wrote links to nowhere: ${violations.join("; ")}`);
  }
  return { revision, failure: null, diagramProblems: refused };
}
