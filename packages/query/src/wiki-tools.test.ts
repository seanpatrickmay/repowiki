import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extendedWiki, type SampleWiki, sampleWiki } from "./test-wiki.ts";
import { MAX_TOOL_RESULT_CHARS } from "./tools.ts";
import {
  createWikiTools,
  MAX_SEARCH_RESULTS,
  pageSearchIndex,
  searchResults,
} from "./wiki-tools.ts";
import { ABOUT_PAGE_ID, WikiView } from "./wiki-view.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

describe("createWikiTools", () => {
  it("lists at most MAX_SEARCH_RESULTS pages, each line with no doubled stop and no trailing space", () => {
    const wiki = structuredClone(sample.wiki);
    const page = wiki.pages.find((p) => p.featureId === "deliverables");
    const feature = wiki.manifest.features.find((f) => f.id === "deliverables");
    const lead = page?.sections[0]?.claims[0];
    if (page === undefined || feature === undefined || lead === undefined) {
      throw new Error("the fixture has deliverables");
    }
    for (let i = 0; i < 10; i++) {
      const id = `widget-${i}`;
      wiki.manifest.features.push({
        ...feature,
        id,
        title: i === 0 ? "Widgets." : i === 1 ? "Widget gadget" : `Widget ${i}`,
        aliases: [],
      });
      wiki.pages.push({
        ...page,
        id: `${id}-1`,
        featureId: id,
        sections:
          i === 1
            ? []
            : [
                {
                  key: "lead",
                  claims: [{ ...lead, text: "Widgets widgets." }],
                },
              ],
      });
    }
    const tools = createWikiTools(wiki);
    expect(tools.definitions[0]?.description).toContain(
      `Returns up to ${MAX_SEARCH_RESULTS} pages`,
    );
    const lines = tools.run("search", { query: "widget" }).text.split("\n");
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(MAX_SEARCH_RESULTS);
    expect(lines).toContain("- widget-0: Widgets. Widgets widgets.");
    for (const line of lines) expect(line).not.toMatch(/ $|\.\./);
    expect(tools.run("search", { query: "gadget" }).text).toBe(
      "- widget-1: Widget gadget\nRead one with read_page(id).\n",
    );
  });

  it("fits an oversize page under the tool's cap, keeping its claims and References", () => {
    const wiki = structuredClone(sample.wiki);
    const overview = wiki.pages
      .find((p) => p.featureId === "signals")
      ?.sections.find((s) => s.key === "overview");
    const first = overview?.claims[0];
    if (overview === undefined || first === undefined) throw new Error("the fixture has claims");
    // Six claims of about 1,810 code points each, an astral character in every one, and a long
    // history: the claims fit under the cap, the history does not.
    overview.claims = Array.from({ length: 6 }, (_, i) => ({
      ...first,
      id: `s-big-${i}`,
      text: `${"w".repeat(1800)}\u{1F680} claim ${i}`,
    }));
    const page = wiki.pages.find((p) => p.featureId === "signals");
    if (page === undefined) throw new Error("the fixture has signals");
    wiki.history.signals = [1, 2, 3, 4, 5].map((i) => ({
      ...page,
      sha: String(i).repeat(40),
      reason: i === 1 ? "build" : "update",
      pr: i === 1 ? null : i,
    }));
    const { text, isError } = createWikiTools(wiki).run("read_page", { id: "signals" });
    expect(isError).toBe(false);
    expect(text.isWellFormed()).toBe(true);
    expect([...text].length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(text).toContain("\u{1F680} claim 5 [1]");
    expect(text).toContain("\nReferences\n[1] src/signals/ingest.py:10-24");
    expect(text).toMatch(
      new RegExp(
        `\\n\\(Left out to fit the ${MAX_TOOL_RESULT_CHARS}-character limit: [^)\\n]+\\.\\)\\n$`,
      ),
    );
  });

  it("offers search and read_page, each with a JSON schema for its input", () => {
    const tools = createWikiTools(sample.wiki);
    expect(tools.definitions.map((d) => d.name)).toEqual(["search", "read_page"]);
    expect(tools.definitions[0]?.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["query"],
      additionalProperties: false,
    });
  });

  it("finds pages by their words, best first, with each page's id, title and first lead sentence", () => {
    const tools = createWikiTools(sample.wiki);
    expect(tools.run("search", { query: "how are chunks turned into signals?" })).toEqual({
      text: [
        "- signals: Signal ingestion. **Signal ingestion** is the subsystem of sample that turns ingested chunks of text into signals.",
        "- deliverables: Deliverables. **Deliverables** are the records sample builds from Signal ingestion [page: signals].",
        "Read one with read_page(id).",
        "",
      ].join("\n"),
      isError: false,
    });
    expect(tools.run("search", { query: "create_deliverable" }).text).toMatch(/^- deliverables:/);
    expect(tools.run("search", { query: "crud.py" }).text).toMatch(/^- deliverables:/);
    expect(tools.run("search", { query: "kubernetes" }).text).toBe(
      "No page matches; try other words.\n",
    );
  });

  it("finds a page by a merged feature's old name, and the About article, but no retired page", () => {
    const tools = createWikiTools(extendedWiki(sample));
    expect(tools.run("search", { query: "old ingest" }).text).toMatch(/^- signals:/);
    expect(tools.run("search", { query: "about sample" }).text).toContain(
      `- ${ABOUT_PAGE_ID}: sample. `,
    );
    expect(tools.run("search", { query: "weekly reports" }).text).not.toContain("old-reports");
  });

  it("reads a page through read_page", () => {
    const tools = createWikiTools(sample.wiki);
    expect(tools.run("read_page", { id: "deliverables" }).text.split("\n")[0]).toBe(
      "Deliverables (page id: deliverables)",
    );
  });

  it("answers an unknown page, a bad input and an unknown tool with an error result", () => {
    const tools = createWikiTools(sample.wiki);
    expect(tools.run("read_page", { id: "kafka" })).toEqual({
      text: 'no page "kafka"; use search to find a page\'s id',
      isError: true,
    });
    expect(tools.run("read_page", { id: ABOUT_PAGE_ID }).isError).toBe(true);
    expect(tools.run("search", {})).toEqual({
      text: "invalid input for search: query: Invalid input: expected string, received undefined",
      isError: true,
    });
    expect(tools.run("grep", { pattern: "x" })).toEqual({
      text: "no tool named grep; the tools are search, read_page",
      isError: true,
    });
  });
});

describe("searchResults' note and hint", () => {
  it("keep each result on one line", () => {
    const wiki = sampleWiki();
    try {
      const view = new WikiView(wiki.wiki);
      const text = searchResults(view, pageSearchIndex(view), "signals", {
        note: () => "(cites\nchanged files)",
        hint: "Read one\nwith read_page(id).",
      });
      expect(text).toContain(" (cites changed files)\n");
      expect(text.endsWith("\nRead one with read_page(id).\n")).toBe(true);
    } finally {
      wiki.repo.remove();
    }
  });
});
