import { memberId, type Revision } from "@repowiki/core";
import { leadClaim, makeRevision } from "@repowiki/core/test-fixtures";
import type { ArchitectureDraft } from "../verify/index.ts";
import { crossFeatureEdges } from "./architecture-edges.ts";
import { projectTitle } from "./architecture-pack.ts";
import { testWiki } from "./test-wiki.ts";

/** Pages for testWiki()'s two features, as a build would store them. Test-only. */
export function testPages(): Revision[] {
  const page = (featureId: string, entryPoint: string, lead: string) =>
    makeRevision({
      id: `${featureId}-aaaaaaaaaaaa`,
      featureId,
      seeAlso: [],
      infobox: { ...makeRevision().infobox, entryPoints: [entryPoint] },
      sections: [
        { key: "lead", claims: [leadClaim({ text: lead })] },
        ...makeRevision().sections.slice(1),
      ],
    });
  return [
    page(
      "deliverables",
      "src/deliverables/crud.py",
      "**Deliverables** are tracked records that ingest their notes as [[signals]].",
    ),
    page("signals", "src/signals/ingest.py", "**Signal ingestion** turns chunks into signals."),
  ];
}

/** The sample repository's README: a title with Markdown in it, and what the project is for. */
export const SAMPLE_README = [
  "# Sample *Ops*",
  "",
  "Sample Ops helps a small team turn meeting notes into signals and track deliverables.",
  "",
  "It is for project leads who lose track of what was promised.",
  "",
].join("\n");

/**
 * Adds SAMPLE_README to a testWiki()'s sources and index, so the project pack shows it and a
 * claim may cite its lines. Test-only.
 */
export function addSampleReadme(wiki: Pick<ReturnType<typeof testWiki>, "sources" | "index">) {
  wiki.sources.set("README.md", SAMPLE_README);
  wiki.index.files.push({
    id: memberId("README.md"),
    path: "README.md",
    language: null,
    bytes: SAMPLE_README.length,
    loc: 5,
    skipped: null,
    parseError: false,
    symbols: [],
  });
}

/**
 * testWiki() with a README, its two pages and their edges, and the project's title: what an
 * Architecture call is built from. Test-only.
 */
export function testArchitectureInput() {
  const wiki = testWiki();
  addSampleReadme(wiki);
  const pages = testPages();
  const edges = crossFeatureEdges(
    wiki.index,
    wiki.manifest,
    new Set(pages.map((p) => p.featureId)),
  );
  return { ...wiki, pages, edges, title: projectTitle("sample", wiki.sources) };
}

/** A draft of the project article for testArchitectureInput() that verifies cleanly. Test-only. */
export function architectureDraft(): ArchitectureDraft {
  const claim = (id: string, text: string, cite: string[], pages: string[] = []) => ({
    id,
    text,
    cite,
    pages,
    supports: [],
  });
  return {
    sections: [
      {
        key: "lead",
        claims: [
          {
            ...claim(
              "l1",
              "**Sample Ops** is built from [[signals|signal ingestion]] and [[deliverables]].",
              [],
            ),
            supports: ["u1", "y1", "p1", "d1"],
          },
        ],
      },
      {
        key: "purpose",
        claims: [
          claim(
            "u1",
            "Sample Ops turns meeting notes into signals and tracks deliverables for project leads.",
            ["README.md:3-5"],
          ),
        ],
      },
      {
        key: "layers",
        claims: [
          claim("y1", "`complete()` in the deliverables layer hands notes to ingestion.", [
            "src/deliverables/crud.py:4-5",
          ]),
        ],
      },
      {
        key: "request-paths",
        claims: [
          claim("p1", "A completed deliverable's notes go through `ingest_chunk()`.", [
            "src/deliverables/crud.py:7",
          ]),
        ],
      },
      {
        key: "dependencies",
        claims: [
          claim(
            "d1",
            "[[deliverables]] depends on [[signals]], which works like a [[wp:Message queue]].",
            [],
            ["deliverables", "signals"],
          ),
        ],
      },
    ],
  };
}
