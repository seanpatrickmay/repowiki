import type { Citation, Revision } from "@repowiki/core";
import {
  ABOUT_PAGE_ID,
  type AsOf,
  asOfBanner,
  asOfLabel,
  count,
  cut,
  defineTool,
  historyBegins,
  listedPage,
  MAX_TOOL_RESULT_CHARS,
  oneLine,
  parseAsOf,
  readPage,
  searchResults,
  type Tool,
  type ToolSet,
  toolSet,
  type WikiView,
} from "@repowiki/query";
import { z } from "zod";
import { codeTools } from "./code-tools.ts";
import type { ClaimMark, HeadStatus } from "./head-status.ts";
import type { ServedWiki } from "./served.ts";

/** Each tool's human title, shown by MCP clients beside its name. */
export const TOOL_TITLES: Readonly<Record<string, string>> = {
  search: "Search the wiki",
  list_pages: "List the wiki's pages",
  read_page: "Read a wiki page",
  pages_for_file: "Pages for a file",
  cited_code: "Show cited code",
  page_changes: "What changed on a page",
};

const sha7 = (sha: string) => sha.slice(0, 7);
const PAGE_ID = z.string().trim().min(1).max(200);
const AS_OF = z.string().trim().min(1).max(40);
const AS_OF_HELP =
  "as_of (optional) reads the wiki as it was on a date YYYY-MM-DD or at a commit (7-40 hex)";

/** Every code path a revision's claims cite. */
const citedPaths = (revision: {
  sections: readonly { claims: readonly { citations: readonly Citation[] }[] }[];
}) =>
  new Set(
    revision.sections.flatMap((s) =>
      s.claims.flatMap((c) => c.citations.flatMap((x) => (x.kind === "code" ? [x.path] : []))),
    ),
  );

/** Whether a current page cites a file changed since the wiki's commit. */
function citesChanged(served: ServedWiki, status: HeadStatus, id: string): boolean {
  if (!status.known || status.changedFiles.size === 0) return false;
  const page = id === ABOUT_PAGE_ID ? served.view.article : served.view.pages.get(id);
  if (page === undefined) return false;
  for (const path of citedPaths(page)) if (status.changedFiles.has(path)) return true;
  return false;
}

/** The status header list_pages opens with (spec v2 #5 §6.2). */
function statusLines(served: ServedWiki, status: HeadStatus): string[] {
  const { wiki } = served;
  const lines = [
    `Wiki of ${oneLine(wiki.repo)}: commit ${sha7(wiki.head)}${served.headDate === null ? "" : ` (${served.headDate})`}, exported ${wiki.exportedAt.slice(0, 10)}.`,
  ];
  if (served.reloadProblem !== null) lines.push(oneLine(served.reloadProblem));
  const against = served.pinned ? "the pinned compare commit" : "the repository's HEAD";
  if (!status.known || status.compare === null) {
    lines.push(
      `Freshness is unknown: the repository does not hold the wiki's commit ${sha7(wiki.head)}${status.compare === null ? " or has no HEAD" : ""}; pages are served as written.`,
    );
    return lines;
  }
  if (status.compare === wiki.head) {
    lines.push(
      `Compared with ${against} (commit ${sha7(status.compare)}): the wiki's own commit; nothing has changed.`,
    );
  } else {
    const pages = [...served.view.pages.keys(), ABOUT_PAGE_ID].filter((id) =>
      citesChanged(served, status, id),
    ).length;
    lines.push(
      `Compared with ${against} (commit ${sha7(status.compare)}): ${count(status.ahead, "commit")} ahead of the wiki's commit and ${status.behind} behind; ${count(status.changedFiles.size, "file")} changed, cited by ${count(pages, "page")}.`,
    );
    if (status.ahead > 0) {
      lines.push(
        "The wiki is behind: read_page marks each claim whose cited lines changed. `pnpm wiki:update` on this repository refreshes the wiki (it prints its cost first).",
      );
    }
  }
  lines.push("Uncommitted changes are not compared, and the marks cover cited lines only.");
  return lines;
}

/** list_pages: the status header, then the About article and every page, fitted to the cap. */
function listPages(served: ServedWiki): string {
  const status = served.freshness.status();
  const { view } = served;
  const header = statusLines(served, status);
  const entries: { id: string; title: string; summary: string; tags: string[] }[] = [];
  if (view.article !== undefined) {
    entries.push({
      id: ABOUT_PAGE_ID,
      title: view.article.title,
      summary: view.summary(ABOUT_PAGE_ID),
      tags: citesChanged(served, status, ABOUT_PAGE_ID) ? ["cites changed files"] : [],
    });
  }
  const others: string[] = [];
  for (const feature of view.wiki.manifest.features) {
    const kind = feature.status.kind;
    if ((kind === "active" || kind === "retired") && view.pages.has(feature.id)) {
      const tags = [
        ...(kind === "retired" ? ["retired"] : []),
        ...(citesChanged(served, status, feature.id) ? ["cites changed files"] : []),
      ];
      entries.push({
        id: feature.id,
        title: feature.title,
        summary: view.summary(feature.id),
        tags,
      });
    } else if (feature.status.kind === "redirect") {
      others.push(
        `- ${feature.id} (${oneLine(feature.title)}): redirects to ${view.finalTarget(feature.id)}`,
      );
    } else if (feature.status.kind === "disambiguation") {
      others.push(
        `- ${feature.id} (${oneLine(feature.title)}): may refer to ${feature.status.to.join(", ")}`,
      );
    }
  }
  const render = (summaryLength: number) =>
    [
      ...header,
      "",
      view.article === undefined
        ? "Pages:"
        : `Pages (${ABOUT_PAGE_ID} is the project's own article):`,
      ...entries.map((e) => {
        const line = listedPage(
          e.id,
          e.title,
          summaryLength === 0 ? "" : cut(e.summary, summaryLength),
        );
        return `${line}${e.tags.length === 0 ? "" : ` [${e.tags.join("; ")}]`}`;
      }),
      ...(others.length === 0 ? [] : ["", "Redirects and disambiguations:", ...others]),
      "",
      "Read one with read_page(id), or search for words.",
      "",
    ].join("\n");
  for (const length of [200, 120, 60, 0]) {
    const text = render(length);
    if ([...text].length <= MAX_TOOL_RESULT_CHARS) return text;
  }
  return render(0);
}

/** The view an as_of argument asks for, or the current one. */
function viewFor(served: ServedWiki, asOfText: string | undefined) {
  if (asOfText === undefined) return { view: served.view, index: served.index, asOf: null };
  const asOf = parseAsOf(asOfText, served.resolveCommit);
  return { ...served.at(asOf), asOf };
}

/** A claim note for read_page: changed claims only (moved ones still hold). */
function noteOf(mark: ClaimMark | undefined): string | null {
  if (mark?.kind !== "changed") return null;
  return `(changed since the wiki's commit: ${mark.reasons.map((r) => oneLine(r)).join("; ")})`;
}

/** The freshness line read_page puts under a current page's revision line, or null. */
function freshnessLine(
  served: ServedWiki,
  marks: ReadonlyMap<string, ClaimMark>,
  claims: number,
): string | null {
  const status = served.freshness.status();
  if (!status.known || status.compare === null || status.compare === served.wiki.head) return null;
  const changed = [...marks.values()].filter((m) => m.kind === "changed").length;
  const moved = [...marks.values()].filter((m) => m.kind === "moved").length;
  const movedText = (more: string) =>
    `${moved} ${more}${moved === 1 ? "claim cites" : "claims cite"} lines that moved but still hold`;
  if (changed === 0) {
    return `No claim's cited lines changed since the wiki's commit (compared with commit ${sha7(status.compare)})${moved > 0 ? `; ${movedText("")}` : ""}.`;
  }
  return `${changed} of ${claims} claims cite lines changed since the wiki's commit (compared with commit ${sha7(status.compare)}); they are marked.${moved > 0 ? ` ${movedText("more ")}.` : ""}`;
}

/** The revision (or About article) a resolved id reads, in a view. */
function revisionOf(
  view: WikiView,
  id: string,
): { id: string; revision: Revision | null; about: boolean } {
  const resolved = view.resolve(id);
  if (resolved.kind === "about") return { id: ABOUT_PAGE_ID, revision: null, about: true };
  if (resolved.kind === "choices") return { id, revision: null, about: false };
  return {
    id: resolved.featureId,
    revision: view.pages.get(resolved.featureId) ?? null,
    about: false,
  };
}

/** read_page on the current wiki: v1's page plus the freshness line and claim marks. */
function readCurrent(served: ServedWiki, id: string): string {
  const { view } = served;
  const target = revisionOf(view, id);
  const sections = target.about ? view.article?.sections : target.revision?.sections;
  const revisionId = target.about ? view.article?.id : target.revision?.id;
  if (sections === undefined || revisionId === undefined) return readPage(view, id);
  const marks = served.freshness.marks(revisionId, sections);
  const claims = sections.reduce((n, s) => n + s.claims.length, 0);
  return readPage(view, id, MAX_TOOL_RESULT_CHARS, {
    freshness: freshnessLine(served, marks, claims),
    claimNote: (claimId) => noteOf(marks.get(claimId)),
  });
}

/** read_page as of a point: the page then, with a banner naming the revision and its lineage. */
function readAsOf(served: ServedWiki, id: string, asOf: AsOf): string {
  const then = served.at(asOf).view;
  let target: ReturnType<typeof revisionOf>;
  try {
    target = revisionOf(then, id);
  } catch (error) {
    // Not in the wiki then: say where its history begins, when it has one now.
    const now = revisionOf(served.view, id);
    const first = now.about ? served.wiki.architecture[0] : served.wiki.history[now.id]?.[0];
    if (first !== undefined) return historyBegins(now.about ? ABOUT_PAGE_ID : now.id, first);
    throw error;
  }
  if (target.about && then.article !== undefined) {
    const all = served.wiki.architecture;
    const k = all.indexOf(then.article) + 1;
    const current = all.at(-1);
    return readPage(then, id, MAX_TOOL_RESULT_CHARS, {
      banner: [
        `This is the About article as of ${asOfLabel(asOf)}: revision ${k} of ${all.length}. The current revision is ${current?.commitDate.slice(0, 10) ?? "unknown"} (commit ${sha7(current?.sha ?? "")}).`,
      ],
    });
  }
  if (target.revision === null) return readPage(then, id);
  return readPage(then, id, MAX_TOOL_RESULT_CHARS, {
    banner: asOfBanner(served.wiki, target.id, target.revision, asOf, served.isAncestor),
  });
}

/** The first three of the six tools (spec v2 #5 §6.2): list_pages, search and read_page. */
export function wikiTools(served: () => ServedWiki): Tool[] {
  return [
    defineTool(
      "search",
      `Search the wiki of this repository: one page per feature of the code, each claim citing the code lines or commits it rests on. Returns up to 8 pages, best match first, with each page's id, title and first lead sentence. ${AS_OF_HELP}.`,
      z.strictObject({ query: z.string().trim().min(1).max(200), as_of: AS_OF.optional() }),
      ({ query, as_of }) => {
        const s = served();
        const { view, index, asOf } = viewFor(s, as_of);
        if (asOf === null) {
          const status = s.freshness.status();
          return searchResults(view, index, query, {
            note: (id) => (citesChanged(s, status, id) ? "(cites changed files)" : null),
          });
        }
        return `Search of the wiki as of ${asOfLabel(asOf)}:\n${searchResults(view, index, query, {
          hint: `Read one with read_page(id, as_of: ${JSON.stringify(as_of)}).`,
        })}`;
      },
    ),
    defineTool(
      "list_pages",
      "List the wiki: its commit and how far the repository has moved since, then the project's About article and every page with its first lead sentence, then redirects. Use it when search finds nothing.",
      z.strictObject({}),
      () => listPages(served()),
    ),
    defineTool(
      "read_page",
      `Read one wiki page by its id, as search or list_pages names it (${ABOUT_PAGE_ID} is the project's own article): its claims, each with numbered references to the code lines and commits it rests on, its See also list and its dated history. Claims whose cited lines changed since the wiki's commit are marked. ${AS_OF_HELP}.`,
      z.strictObject({ id: PAGE_ID, as_of: AS_OF.optional() }),
      ({ id, as_of }) => {
        const s = served();
        if (as_of === undefined) return readCurrent(s, id);
        return readAsOf(s, id, parseAsOf(as_of, s.resolveCommit));
      },
    ),
  ];
}

/** The six MCP tools over the wiki `served()` returns at each call. */
export function createAgentTools(served: () => ServedWiki): ToolSet {
  return toolSet([...wikiTools(served), ...codeTools(served)]);
}
