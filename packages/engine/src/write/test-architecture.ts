import { memberId, type Revision } from "@repowiki/core";
import { leadClaim, makeRevision } from "@repowiki/core/test-fixtures";
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
 * testWiki() with a README, its two pages and their edges, and the project's title: what an
 * Architecture call is built from. Test-only.
 */
export function testArchitectureInput() {
  const wiki = testWiki();
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
  const pages = testPages();
  const edges = crossFeatureEdges(
    wiki.index,
    wiki.manifest,
    new Set(pages.map((p) => p.featureId)),
  );
  return { ...wiki, pages, edges, title: projectTitle("sample", wiki.sources) };
}
