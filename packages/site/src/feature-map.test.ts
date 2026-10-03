import type { FeatureEdge } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import {
  featureMapCaption,
  featureMapSource,
  MAX_ARCHITECTURE_EDGES,
  mermaidLabel,
} from "./feature-map.ts";
import { buildSiteModel } from "./model.ts";
import { ARCHITECTURE, fixtureExport, HOSTILE_TITLE } from "./test-fixtures.ts";

/** The fixture export without its project article, so the map draws See also pairs. */
const seeAlsoOnly = () => ({ ...fixtureExport(), architecture: [] });

/** The map's edge lines. */
const edgeLines = (source: string | null) =>
  (source ?? "").split("\n").filter((l) => l.includes(" --- "));

/** The fixture export with the project article's edges replaced. */
function withEdges(edges: FeatureEdge[]) {
  const wiki = fixtureExport();
  return { ...wiki, architecture: wiki.architecture.map((a) => ({ ...a, edges })) };
}

/**
 * An export with `count` active features f000, f001, … (node n<i> is f<i>), each with a page and
 * no See also, and a project article with the given edges.
 */
function denseExport(count: number, edges: FeatureEdge[]) {
  const wiki = fixtureExport();
  const feature = wiki.manifest.features.find((f) => f.id === "signals");
  const page = wiki.pages.find((p) => p.featureId === "signals");
  if (feature === undefined || page === undefined) throw new Error("fixture changed");
  const ids = Array.from({ length: count }, (_, i) => `f${String(i).padStart(3, "0")}`);
  return {
    ...wiki,
    manifest: { ...wiki.manifest, features: ids.map((id) => ({ ...feature, id, aliases: [] })) },
    pages: ids.map((featureId) => ({ ...page, featureId, seeAlso: [] })),
    history: {},
    architecture: [{ ...ARCHITECTURE, edges }],
  };
}

/** The fixture export with one feature's title replaced. */
function withTitle(id: string, title: string) {
  const wiki = fixtureExport();
  const features = wiki.manifest.features.map((f) => (f.id === id ? { ...f, title } : f));
  return { ...wiki, manifest: { ...wiki.manifest, features } };
}

describe("featureMapSource", () => {
  it("draws one edge per pair the project article's cross-feature edges join", () => {
    // deliverables -> signals and hostile-title -> signals: n0 --- n2 and n1 --- n2.
    const site = buildSiteModel(fixtureExport(), null);
    expect((featureMapSource(site) ?? "").split("\n").filter((l) => l.includes(" --- "))).toEqual([
      "  n0 --- n2",
      "  n1 --- n2",
    ]);
    expect(featureMapCaption(site)).toContain("calls or imports");
  });

  it("draws only the heaviest article pairs, at most MAX_ARCHITECTURE_EDGES of them", () => {
    // 100 features, every pair joined, weights with many ties (broken by pair id).
    const weight = (i: number, j: number) => ((i * 31 + j * 17) % 50) + 1;
    const edges: FeatureEdge[] = [];
    const expected: { line: string; weight: number; pair: string }[] = [];
    for (let i = 0; i < 100; i++) {
      for (let j = i + 1; j < 100; j++) {
        const [from, to] = [`f${String(i).padStart(3, "0")}`, `f${String(j).padStart(3, "0")}`];
        edges.push({ from, to, imports: 0, calls: weight(i, j) });
        expected.push({ line: `  n${i} --- n${j}`, weight: weight(i, j), pair: `${from} ${to}` });
      }
    }
    expected.sort((a, b) => b.weight - a.weight || (a.pair < b.pair ? -1 : 1));
    const heaviest = expected.slice(0, 80).map((e) => e.line);
    const lines = edgeLines(featureMapSource(buildSiteModel(denseExport(100, edges), null)));
    expect(lines).toHaveLength(80);
    expect(MAX_ARCHITECTURE_EDGES).toBe(80);
    expect(lines).toEqual([...heaviest].sort());
  });

  it("falls back to See also pairs and caption when the article has no edge", () => {
    const site = buildSiteModel(withEdges([]), null);
    expect(edgeLines(featureMapSource(site))).toEqual(["  n0 --- n1", "  n0 --- n2"]);
    expect(featureMapCaption(site)).toContain("See also");
  });

  it("falls back to See also pairs and caption when no article edge joins two map nodes", () => {
    // scheduler has no page, exporter is retired, and legacy-signals redirects to signals.
    const site = buildSiteModel(
      withEdges([
        { from: "signals", to: "scheduler", imports: 3, calls: 0 },
        { from: "exporter", to: "deliverables", imports: 0, calls: 2 },
        { from: "legacy-signals", to: "signals", imports: 1, calls: 0 },
      ]),
      null,
    );
    expect(edgeLines(featureMapSource(site))).toEqual(["  n0 --- n1", "  n0 --- n2"]);
    expect(featureMapCaption(site)).toContain("See also");
  });

  it("draws one clickable node per active article and one edge per See also pair without one", () => {
    // Active articles with a page: deliverables, hostile-title and signals. Signals and
    // Deliverables list each other (one edge); Deliverables also lists the hostile article.
    const site = buildSiteModel(seeAlsoOnly(), null);
    expect(featureMapCaption(site)).toContain("See also");
    expect(featureMapSource(site)).toBe(
      [
        "flowchart LR",
        '  n0["Deliverables"]',
        `  n1["${mermaidLabel(HOSTILE_TITLE)}"]`,
        '  n2["Signal ingestion"]',
        "  n0 --- n1",
        "  n0 --- n2",
        '  click n0 "/wiki/deliverables/"',
        '  click n1 "/wiki/hostile-title/"',
        '  click n2 "/wiki/signals/"',
      ].join("\n"),
    );
  });

  it("draws an edge to the final article when See also names a merged feature", () => {
    // legacy-signals is a redirect to signals, so a link to it joins the hostile article to signals.
    const wiki = seeAlsoOnly();
    const pages = wiki.pages.map((p) =>
      p.featureId === "hostile-title" ? { ...p, seeAlso: ["legacy-signals"] } : p,
    );
    const source = featureMapSource(buildSiteModel({ ...wiki, pages }, null)) ?? "";
    expect(source.split("\n").filter((l) => l.includes(" --- "))).toEqual([
      "  n0 --- n1",
      "  n0 --- n2",
      "  n1 --- n2",
    ]);
    expect(source).not.toContain("legacy");
  });

  it("escapes quotes in titles and is null without articles", () => {
    const site = buildSiteModel(withTitle("signals", 'The "signals"'), null);
    expect(featureMapSource(site)).toContain('n2["The #quot;signals#quot;"]');
    const wiki = fixtureExport();
    expect(featureMapSource(buildSiteModel({ ...wiki, pages: [], history: {} }, null))).toBeNull();
  });

  it("labels a node with its id when the title has nothing printable", () => {
    const site = buildSiteModel(withTitle("signals", "\uE000\n"), null);
    expect(featureMapSource(site)).toContain('  n2["signals"]');
  });

  it("keeps a hostile title inside its label: one node line, no markup, no stray syntax", () => {
    const source = featureMapSource(buildSiteModel(fixtureExport(), null)) ?? "";
    const line = source.split("\n").find((l) => l.startsWith("  n1[")) ?? "";
    expect(line).toBe(`  n1["${mermaidLabel(HOSTILE_TITLE)}"]`);
    // The label is the characters between the node's opening `["` and closing `"]`.
    const label = line.slice('  n1["'.length, -'"]'.length);
    expect(label).toBe(
      "#lt;img src#61;x onerror#61;alert#40;1#41;#gt; #quot;q#quot; #amp; #39;p#39;",
    );
    // Nothing but letters, digits, spaces and #entity; runs remains.
    expect(label.replace(/#(?:quot|lt|gt|amp|\d+);/g, "")).toMatch(/^[\p{L}\p{N} ]*$/u);
    expect(source).not.toMatch(/[\uE000-\uF8FF<>']/);
    // Only the three expected node lines, edge lines and click lines exist.
    for (const l of source.split("\n").slice(1)) {
      expect(l).toMatch(
        /^ {2}(?:n\d+\["[^"]+"\]|n\d+ --- n\d+|click n\d+ "\/wiki\/[a-z0-9-]+\/")$/,
      );
    }
  });

  it("emits one click line per node and only site-built article URLs", () => {
    const source = featureMapSource(buildSiteModel(fixtureExport(), null)) ?? "";
    const clicks = source.split("\n").filter((l) => /\bclick\b/.test(l));
    expect(clicks).toHaveLength(3);
    for (const l of clicks)
      expect(l).toMatch(/^ {2}click n\d+ "\/wiki\/[a-z0-9]+(?:-[a-z0-9]+)*\/"$/);
  });
});

describe("mermaidLabel", () => {
  it("encodes quote, bracket, semicolon, comment and directive syntax as entities", () => {
    expect(mermaidLabel('a"]; click n0 call alert() %% b')).toBe(
      "a#quot;#93;#59; click n0 call alert#40;#41; #37;#37; b",
    );
    expect(mermaidLabel("[x] (y) {z} | \\ `w` # %%{init}%%")).toBe(
      "#91;x#93; #40;y#41; #123;z#125; #124; #92; #96;w#96; #35; #37;#37;#123;init#125;#37;#37;",
    );
  });

  it("flattens newlines and control characters, and drops private-use characters", () => {
    expect(mermaidLabel('a\nclick n0 "http://evil"\r\n\tb\u0000c\u2028d\uE000e')).toBe(
      "a click n0 #quot;http#58;//evil#quot; b c de",
    );
  });

  it("encodes an existing entity-looking run so it displays literally", () => {
    expect(mermaidLabel("#quot; and #35;")).toBe("#35;quot#59; and #35;35#59;");
  });

  it("keeps ordinary words, digits and non-ASCII letters, but not Mermaid's placeholder letters", () => {
    expect(mermaidLabel("Signal ingestion v2 - grösse 数据")).toBe(
      "Signal ingestion v2 - grösse 数据",
    );
    // U+00DF and U+FB02 spell Mermaid's entity placeholders, so they are entities.
    expect(mermaidLabel("größe")).toBe("grö#223;e");
  });

  it("falls back to an empty string for a label with nothing printable", () => {
    expect(mermaidLabel("\uE000\n\t")).toBe("");
  });
});
