import { WikiExport } from "@repowiki/core";
import { makeFeature } from "@repowiki/core/test-fixtures";
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

describe("WikiView.resolve, ids as an agent gives them", () => {
  let routed: WikiView;
  beforeAll(() => {
    const base = extendedWiki(sample);
    const sha = sample.sha;
    const create = { kind: "create" as const, sha };
    routed = new WikiView(
      WikiExport.parse({
        ...base,
        manifest: {
          ...base.manifest,
          features: [
            ...base.manifest.features,
            makeFeature({
              id: "ledger",
              title: "Ledger",
              aliases: ["storage"],
              status: { kind: "redirect", to: "signals" },
              lineage: [create, { kind: "merge", sha, into: "signals" }],
            }),
            makeFeature({
              id: "vault",
              title: "Vault",
              aliases: ["storage"],
              status: { kind: "redirect", to: "deliverables" },
              lineage: [create, { kind: "merge", sha, into: "deliverables" }],
            }),
            makeFeature({
              id: "merged-records",
              title: "Merged records",
              aliases: ["records archive"],
              status: { kind: "redirect", to: "records" },
              lineage: [create, { kind: "merge", sha, into: "records" }],
            }),
            makeFeature({
              id: "mixed",
              title: "Mixed",
              aliases: [],
              status: { kind: "disambiguation", to: ["legacy-signals", "signals", "deliverables"] },
              lineage: [
                create,
                { kind: "split", sha, into: ["legacy-signals", "signals", "deliverables"] },
              ],
            }),
          ],
        },
      }),
    );
  });

  it("takes a title, any case or spelling, whose slug is the feature id", () => {
    for (const id of ["Signals", "SIGNALS", "signals ", " Signal-ingestion"]) {
      expect(view.resolve(id)).toMatchObject({ kind: "page", featureId: "signals" });
    }
    expect(view.resolve("Signals")).toEqual({ kind: "page", featureId: "signals", from: null });
    expect(view.resolve("Deliverables")).toEqual({
      kind: "page",
      featureId: "deliverables",
      from: null,
    });
    expect(view.resolve("Records")).toEqual({
      kind: "choices",
      from: "Records",
      targets: ["signals", "deliverables"],
    });
  });

  it("resolves a retired feature that has a stored page, by id or title", () => {
    const retired = { kind: "page", featureId: "old-reports", from: null };
    expect(view.resolve("old-reports")).toEqual(retired);
    expect(view.resolve("Old reports")).toEqual(retired);
    expect(view.resolve("old_reports")).toEqual(retired);
  });

  it("follows a redirect by a differently spelled id, and says from where", () => {
    expect(view.resolve("Legacy-Signals")).toEqual({
      kind: "page",
      featureId: "signals",
      from: "Legacy-Signals",
    });
    expect(view.resolve("Legacy signal store")).toMatchObject({ featureId: "signals" });
  });

  it("offers every target of an alias that several routes share", () => {
    expect(routed.resolve("Storage")).toEqual({
      kind: "choices",
      from: "Storage",
      targets: ["signals", "deliverables"],
    });
  });

  it("lists a disambiguation's targets at their final articles, once each", () => {
    expect(routed.resolve("mixed")).toEqual({
      kind: "choices",
      from: "mixed",
      targets: ["signals", "deliverables"],
    });
  });

  it("offers the choices when a redirect or an alias leads to a disambiguation", () => {
    const choices = ["signals", "deliverables"];
    expect(routed.resolve("merged-records")).toEqual({
      kind: "choices",
      from: "merged-records",
      targets: choices,
    });
    expect(routed.resolve("records archive")).toEqual({
      kind: "choices",
      from: "records archive",
      targets: choices,
    });
  });

  it("takes the About article as the site and the agent spell it, in any case", () => {
    for (const id of ["Special:About", "SPECIAL:ABOUT", "/special/about/", "wiki/Special/About"]) {
      expect(view.resolve(id)).toEqual({ kind: "about" });
    }
    expect(() => new WikiView(sample.wiki).resolve("/special/about/")).toThrow(ToolError);
  });

  it("echoes a hostile id only as one capped printable line", () => {
    const resolved = view.resolve(`old ingest\u202E\n${"!".repeat(5000)}`);
    expect(resolved).toMatchObject({ kind: "page", featureId: "signals" });
    const from = resolved.kind === "page" ? (resolved.from ?? "") : "";
    expect(from).toBe(`old ingest\uFFFD ${"!".repeat(67)}\u2026`);
    expect([...from]).toHaveLength(80);

    const astral = view.resolve(`old ingest${"!".repeat(68)}\u{1F680}${"!".repeat(10)}`);
    const astralFrom = astral.kind === "page" ? (astral.from ?? "") : "";
    expect(astralFrom).toBe(`old ingest${"!".repeat(68)}\u{1F680}\u2026`);
    expect(astralFrom.isWellFormed()).toBe(true);

    for (const id of ["__proto__", "constructor", "\u202Efoo", `${"x".repeat(5000)}`, ""]) {
      expect(() => view.resolve(id), id.slice(0, 20)).toThrow(ToolError);
    }
    try {
      view.resolve(`a\u202E\n${"b".repeat(5000)}`);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/^no page "a\uFFFD b+\u2026"; use search/);
      expect([...message].length).toBeLessThan(140);
    }
  });
});

describe("WikiView with page-less targets", () => {
  it("offers only the choices that have a page, and no choices at all as no page", () => {
    const wiki = structuredClone(extendedWiki(sample));
    const records = wiki.manifest.features.find((f) => f.id === "records");
    if (records === undefined) throw new Error("the fixture has records");
    wiki.manifest.features.push(
      makeFeature({ id: "ghost", title: "Ghost", aliases: [], status: { kind: "active" } }),
      makeFeature({ id: "ghost-two", title: "Ghost two", aliases: [], status: { kind: "active" } }),
      {
        ...records,
        id: "haunted",
        title: "Haunted",
        status: { kind: "disambiguation", to: ["ghost", "ghost-two"] },
      },
    );
    records.status = { kind: "disambiguation", to: ["signals", "ghost"] };
    const view = new WikiView(wiki);
    expect(view.resolve("records")).toEqual({
      kind: "choices",
      from: "records",
      targets: ["signals"],
    });
    expect(() => view.resolve("haunted")).toThrow(ToolError);
  });
});

describe("WikiView.text", () => {
  it("neutralises text in a claim that imitates a reference mark or a page link", () => {
    expect(
      view.text(
        "True [1][2] and [page: signals] and [pages: a, b] and [[deliverables|[page: x]]].",
      ),
    ).toBe("True (1)(2) and (page: signals] and (pages: a, b] and (page: x [page: deliverables]].");
    expect(view.text("Keeps `a[1]` and `[page: x]` in code, and array[i].")).toBe(
      "Keeps `a[1]` and `[page: x]` in code, and array[i].",
    );
  });

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

  it("cuts a long summary by code point, so an astral character at the cut is never split", () => {
    const wiki = structuredClone(extendedWiki(sample));
    const lead = wiki.pages
      .find((p) => p.featureId === "deliverables")
      ?.sections.find((s) => s.key === "lead")?.claims[0];
    if (lead === undefined) throw new Error("the fixture has a lead");
    lead.text = `${"d".repeat(198)}\u{1F680}${"e".repeat(50)}`;
    const summary = new WikiView(wiki).summary("deliverables");
    expect(summary).toBe(`${"d".repeat(198)}\u{1F680}\u2026`);
    expect(summary.isWellFormed()).toBe(true);
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
