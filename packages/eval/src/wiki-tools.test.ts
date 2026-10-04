import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extendedWiki, type SampleWiki, sampleWiki } from "./test-wiki.ts";
import { createWikiTools } from "./wiki-tools.ts";
import { ABOUT_PAGE_ID } from "./wiki-view.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

describe("createWikiTools", () => {
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
