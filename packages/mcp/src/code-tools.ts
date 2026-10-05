import { posix } from "node:path";
import {
  ArchitectureSectionKey,
  type CodeCitation,
  parseMemberId,
  SectionKey,
} from "@repowiki/core";
import {
  ABOUT_PAGE_ID,
  type ChangedRevision,
  count,
  cut,
  defineTool,
  historyBegins,
  oneLine,
  parseAsOf,
  reference,
  referenceList,
  renderChanges,
  revisionAt,
  revisionEntry,
  type Tool,
  ToolError,
  type WikiView,
} from "@repowiki/query";
import { z } from "zod";
import {
  citedCode,
  commitDetails,
  DEFAULT_CONTEXT_LINES,
  fileAt,
  MAX_CONTEXT_LINES,
} from "./code.ts";
import type { ServedWiki } from "./served.ts";

const sha7 = (sha: string) => sha.slice(0, 7);
const PAGE_ID = z.string().trim().min(1).max(200);
const AS_OF = z.string().trim().min(1).max(40);
const shownPath = (path: string) => cut(oneLine(path), 200);

/**
 * A path an agent gave, as a repository path, by string rules alone (it never reaches git or the
 * file system): an absolute path must lie under the repository's top level; "./" and repeated or
 * trailing slashes go; ".." is refused.
 */
export function repoRelative(repo: string, raw: string): string {
  let path = raw.trim().replace(/\\/g, "/");
  const top = repo.replace(/\\/g, "/").replace(/\/+$/, "");
  if (path.startsWith("/")) {
    if (!path.startsWith(`${top}/`)) {
      throw new ToolError(
        `${JSON.stringify(cut(oneLine(raw), 200))} is outside the repository; give a path relative to its root`,
      );
    }
    path = path.slice(top.length + 1);
  }
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new ToolError("paths are relative to the repository root and cannot use ..");
  }
  if (segments.length === 0) throw new ToolError("give the path of a file in the repository");
  return posix.join(...segments);
}

/** The sections a resolved page id reads, current or as of a point. */
function pageSections(view: WikiView, id: string) {
  const resolved = view.resolve(id);
  if (resolved.kind === "choices") {
    throw new ToolError(
      `${JSON.stringify(cut(oneLine(id), 80))} may refer to several pages: ${resolved.targets.join(", ")}; name one`,
    );
  }
  if (resolved.kind === "about") {
    const article = view.article;
    if (article === undefined) throw new ToolError("the wiki has no About article");
    return { id: ABOUT_PAGE_ID, sections: article.sections };
  }
  const page = view.pages.get(resolved.featureId);
  if (page === undefined) throw new ToolError(`no page ${JSON.stringify(resolved.featureId)}`);
  return { id: resolved.featureId, sections: page.sections };
}

/** pages_for_file: the feature that owns a file, the pages citing it, and whether it changed. */
function pagesForFile(served: ServedWiki, raw: string): string {
  const path = repoRelative(served.repo, raw);
  const { view, wiki } = served;
  const owners = new Map<string, { weight: number; symbols: string[]; whole: boolean }>();
  for (const [member, { featureId, weight }] of Object.entries(wiki.manifest.membership)) {
    const parsed = parseMemberId(member);
    if (parsed === null || parsed.path !== path) continue;
    const owner = owners.get(featureId) ?? { weight: 0, symbols: [], whole: false };
    owner.weight = Math.max(owner.weight, weight);
    if (parsed.symbol === null) owner.whole = true;
    else owner.symbols.push(parsed.symbol);
    owners.set(featureId, owner);
  }
  const lines = [`${shownPath(path)}:`];
  for (const [featureId, owner] of [...owners].sort((a, b) => b[1].weight - a[1].weight)) {
    const what = owner.whole
      ? "the whole file"
      : `${count(owner.symbols.length, "symbol")}: ${owner.symbols
          .slice(0, 5)
          .map((s) => oneLine(s))
          .join(", ")}${owner.symbols.length > 5 ? ", …" : ""}`;
    lines.push(
      `- Owned by ${featureId} (${oneLine(view.title(featureId))}), weight ${owner.weight}, ${what}.`,
    );
  }
  const citing: string[] = [];
  const pages: [string, Parameters<typeof referenceList>[0]][] = [...view.pages].map(
    ([id, page]) => [id, page.sections],
  );
  if (view.article !== undefined) pages.push([ABOUT_PAGE_ID, view.article.sections]);
  for (const [id, sections] of pages) {
    const refs = referenceList(sections)
      .map((c, i) => (c.kind === "code" && c.path === path ? `[${i + 1}]` : null))
      .filter((r) => r !== null);
    if (refs.length > 0) {
      const title = id === ABOUT_PAGE_ID ? (view.article?.title ?? "About") : view.title(id);
      citing.push(`- Cited by ${id} (${oneLine(title)}): references ${refs.join(", ")}.`);
    }
  }
  lines.push(...citing);
  const status = served.freshness.status();
  if (!status.known || status.compare === null) {
    const why = status.problem === undefined ? "" : `: ${oneLine(status.problem)}`;
    lines.push(`Whether it changed since the wiki's commit is unknown${why}.`);
  } else if (status.addedFiles.has(path) && owners.size === 0) {
    lines.push(
      `Added after the wiki's commit (compared with commit ${sha7(status.compare)}): not in the wiki yet; read it in the working tree.`,
    );
  } else if (status.changedFiles.has(path)) {
    lines.push(
      `Changed since the wiki's commit (compared with commit ${sha7(status.compare)}): read it in the working tree; read_page marks the claims whose cited lines changed.`,
    );
  } else {
    lines.push(`Unchanged since the wiki's commit (compared with commit ${sha7(status.compare)}).`);
  }
  if (owners.size === 0 && citing.length === 0 && !status.addedFiles.has(path)) {
    lines.push(
      "No page owns or cites this file: the wiki does not describe it. Try search with words from it.",
    );
  } else if (citing.length > 0) {
    lines.push("Read a reference's code with cited_code(id, ref).");
  }
  return `${lines.join("\n")}\n`;
}

/** Where a code citation's lines are at the compare commit, as one line. */
function nowLine(served: ServedWiki, citation: CodeCitation): string {
  const now = served.freshness.citationNow(citation);
  const at = `At commit ${sha7(served.freshness.status().compare ?? "")}`;
  switch (now.kind) {
    case "unchanged":
      return `${at}: unchanged at ${shownPath(now.path)}:${now.startLine}-${now.endLine}.`;
    case "moved":
      return `${at}: unchanged, moved to ${shownPath(now.path)}:${now.startLine}-${now.endLine}.`;
    case "changed":
      return `${at}: the cited lines changed; read ${shownPath(now.path)} in the working tree.`;
    case "deleted":
      return `${at}: ${shownPath(citation.path)} was deleted.`;
    case "unknown":
      return `Where these lines are now is unknown: ${oneLine(now.why)}.`;
  }
}

/**
 * read_page's answer for a point before a page's history: where it begins, or null when the page
 * has no history (or `id` names several pages).
 */
function historyStart(served: ServedWiki, id: string): string | null {
  const now = served.view.resolve(id);
  if (now.kind === "choices") return null;
  const about = now.kind === "about";
  const first = about ? served.wiki.architecture[0] : served.wiki.history[now.featureId]?.[0];
  return first === undefined ? null : historyBegins(about ? ABOUT_PAGE_ID : now.featureId, first);
}

/** cited_code: reference `ref` of a page, numbered as read_page numbers it with the same as_of. */
function citedCodeTool(
  served: ServedWiki,
  input: { id: string; ref: number; as_of?: string | undefined; context?: number | undefined },
): string {
  const view =
    input.as_of === undefined
      ? served.view
      : served.at(parseAsOf(input.as_of, served.resolveCommit)).view;
  let page: ReturnType<typeof pageSections>;
  try {
    page = pageSections(view, input.id);
  } catch (error) {
    // Not in the wiki then: read_page's answer, where its history begins.
    const begins = input.as_of === undefined ? null : historyStart(served, input.id);
    if (begins === null) throw error;
    return begins;
  }
  const refs = referenceList(page.sections);
  const citation = refs[input.ref - 1];
  if (citation === undefined) {
    throw new ToolError(
      refs.length === 0
        ? `${page.id} has no references`
        : `${page.id} has ${count(refs.length, "reference")}; ref is 1 to ${refs.length}`,
    );
  }
  const heading = `Reference [${input.ref}] of ${page.id}: ${reference(citation)}`;
  if (citation.kind === "commit") return `${heading}\n${commitDetails(served.repo, citation)}`;
  const file = fileAt(served.repo, citation.sha, citation.path);
  const code = citedCode(served.repo, citation, input.context ?? DEFAULT_CONTEXT_LINES, file);
  // A file its own commit lacks has no "now" to speak of: the citation itself is wrong.
  if ("missing" in file && file.missing === "no-file") return `${heading}\n${code}`;
  return `${heading}\n${code}${nowLine(served, citation)}\n`;
}

/** page_changes: the claim diff between the revisions current at two points of one page. */
function pageChanges(
  served: ServedWiki,
  input: { id: string; from?: string | undefined; to?: string | undefined },
): string {
  const { view, wiki } = served;
  const resolved = view.resolve(input.id);
  if (resolved.kind === "choices") {
    throw new ToolError(
      `${JSON.stringify(cut(oneLine(input.id), 80))} may refer to several pages: ${resolved.targets.join(", ")}; name one`,
    );
  }
  const about = resolved.kind === "about";
  const id = about ? ABOUT_PAGE_ID : resolved.featureId;
  const history: readonly ChangedRevision[] = about ? wiki.architecture : (wiki.history[id] ?? []);
  const title = about ? (view.article?.title ?? "About") : view.title(id);
  const at = (text: string | undefined, fallback: number) => {
    if (text === undefined) return fallback;
    const found = revisionAt(history, parseAsOf(text, served.resolveCommit), served.isAncestor);
    const first = history[0];
    if (found === null) {
      throw new ToolError(
        `the wiki's history of ${id} begins on ${first?.commitDate.slice(0, 10) ?? "an unknown date"} (commit ${sha7(first?.sha ?? "")}), after ${oneLine(text)}`,
      );
    }
    return history.indexOf(found);
  };
  const toIndex = at(input.to, history.length - 1);
  const fromIndex = at(input.from, Math.max(0, toIndex - 1));
  const [a, b] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
  const before = history[a];
  const after = history[b];
  if (before === undefined || after === undefined) throw new ToolError(`${id} has no revisions`);
  const heading = `Changes to ${oneLine(title)} (page id: ${id})`;
  if (history.length === 1) {
    return `${heading}: the page has one revision, ${revisionEntry(after)}; nothing to compare it with.\n`;
  }
  const keys = about ? ArchitectureSectionKey.options : SectionKey.options;
  return renderChanges(
    view,
    heading,
    { revision: before, n: a + 1 },
    { revision: after, n: b + 1 },
    history.slice(a, b + 1),
    keys,
  );
}

/** The last three of the six tools (spec v2 #5 §6.2): pages_for_file, cited_code, page_changes. */
export function codeTools(served: () => ServedWiki): Tool[] {
  return [
    defineTool(
      "pages_for_file",
      "Find the wiki pages for a file you are working on: the feature that owns it, the pages whose claims cite it (with their reference numbers), and whether it changed since the wiki's commit. path is relative to the repository root, or absolute inside it.",
      z.strictObject({ path: z.string().trim().min(1).max(500) }),
      ({ path }) => pagesForFile(served(), path),
    ),
    defineTool(
      "cited_code",
      `Show the code a page's reference cites: the cited lines at the commit they were cited at, numbered, with context lines around (default ${DEFAULT_CONTEXT_LINES}, at most ${MAX_CONTEXT_LINES}), then where those lines are now; or a cited commit's date, subject and changed files. ref is the reference number read_page shows (with the same as_of).`,
      z.strictObject({
        id: PAGE_ID,
        ref: z.int().min(1).max(100_000),
        as_of: AS_OF.optional(),
        context: z.int().min(0).max(MAX_CONTEXT_LINES).optional(),
      }),
      (input) => citedCodeTool(served(), input),
    ),
    defineTool(
      "page_changes",
      "Show what changed on a page between two points, claim by claim (- removed, + added, ~ changed with [-old-]{+new+} words), then the revisions in between. from and to are dates YYYY-MM-DD or commits (7-40 hex); by default, the revision before the current one and the current one.",
      z.strictObject({ id: PAGE_ID, from: AS_OF.optional(), to: AS_OF.optional() }),
      (input) => pageChanges(served(), input),
    ),
  ];
}
