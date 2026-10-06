import { pageSearchIndex, WikiView } from "@repowiki/query";
import { extendedWiki, type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAskTools } from "./tools.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

function setup() {
  const view = new WikiView(extendedWiki(sample));
  const searched: string[] = [];
  const read: { pageId: string; title: string; handles: readonly string[] }[] = [];
  const tools = createAskTools(view, pageSearchIndex(view), {
    searched: (query) => searched.push(query),
    read: (page) => read.push(page),
  });
  return { tools, searched, read };
}

describe("createAskTools", () => {
  it("has search and read_page with the wiki agent's input schemas", () => {
    const { tools } = setup();
    expect(tools.definitions.map((d) => d.name)).toEqual(["search", "read_page"]);
    expect(tools.definitions[1]?.description).toContain("starting with its handle");
  });

  it("searches as the wiki agent does and reports the query", () => {
    const { tools, searched } = setup();
    const result = tools.run("search", { query: "deliverables" });
    expect(result.isError).toBe(false);
    expect(result.text.split("\n")[0]).toMatch(/^- deliverables: Deliverables\./);
    expect(searched).toEqual(["deliverables"]);
  });

  it("reads a page with handles and reports its id, title and handles", () => {
    const { tools, read } = setup();
    const result = tools.run("read_page", { id: "legacy-signals" });
    expect(result.text).toContain("- {signals#s-1} ");
    expect(result.text).not.toContain("Page history");
    expect(read).toEqual([
      {
        pageId: "signals",
        title: "Signal ingestion",
        handles: ["signals#s-lead", "signals#s-1", "signals#s-2", "signals#s-h", "signals#s-l"],
      },
    ]);
  });

  it("reports no page for choices, and answers a bad id as a tool error", () => {
    const { tools, read } = setup();
    expect(tools.run("read_page", { id: "records" }).text).toContain("may refer to:");
    expect(tools.run("read_page", { id: "nowhere" })).toMatchObject({ isError: true });
    expect(tools.run("read_page", {})).toMatchObject({ isError: true });
    expect(read).toEqual([]);
  });
});
