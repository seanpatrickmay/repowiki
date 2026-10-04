import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extendedWiki, type SampleWiki, sampleWiki } from "./test-wiki.ts";
import { ToolError } from "./tools.ts";
import { ABOUT_PAGE_ID, reference, WikiView } from "./wiki-view.ts";

let sample: SampleWiki;
let view: WikiView;
beforeAll(() => {
  sample = sampleWiki();
  view = new WikiView(extendedWiki(sample));
});
afterAll(() => sample.repo.remove());

describe("WikiView.resolve", () => {
  it("resolves a page id, a site path and the About article", () => {
    expect(view.resolve("signals")).toEqual({ kind: "page", featureId: "signals", from: null });
    expect(view.resolve(" /wiki/deliverables/ ")).toEqual({
      kind: "page",
      featureId: "deliverables",
      from: null,
    });
    expect(view.resolve(ABOUT_PAGE_ID)).toEqual({ kind: "about" });
  });

  it("follows a redirect, an alias and a title as the site's routes do, and says from where", () => {
    expect(view.resolve("legacy-signals")).toEqual({
      kind: "page",
      featureId: "signals",
      from: "legacy-signals",
    });
    expect(view.resolve("old ingest")).toEqual({
      kind: "page",
      featureId: "signals",
      from: "old ingest",
    });
    expect(view.resolve("Deliverable records")).toMatchObject({ featureId: "deliverables" });
    expect(view.resolve("Signal ingestion")).toMatchObject({ featureId: "signals" });
  });

  it("offers a disambiguation's choices, and refuses an id with no page", () => {
    expect(view.resolve("records")).toEqual({
      kind: "choices",
      from: "records",
      targets: ["signals", "deliverables"],
    });
    expect(() => view.resolve("kafka\nnow")).toThrow(
      new ToolError('no page "kafka now"; use search to find a page\'s id'),
    );
    expect(() => new WikiView(sample.wiki).resolve(ABOUT_PAGE_ID)).toThrow(ToolError);
  });
});

describe("WikiView.text", () => {
  it("names a linked page's id so the agent can read it, and keeps everything on one line", () => {
    expect(
      view.text(
        "[[deliverables|Records]] use [[signals]], not [[ghost]] or [[wp:Kafka]];\nsee `[[x]]`.",
      ),
    ).toBe(
      "Records [page: deliverables] use Signal ingestion [page: signals], not ghost or Kafka; see `[[x]]`.",
    );
  });

  it("gives a page's first lead sentence as its summary", () => {
    expect(view.summary("deliverables")).toBe(
      "**Deliverables** are the records sample builds from Signal ingestion [page: signals].",
    );
    expect(view.summary("nope")).toBe("");
  });
});

describe("reference", () => {
  it("names a code citation's lines and symbol, or a commit's subject and pull request", () => {
    expect(
      reference({
        kind: "code",
        path: "src/a.py",
        startLine: 3,
        endLine: 9,
        sha: "b".repeat(40),
        symbol: "run",
        contentHash: "0".repeat(64),
      }),
    ).toBe("src/a.py:3-9 (run) at commit bbbbbbb");
    expect(reference({ kind: "commit", sha: "c".repeat(40), subject: "fix: x\ny", pr: 4 })).toBe(
      'commit ccccccc "fix: x y", pull request #4',
    );
  });
});
