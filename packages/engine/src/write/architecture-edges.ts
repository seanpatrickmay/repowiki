import { type FeatureEdge, type Manifest, memberId, parseMemberId } from "@repowiki/core";
import type { RepoIndex } from "../index/index.ts";
import { mermaidLabel } from "../verify/index.ts";

/** One line where a feature's file imports from or calls into another feature's file. */
export interface EdgeSite {
  path: string;
  line: number;
  kind: "import" | "call";
}

/** A FeatureEdge with the first lines that prove it, for the pack to offer as citations. */
export interface CrossFeatureEdge extends FeatureEdge {
  sites: EdgeSite[];
}

/** Longest node title drawn, in code points; a longer one is cut before it is escaped. */
export const MAX_NODE_TITLE = 80;
/** Lines of proof kept per edge. */
export const MAX_EDGE_SITES = 2;
/** The Architecture diagram's caps (see architectureDiagram). */
export const MAX_ARCHITECTURE_NODES = 40;
export const MAX_ARCHITECTURE_EDGES = 80;

/** Code-unit order, so the same index gives the same bytes in every locale. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const weightOf = (edge: FeatureEdge): number => edge.calls + edge.imports;
/** Heaviest first, ties by `from`, then `to`. */
const heaviestFirst = (x: FeatureEdge, y: FeatureEdge): number =>
  weightOf(y) - weightOf(x) || byText(x.from, y.from) || byText(x.to, y.to);

/** Sites in path, line and kind order, each distinct (path, line, kind) once. */
function uniqueSites(sites: readonly EdgeSite[]): EdgeSite[] {
  const sorted = [...sites].sort(
    (x, y) => byText(x.path, y.path) || x.line - y.line || byText(x.kind, y.kind),
  );
  return sorted.filter(
    (s, i) =>
      i === 0 ||
      s.path !== sorted[i - 1]?.path ||
      s.line !== sorted[i - 1]?.line ||
      s.kind !== sorted[i - 1]?.kind,
  );
}

/**
 * Every pair of features in `among` whose files are joined by an import or call edge of the
 * index, directed from the feature that imports or calls to the one it uses (spec §7.4), with
 * the counts and the first MAX_EDGE_SITES lines in path and line order. Edges inside one feature,
 * and those of a retired or redirected feature or one outside `among`, are left out. Heaviest
 * first (calls plus imports), ties by `from`, then `to`, in code-unit order. Deterministic.
 */
export function crossFeatureEdges(
  index: RepoIndex,
  manifest: Manifest,
  among: ReadonlySet<string>,
): CrossFeatureEdge[] {
  const active = new Set(
    manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id),
  );
  const featureOf = (path: string) => manifest.membership[memberId(path)]?.featureId;
  const pathOf = (member: string) => parseMemberId(member)?.path ?? member;
  const edges = new Map<string, CrossFeatureEdge>();
  const add = (from: string, to: string, site: EdgeSite) => {
    const a = featureOf(from);
    const b = featureOf(to);
    if (a === undefined || b === undefined || a === b) return;
    if (!among.has(a) || !among.has(b) || !active.has(a) || !active.has(b)) return;
    const key = `${a}>${b}`;
    const edge = edges.get(key) ?? { from: a, to: b, imports: 0, calls: 0, sites: [] };
    if (site.kind === "import") edge.imports += 1;
    else edge.calls += 1;
    edge.sites.push(site);
    edges.set(key, edge);
  };
  for (const e of index.imports) add(e.from, e.to, { path: e.from, line: e.line, kind: "import" });
  for (const e of index.calls) {
    const from = pathOf(e.from);
    add(from, pathOf(e.to), { path: from, line: e.line, kind: "call" });
  }
  return [...edges.values()]
    .map((edge) => ({
      ...edge,
      sites: uniqueSites(edge.sites).slice(0, MAX_EDGE_SITES),
    }))
    .sort(heaviestFirst);
}

/** "3 calls, 1 import": what an edge carries, with no zero part. */
export function edgeWeightLabel(edge: FeatureEdge): string {
  const part = (n: number, word: string) => (n === 0 ? [] : [`${n} ${word}${n === 1 ? "" : "s"}`]);
  return [...part(edge.calls, "call"), ...part(edge.imports, "import")].join(", ");
}

/** The first MAX_NODE_TITLE code points of `text`, escaped. */
const cutLabel = (text: string): string =>
  mermaidLabel(Array.from(text).slice(0, MAX_NODE_TITLE).join(""));

/** A node's label: the cut, escaped title, else the escaped id, else "feature" (never empty). */
function nodeLabel(feature: { id: string; title: string }): string {
  return cutLabel(feature.title) || cutLabel(feature.id) || "feature";
}

/**
 * The Architecture article's diagram, drawn by the engine alone (spec §7.4): one subroutine node
 * per feature page, labelled with its title through mermaidLabel, and one arrow per cross-feature
 * edge, labelled with its weight. A repository map has to show every feature, so the caps are the
 * page's own, not a feature page's 12 nodes: at most MAX_ARCHITECTURE_NODES features (those with
 * the most edge weight, ties by id) and the MAX_ARCHITECTURE_EDGES heaviest edges among them, far
 * inside verify's MAX_DIAGRAM_CHARS and MAX_DIAGRAM_EDGES. The edges are sorted here (heaviest
 * first, ties by `from`, then `to`), so the cap keeps the heaviest whatever order they arrive in;
 * an edge with no import and no call is never drawn. A title is cut to MAX_NODE_TITLE code points.
 * Nodes are numbered in feature-id order. Null when fewer than two features or no edge would be drawn.
 */
export function architectureDiagram(
  edges: readonly FeatureEdge[],
  features: readonly { id: string; title: string }[],
): string | null {
  const weight = new Map(features.map((f) => [f.id, 0]));
  for (const edge of edges) {
    for (const id of [edge.from, edge.to]) {
      const w = weight.get(id);
      if (w !== undefined) weight.set(id, w + weightOf(edge));
    }
  }
  const kept = [...features]
    .sort((a, b) => (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0) || byText(a.id, b.id))
    .slice(0, MAX_ARCHITECTURE_NODES)
    .sort((a, b) => byText(a.id, b.id));
  const node = new Map(kept.map((f, i) => [f.id, `n${i + 1}`]));
  const drawn = edges
    .filter((e) => weightOf(e) > 0 && node.has(e.from) && node.has(e.to) && e.from !== e.to)
    .sort(heaviestFirst)
    .slice(0, MAX_ARCHITECTURE_EDGES);
  if (kept.length < 2 || drawn.length === 0) return null;
  return [
    "flowchart LR",
    ...kept.map((f) => `  ${node.get(f.id)}[["${nodeLabel(f)}"]]`),
    ...drawn.map(
      (e) => `  ${node.get(e.from)} -->|"${mermaidLabel(edgeWeightLabel(e))}"| ${node.get(e.to)}`,
    ),
  ].join("\n");
}
