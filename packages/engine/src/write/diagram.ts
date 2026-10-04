import { type Manifest, memberId, parseMemberId } from "@repowiki/core";
import type { RepoIndex } from "../index/index.ts";
import { type DraftDiagram, mermaidLabel } from "../verify/index.ts";

/** A node the model may put in the page's diagram: a member file or a neighbouring feature. */
export interface DiagramNode {
  id: string;
  kind: "file" | "feature";
  /** The file's path or the feature's id. */
  ref: string;
  label: string;
}

/** A directed edge the index proves: one file imports or calls into another (spec §7.3). */
export interface DiagramEdge {
  from: string;
  to: string;
  kind: "imports" | "calls";
}

export interface DiagramCandidates {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export const MAX_DIAGRAM_NODES = 12;
const MAX_CANDIDATE_FILES = 16;
const MAX_CANDIDATE_FEATURES = 6;
const MAX_CANDIDATE_EDGES = 60;
const MAX_EDGE_LABEL = 40;

/**
 * The nodes and edges a page's diagram is drawn from: the feature's best-connected member files,
 * the neighbouring features they import from or call into (or that use them), and every import
 * or call edge among those. A call wins over an import for the same pair. Deterministic.
 */
export function diagramCandidates(
  featureId: string,
  manifest: Manifest,
  index: RepoIndex,
  memberFiles: readonly string[],
): DiagramCandidates {
  const featureOf = (path: string) => manifest.membership[memberId(path)]?.featureId;
  const pathOf = (member: string) => parseMemberId(member)?.path ?? member;
  const pairs: { from: string; to: string; kind: "imports" | "calls" }[] = [
    ...index.imports.map((e) => ({ from: e.from, to: e.to, kind: "imports" as const })),
    ...index.calls.map((e) => ({ from: pathOf(e.from), to: pathOf(e.to), kind: "calls" as const })),
  ].filter((p) => p.from !== p.to);

  const mine = new Set(memberFiles);
  const degree = new Map<string, number>();
  const foreign = new Map<string, number>();
  for (const { from, to } of pairs) {
    const inFrom = mine.has(from);
    const inTo = mine.has(to);
    if (!inFrom && !inTo) continue;
    for (const path of [from, to])
      if (mine.has(path)) degree.set(path, (degree.get(path) ?? 0) + 1);
    const other = inFrom && !inTo ? featureOf(to) : !inFrom && inTo ? featureOf(from) : undefined;
    const active = manifest.features.find((f) => f.id === other)?.status.kind === "active";
    if (other !== undefined && other !== featureId && active) {
      foreign.set(other, (foreign.get(other) ?? 0) + 1);
    }
  }
  const byWeight = (counts: Map<string, number>, limit: number) =>
    [...counts]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, limit)
      .map(([key]) => key);
  const files = byWeight(degree, MAX_CANDIDATE_FILES);
  const features = byWeight(foreign, MAX_CANDIDATE_FEATURES);

  const nodes: DiagramNode[] = [];
  const fileNode = new Map<string, string>();
  const featureNode = new Map<string, string>();
  for (const path of [...files].sort()) {
    const id = `n${nodes.length + 1}`;
    nodes.push({ id, kind: "file", ref: path, label: path });
    fileNode.set(path, id);
  }
  const titles = new Map(manifest.features.map((f) => [f.id, f.title]));
  for (const feature of [...features].sort()) {
    const id = `n${nodes.length + 1}`;
    nodes.push({ id, kind: "feature", ref: feature, label: titles.get(feature) ?? feature });
    featureNode.set(feature, id);
  }
  const node = (path: string) => {
    const file = fileNode.get(path);
    if (file !== undefined || mine.has(path)) return file;
    const owner = featureOf(path);
    return owner === undefined ? undefined : featureNode.get(owner);
  };

  const edges = new Map<string, DiagramEdge>();
  for (const { from, to, kind } of pairs) {
    const a = node(from);
    const b = node(to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = `${a}>${b}`;
    if (edges.get(key)?.kind !== "calls") edges.set(key, { from: a, to: b, kind });
  }
  const sortedEdges = [...edges.values()]
    .sort(
      (x, y) =>
        Number(x.from.slice(1)) - Number(y.from.slice(1)) ||
        Number(x.to.slice(1)) - Number(y.to.slice(1)),
    )
    .slice(0, MAX_CANDIDATE_EDGES);
  return { nodes, edges: sortedEdges };
}

/** How the pack lists the candidates for the model. */
export function renderCandidates(
  candidates: DiagramCandidates,
  plain: (s: string) => string,
): string {
  if (candidates.nodes.length === 0) return "(no candidates)";
  return [
    "nodes:",
    ...candidates.nodes.map(
      (n) => `- ${n.id}: ${n.kind} ${plain(n.kind === "file" ? n.ref : `${n.ref} (${n.label})`)}`,
    ),
    "edges:",
    ...candidates.edges.map((e) => `- ${e.from} -> ${e.to} (${e.kind})`),
  ].join("\n");
}

/**
 * An edge label is the model's text: cut to `MAX_EDGE_LABEL` code points, then escaped (cutting
 * escaped text could split an entity), or the edge's kind when nothing is left.
 */
function edgeLabel(text: string, fallback: string): string {
  return mermaidLabel(Array.from(text.trim()).slice(0, MAX_EDGE_LABEL).join("")) || fallback;
}

/** A node's label is engine data (a path or a feature title), escaped but not cut. */
function nodeLabel(node: DiagramNode): string {
  const basename = node.ref.slice(node.ref.lastIndexOf("/") + 1);
  return mermaidLabel(node.label) || mermaidLabel(basename) || "node";
}

/**
 * The page's Mermaid source, built by the engine from the model's choice (spec §7.3): only
 * candidate nodes (at most 12, in the order chosen) and only candidate edges between chosen
 * nodes, with model-written labels escaped. Unknown or extra choices are dropped, not retried.
 * Null when fewer than two nodes or no edge remain. No click lines: Mermaid's strict mode
 * ignores them, and the verifier refuses every directive (Task 11).
 */
export function renderDiagram(draft: DraftDiagram, candidates: DiagramCandidates): string | null {
  const byId = new Map(candidates.nodes.map((n) => [n.id, n]));
  const chosen = [...new Set(draft.nodes)].filter((id) => byId.has(id)).slice(0, MAX_DIAGRAM_NODES);
  const keep = new Set(chosen);
  const allowed = new Map(candidates.edges.map((e) => [`${e.from}>${e.to}`, e]));
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const edge of draft.edges) {
    const candidate = allowed.get(`${edge.from}>${edge.to}`);
    const key = `${edge.from}>${edge.to}`;
    if (candidate === undefined || !keep.has(edge.from) || !keep.has(edge.to) || seen.has(key))
      continue;
    seen.add(key);
    lines.push(`  ${edge.from} -->|"${edgeLabel(edge.label, candidate.kind)}"| ${edge.to}`);
  }
  if (chosen.length < 2 || lines.length === 0) return null;
  const nodes = chosen.map((id) => {
    const n = byId.get(id) as DiagramNode;
    const label = nodeLabel(n);
    return n.kind === "file" ? `  ${id}["${label}"]` : `  ${id}[["${label}"]]`;
  });
  return ["flowchart LR", ...nodes, ...lines].join("\n");
}
