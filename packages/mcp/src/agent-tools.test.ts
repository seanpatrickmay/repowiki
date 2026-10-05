import { WikiExport } from "@repowiki/core";
import { leadClaim, makeFeature, makeRevision } from "@repowiki/core/test-fixtures";
import { createWikiTools, MAX_TOOL_RESULT_CHARS } from "@repowiki/query";
import {
  type HistoryWiki,
  historyWiki,
  type SampleWiki,
  sampleWiki,
} from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentTools } from "./agent-tools.ts";
import { serveWiki } from "./served.ts";

let h: HistoryWiki;
let sample: SampleWiki;
beforeAll(() => {
  h = historyWiki();
  sample = sampleWiki();
});
afterAll(() => {
  h.repo.remove();
  sample.repo.remove();
});

/** The tools over the history fixture, comparing with HEAD (one commit past the wiki's head). */
const tools = (pinned: string | null = null, wiki = h.wiki, repo = h.repo.dir) => {
  const served = serveWiki(wiki, { repo, pinned });
  return createAgentTools(() => served);
};
const text = (set: ReturnType<typeof tools>, name: string, input: unknown) => {
  const out = set.run(name, input) as { text: string; isError: boolean };
  return out.isError ? `ERROR ${out.text}` : out.text;
};

describe("list_pages", () => {
  it("opens with the wiki's commit and how far HEAD has moved, then lists every page", () => {
    expect(text(tools(), "list_pages", {})).toBe(
      [
        "Wiki of sample: commit 3d751d3 (2026-01-04), exported 2026-10-04.",
        `Compared with the repository's HEAD (commit ${h.commits.after.slice(0, 7)}): 1 commit ahead of the wiki's commit and 0 behind; 2 files changed, cited by 2 pages.`,
        "The wiki is behind: read_page marks each claim whose cited lines changed. `pnpm wiki:update` on this repository refreshes the wiki (it prints its cost first).",
        "Uncommitted changes are not compared, and the marks cover cited lines only.",
        "",
        "Pages (special:about is the project's own article):",
        "- special:about: sample. **sample** turns chunks of text into signals, and signals into deliverables. [cites changed files]",
        "- signals: Signal ingestion. **Signal ingestion** turns chunks of text into signals and keeps them in memory. [cites changed files]",
        "- deliverables: Deliverables. **Deliverables** are the records sample builds from Signal ingestion [page: signals].",
        "",
        "Read one with read_page(id), or search for words.",
        "",
      ].join("\n"),
    );
  });

  it("says nothing changed at a pinned compare commit equal to the wiki's", () => {
    const lines = text(tools(h.sha), "list_pages", {}).split("\n");
    expect(lines[1]).toBe(
      "Compared with the pinned compare commit (commit 3d751d3): the wiki's own commit; nothing has changed.",
    );
    expect(lines.some((l) => l.includes("wiki:update"))).toBe(false);
  });

  it("serves the wiki with freshness unknown when the repository lacks the wiki's commit", () => {
    const listed = text(tools(null, sample.wiki, h.repo.dir), "list_pages", {});
    expect(listed.split("\n")[1]).toBe(
      "Freshness is unknown: the repository does not hold the wiki's commit 6767d44; pages are served as written.",
    );
    expect(listed).toContain("- signals: Signal ingestion. ");
  });

  it("lists redirects and disambiguations, and shortens summaries until the list fits the cap", () => {
    const n = 150;
    const ids = Array.from({ length: n }, (_, i) => `feature-${String(i).padStart(3, "0")}`);
    const pages = ids.map((id) =>
      makeRevision({
        id: `${id}-1`,
        featureId: id,
        sha: h.sha,
        seeAlso: [],
        sections: [
          {
            key: "lead",
            claims: [
              leadClaim({
                text: `**${id}** ${"does a great many things. ".repeat(12)}`,
                supports: ["c-1"],
              }),
            ],
          },
          ...makeRevision().sections.slice(1),
        ],
      }),
    );
    const big = WikiExport.parse({
      ...h.wiki,
      manifest: {
        ...h.wiki.manifest,
        membership: {},
        features: [
          ...ids.map((id) => makeFeature({ id, title: `Title of ${id}`, aliases: [] })),
          makeFeature({
            id: "old",
            title: "Old",
            aliases: [],
            status: { kind: "redirect", to: "feature-000" },
            lineage: [
              { kind: "create", sha: h.sha },
              { kind: "merge", sha: h.sha, into: "feature-000" },
            ],
          }),
        ],
      },
      pages,
      history: Object.fromEntries(pages.map((p) => [p.featureId, [p]])),
      architecture: [],
    });
    const listed = text(tools(h.sha, big), "list_pages", {});
    expect([...listed].length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    for (const id of ids) expect(listed).toContain(`\n- ${id}: Title of ${id}`);
    expect(listed).toContain("\nPages:\n");
    expect(listed).toContain(
      "\nRedirects and disambiguations:\n- old (Old): redirects to feature-000\n",
    );
    expect(listed.endsWith("Read one with read_page(id), or search for words.\n")).toBe(true);
  });
});

describe("search", () => {
  it("lists v1's search results, noting pages that cite changed files", () => {
    expect(text(tools(), "search", { query: "save_signal" })).toBe(
      [
        "- signals: Signal ingestion. **Signal ingestion** turns chunks of text into signals and keeps them in memory. (cites changed files)",
        "- special:about: sample. **sample** turns chunks of text into signals, and signals into deliverables. (cites changed files)",
        "- deliverables: Deliverables. **Deliverables** are the records sample builds from Signal ingestion [page: signals].",
        "Read one with read_page(id).",
        "",
      ].join("\n"),
    );
    const pinned = tools(h.sha);
    expect(text(pinned, "search", { query: "deliverables" })).toBe(
      text(createWikiTools(h.wiki), "search", { query: "deliverables" }),
    );
  });

  it("searches the wiki as it was, saying so", () => {
    const set = tools();
    expect(text(set, "search", { query: "export", as_of: "2026-01-03" })).toBe(
      "Search of the wiki as of 2026-01-03:\nNo page matches; try other words.\n",
    );
    expect(text(set, "search", { query: "export", as_of: "2026-01-04" })).toBe(
      [
        "Search of the wiki as of 2026-01-04:",
        "- deliverables: Deliverables. **Deliverables** are the records sample builds from Signal ingestion [page: signals].",
        'Read one with read_page(id, as_of: "2026-01-04").',
        "",
      ].join("\n"),
    );
    expect(text(set, "search", { query: "x", as_of: "yesterday" })).toBe(
      "ERROR as_of must be a date YYYY-MM-DD or a commit sha of 7 to 40 hex characters",
    );
  });
});

describe("read_page", () => {
  it("marks the claims whose cited lines changed since the wiki's commit, under a freshness line", () => {
    const page = text(tools(), "read_page", { id: "signals" });
    const after = h.commits.after.slice(0, 7);
    expect(page.split("\n").slice(0, 3)).toEqual([
      "Signal ingestion (page id: signals)",
      "Status: active. This revision: commit 3d751d3, 2026-01-04.",
      `2 of 5 claims cite lines changed since the wiki's commit (compared with commit ${after}); they are marked. 2 more claims cite lines that moved but still hold.`,
    ]);
    expect(page).toContain(
      "\n- **Signal ingestion** turns chunks of text into signals and keeps them in memory. (changed since the wiki's commit: it summarizes s-3, which changed)\n",
    );
    expect(page).toContain(
      "\n- `save_signal` appends each signal to the in-memory `SIGNALS` list. [2] (changed since the wiki's commit: src/signals/store.py:6-8: the cited lines changed)\n",
    );
    expect(page).toContain(
      "\n- `ingest_chunk` makes one signal per non-blank sentence of a chunk. [1]\n",
    );
    expect(text(tools(), "read_page", { id: "special:about" }).split("\n")[2]).toBe(
      `No claim's cited lines changed since the wiki's commit (compared with commit ${after}); 1 claim cites lines that moved but still hold.`,
    );
  });

  it("is v1's page exactly when nothing changed", () => {
    const v1 = createWikiTools(h.wiki);
    for (const id of ["signals", "deliverables", "special:about"]) {
      expect(text(tools(h.sha), "read_page", { id })).toBe(text(v1, "read_page", { id }));
    }
  });

  it("reads a page as of a date or a commit, with its revision and lineage", () => {
    const set = tools();
    const old = text(set, "read_page", { id: "signals", as_of: "2026-01-02" });
    expect(old.split("\n").slice(0, 4)).toEqual([
      "Signal ingestion (page id: signals)",
      "This is the page as of 2026-01-02: revision 1 of 3, commit d08c5a4, 2026-01-02. The current revision is 2026-01-04 (commit 3d751d3).",
      "Lineage up to then: created at commit d08c5a4.",
      "Status: active. This revision: commit d08c5a4, 2026-01-02.",
    ]);
    expect(old).toContain("- Ingestion stops after `MAX_SIGNALS` (50) signals. [2]");
    expect(old).not.toContain("changed since");
    const renamed = text(set, "read_page", { id: "deliverables", as_of: "594d833" });
    expect(renamed.split("\n").slice(0, 3)).toEqual([
      "Deliverable records (page id: deliverables)",
      "This is the page as of commit 594d833: revision 1 of 2, commit 594d833, 2026-01-03. The current revision is 2026-01-04 (commit 3d751d3).",
      "Lineage up to then: created at commit 594d833. 1 later lineage event is on the current page.",
    ]);
    expect(renamed).not.toContain("Also called");
  });

  it("says where a page's history begins, and reads the About article as of a date", () => {
    const set = tools();
    expect(text(set, "read_page", { id: "deliverables", as_of: "2026-01-02" })).toBe(
      "The wiki's history of deliverables begins on 2026-01-03 (commit 594d833).\n",
    );
    expect(text(set, "read_page", { id: "special:about", as_of: "2026-01-03" })).toContain(
      "This is the About article as of 2026-01-03: revision 1 of 2. The current revision is 2026-01-04 (commit 3d751d3).\nThis revision: commit d08c5a4, 2026-01-02.\n\nLead\n- **sample** turns chunks of text into signals.\n",
    );
    expect(text(set, "read_page", { id: "kafka", as_of: "2026-01-04" })).toBe(
      'ERROR no page "kafka"; use search to find a page\'s id',
    );
  });
});
