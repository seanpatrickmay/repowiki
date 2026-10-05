import { createWikiTools } from "@repowiki/query";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepoTools } from "./repo-tools.ts";
import { extendedWiki, type SampleWiki, sampleWiki } from "./test-wiki.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

/** Each call's input and its output, as one block of text. */
const transcript = (
  tools: ReturnType<typeof createWikiTools>,
  calls: readonly [string, unknown][],
): string =>
  calls
    .map(([name, input]) => {
      const { text, isError } = tools.run(name, input);
      return `>>> ${name} ${JSON.stringify(input)}${isError ? " (error)" : ""}\n${text}`;
    })
    .join("\n");

/**
 * The v1 agents' tools, as the M7 cassettes recorded them: their definitions and a fixed set of
 * outputs. Written before @repowiki/query was extracted and compared after it, so the move (and
 * every later change to query's defaults) is caught here before a cassette misses (C4).
 */
describe("the v1 wiki and repo tools", () => {
  it("keep their definitions and outputs byte for byte", async () => {
    const wiki = createWikiTools(sample.wiki);
    const extended = createWikiTools(extendedWiki(sample));
    const repo = createRepoTools(sample.repo.dir, sample.sha);
    const text = [
      JSON.stringify([...wiki.definitions, ...repo.definitions], null, 2),
      transcript(wiki, [
        ["search", { query: "how are chunks turned into signals?" }],
        ["search", { query: "kubernetes" }],
        ["read_page", { id: "signals" }],
        ["read_page", { id: "deliverables" }],
        ["read_page", { id: "kafka" }],
        ["search", {}],
      ]),
      transcript(extended, [
        ["search", { query: "about sample" }],
        ["read_page", { id: "special:about" }],
        ["read_page", { id: "records" }],
        ["read_page", { id: "legacy-signals" }],
        ["read_page", { id: "old-reports" }],
      ]),
      transcript(repo, [
        ["list_files", {}],
        ["read_file", { path: "src/signals/ingest.py", start_line: 5, end_line: 12 }],
        ["grep", { pattern: "save_signal" }],
        ["read_file", { path: "../etc/passwd" }],
      ]),
    ].join("\n\n");
    await expect(text).toMatchFileSnapshot("./__snapshots__/v1-tools.txt");
  });
});
