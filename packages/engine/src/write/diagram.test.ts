import { type Feature, type Manifest, memberId } from "@repowiki/core";
import { makeFeature, makeManifest } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import type { RepoIndex } from "../index/index.ts";
import { plain } from "../manifest/index.ts";
import { diagramProblems } from "../verify/index.ts";
import {
  type DiagramCandidates,
  diagramCandidates,
  MAX_DIAGRAM_NODES,
  renderCandidates,
  renderDiagram,
} from "./diagram.ts";
import { featureFiles } from "./prompt.ts";
import { testWiki } from "./test-wiki.ts";

function candidates() {
  const { index, manifest } = testWiki();
  return diagramCandidates("signals", manifest, index, featureFiles(manifest, "signals"));
}

describe("diagramCandidates", () => {
  it("offers connected member files and neighbouring features, with calls winning over imports", () => {
    expect(candidates()).toEqual({
      nodes: [
        { id: "n1", kind: "file", ref: "src/signals/ingest.py", label: "src/signals/ingest.py" },
        { id: "n2", kind: "file", ref: "src/signals/store.py", label: "src/signals/store.py" },
        { id: "n3", kind: "feature", ref: "deliverables", label: "Deliverables" },
      ],
      edges: [
        { from: "n1", to: "n2", kind: "calls" },
        { from: "n3", to: "n1", kind: "calls" },
      ],
    });
  });
});

describe("renderDiagram", () => {
  it("draws the chosen candidates with escaped labels, and the verifier accepts it", () => {
    const source = renderDiagram(
      {
        nodes: ["n3", "n1", "n2"],
        edges: [
          { from: "n3", to: "n1", label: 'sends "notes"' },
          { from: "n1", to: "n2", label: "" },
        ],
      },
      candidates(),
    );
    expect(source).toBe(
      [
        "flowchart LR",
        '  n3[["Deliverables"]]',
        '  n1["src/signals/ingest.py"]',
        '  n2["src/signals/store.py"]',
        '  n3 -->|"sends #quot;notes#quot;"| n1',
        '  n1 -->|"calls"| n2',
      ].join("\n"),
    );
    expect(diagramProblems(source ?? "")).toEqual([]);
  });

  it("drops unknown nodes, non-candidate edges and edges to unchosen nodes", () => {
    const source = renderDiagram(
      {
        nodes: ["n1", "n2", "n9"],
        edges: [
          { from: "n2", to: "n1", label: "backwards" },
          { from: "n3", to: "n1", label: "unchosen" },
          { from: "n1", to: "n2", label: "stores" },
          { from: "n1", to: "n2", label: "again" },
        ],
      },
      candidates(),
    );
    expect(source?.split("\n").slice(3)).toEqual(['  n1 -->|"stores"| n2']);
  });

  it("is null with fewer than two nodes or no edge left", () => {
    expect(renderDiagram({ nodes: ["n1"], edges: [] }, candidates())).toBeNull();
    expect(renderDiagram({ nodes: ["n1", "n2"], edges: [] }, candidates())).toBeNull();
  });

  it("neutralises hostile labels the model writes", () => {
    const source = renderDiagram(
      {
        nodes: ["n1", "n2"],
        edges: [{ from: "n1", to: "n2", label: '"]\nclick n1 "javascript:alert(1)"' }],
      },
      candidates(),
    );
    expect(source).not.toContain("javascript:");
    expect(diagramProblems(source ?? "")).toEqual([]);
  });
});

/** Strings that have broken, or could break, a Mermaid label. */
const HOSTILE = [
  'say "hi"',
  "a]b[c]]d[[e",
  "{x}(y)|z|",
  "#123; #quot; #",
  "a;b;c",
  "%%{init: {}}%%",
  "$$x^2$$",
  "&amp; &lt;script&gt;",
  "<img src=x onerror=alert(1)>",
  "n1@{ img: x }",
  "line\nclick n1 href",
  "tab\tcr\rnul\0esc\u001b",
  "\u202eevil\u202c \u2066x\u2069 zero\u200bwidth \ufeff",
  "\u2028\u2029 \u00a0 \u3000",
  "emoji \u{1f600} \u{1f468}\u200d\u{1f469}\u200d\u{1f467}",
  "\u{e000} private \u{10ffff} \ud800 lone",
  "ligature \ufb02 \ufb01 \u00b0 \u00b6 \u00df",
  "x".repeat(200),
  "#".repeat(200),
  '"'.repeat(41),
  `${"a".repeat(39)}#`,
  `${"a".repeat(38)}\u{1f600}\u{1f600}`,
  "   ",
  "",
];

describe("renderDiagram with hostile labels", () => {
  const all = candidates();
  const fromLabels = (label: string): DiagramCandidates => ({
    ...all,
    nodes: all.nodes.map((n) => ({ ...n, label })),
  });

  it.each(HOSTILE.map((text) => [JSON.stringify(text), text] as const))(
    "never yields a diagram the verifier refuses: %s",
    (_name, text) => {
      const draft = {
        nodes: ["n1", "n2", "n3"],
        edges: [
          { from: "n1", to: "n2", label: text },
          { from: "n3", to: "n1", label: text },
        ],
      };
      for (const c of [all, fromLabels(text)]) {
        const source = renderDiagram(draft, c);
        expect(source).not.toBeNull();
        expect(diagramProblems(source ?? "")).toEqual([]);
        expect(source?.endsWith("\n")).toBe(false);
      }
    },
  );

  it("cuts a label to 40 code points before escaping, so an entity is never split", () => {
    const label = `${"a".repeat(39)}#bc`;
    const source = renderDiagram(
      { nodes: ["n1", "n2"], edges: [{ from: "n1", to: "n2", label }] },
      all,
    );
    expect(source?.split("\n")[3]).toBe(`  n1 -->|"${"a".repeat(39)}#35;"| n2`);
    const emoji = "\u{1f600}".repeat(41);
    const drawn = renderDiagram(
      { nodes: ["n1", "n2"], edges: [{ from: "n1", to: "n2", label: emoji }] },
      all,
    );
    expect(drawn?.split("\n")[3]).toBe(`  n1 -->|"${"#128512;".repeat(40)}"| n2`);
  });

  it("falls back when a label escapes to nothing: the edge kind, the basename, then node", () => {
    const edge = (label: string, c: DiagramCandidates) =>
      renderDiagram({ nodes: ["n1", "n2"], edges: [{ from: "n1", to: "n2", label }] }, c);
    expect(edge("\u200b\u202e", all)?.split("\n")[3]).toBe('  n1 -->|"calls"| n2');
    const blank = (label: string, ref: string): DiagramCandidates => ({
      nodes: [
        { id: "n1", kind: "file", ref, label },
        { id: "n2", kind: "file", ref: "b.py", label: "b" },
      ],
      edges: [{ from: "n1", to: "n2", kind: "imports" }],
    });
    expect(edge("x", blank("\u200b", "src/dir/main.py"))?.split("\n")[1]).toBe('  n1["main.py"]');
    expect(edge("x", blank("\u200b", "src/\u200b"))?.split("\n")[1]).toBe('  n1["node"]');
  });
});

/** A synthetic repo: `owners` maps each path to its feature, `pairs` are imports or calls. */
function world(options: {
  owners: Record<string, string>;
  features?: Feature[];
  imports?: [string, string][];
  calls?: [string, string][];
  reverse?: boolean;
}) {
  const ids = [...new Set(Object.values(options.owners))];
  const features = options.features ?? ids.map((id) => makeFeature({ id, title: `Title ${id}` }));
  const membership: Manifest["membership"] = {};
  for (const [path, featureId] of Object.entries(options.owners)) {
    membership[memberId(path)] = { featureId, weight: 1 };
  }
  const order = <T>(list: T[]) => (options.reverse ? [...list].reverse() : list);
  const index = {
    imports: order((options.imports ?? []).map(([from, to]) => ({ from, to, line: 1 }))),
    calls: order((options.calls ?? []).map(([from, to]) => ({ from, to, line: 1 }))),
  } as RepoIndex;
  const manifest = makeManifest({ features, membership });
  const members = Object.keys(options.owners).filter((p) => options.owners[p] === "mine");
  return diagramCandidates("mine", manifest, index, members);
}

const refs = (c: DiagramCandidates) => c.nodes.map((n) => n.ref);
const members = (count: number, prefix = "src/a") =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, "0")}.py`);

describe("diagramCandidates rules", () => {
  it("breaks equal-degree ties by code-unit order whatever the order of the index", () => {
    // 17 members of equal degree; the cap keeps 16. Code units put "B" before "a"; a locale
    // compare would put it last and drop it instead of src/a16.py.
    const paths = ["src/B.py", ...members(16)];
    const owners = Object.fromEntries([...paths.map((p) => [p, "mine"]), ["x/other.py", "other"]]);
    const imports = paths.map((p): [string, string] => [p, "x/other.py"]);
    const forward = world({ owners, imports });
    expect(refs(forward).filter((r) => r.startsWith("src"))).toEqual(["src/B.py", ...members(15)]);
    expect(world({ owners, imports, reverse: true })).toEqual(forward);
    expect(world({ owners, imports: [...imports].sort(() => 1) })).toEqual(forward);
  });

  it("keeps at most 16 files and the 6 best-connected neighbouring features", () => {
    const owners: Record<string, string> = { "src/m.py": "mine" };
    const calls: [string, string][] = [];
    for (let g = 0; g < 8; g++) {
      owners[`x/g${g}.py`] = `g${g}`;
      // g0 is called once, g1 twice, ... g7 eight times.
      for (let s = 0; s <= g; s++) calls.push([`src/m.py#f${s}`, `x/g${g}.py#h`]);
    }
    const c = world({ owners, calls });
    expect(c.nodes.filter((n) => n.kind === "feature").map((n) => n.ref)).toEqual([
      "g2",
      "g3",
      "g4",
      "g5",
      "g6",
      "g7",
    ]);
    const many = Object.fromEntries(members(20).map((p) => [p, "mine"]));
    const big = world({
      owners: many,
      imports: members(19).map((p, i) => [p, members(20)[i + 1] ?? p]),
    });
    expect(big.nodes.filter((n) => n.kind === "file")).toHaveLength(16);
  });

  it("keeps at most 60 edges, in id order", () => {
    const paths = members(16);
    const imports = paths.flatMap((a) =>
      paths.filter((b) => b !== a).map((b): [string, string] => [a, b]),
    );
    const c = world({ owners: Object.fromEntries(paths.map((p) => [p, "mine"])), imports });
    expect(c.edges).toHaveLength(60);
    expect(c.edges.slice(0, 2)).toEqual([
      { from: "n1", to: "n2", kind: "imports" },
      { from: "n1", to: "n3", kind: "imports" },
    ]);
  });

  it("leaves out a neighbour that is retired, redirected or has no feature", () => {
    const c = world({
      owners: { "src/m.py": "mine", "x/old.py": "old", "x/live.py": "live" },
      features: [
        makeFeature({ id: "mine" }),
        makeFeature({ id: "old", status: { kind: "retired" } }),
        makeFeature({ id: "live" }),
      ],
      imports: [
        ["src/m.py", "x/old.py"],
        ["src/m.py", "x/live.py"],
        ["src/m.py", "x/unowned.py"],
      ],
    });
    expect(refs(c)).toEqual(["src/m.py", "live"]);
  });

  it("drops self-edges, including calls between symbols of one file", () => {
    const c = world({
      owners: { "src/a.py": "mine", "src/b.py": "mine" },
      imports: [
        ["src/a.py", "src/a.py"],
        ["src/a.py", "src/b.py"],
      ],
      calls: [["src/a.py#f", "src/a.py#g"]],
    });
    expect(c.edges).toEqual([{ from: "n1", to: "n2", kind: "imports" }]);
  });

  it("collapses an import and a call between the same files into one calls edge", () => {
    const c = world({
      owners: { "src/a.py": "mine", "src/b.py": "mine" },
      imports: [["src/a.py", "src/b.py"]],
      calls: [
        ["src/a.py#f", "src/b.py#g"],
        ["src/a.py#h", "src/b.py#g"],
      ],
    });
    expect(c.edges).toEqual([{ from: "n1", to: "n2", kind: "calls" }]);
  });

  it("does not confuse a file named feature:<id> with the feature's node", () => {
    const c = world({
      owners: { "src/m.py": "mine", "feature:x": "other", "y/x.py": "x" },
      imports: [
        ["src/m.py", "y/x.py"],
        ["feature:x", "src/m.py"],
      ],
    });
    expect(c.nodes.map((n) => [n.kind, n.ref])).toEqual([
      ["file", "src/m.py"],
      ["feature", "other"],
      ["feature", "x"],
    ]);
    // The file named feature:x belongs to "other" (n2); feature "x" (n3) owns y/x.py.
    expect(c.edges).toEqual([
      { from: "n1", to: "n3", kind: "imports" },
      { from: "n2", to: "n1", kind: "imports" },
    ]);
  });
});

describe("renderDiagram caps and labels", () => {
  const chain = () => {
    const paths = members(16);
    return world({
      owners: Object.fromEntries(paths.map((p) => [p, "mine"])),
      imports: paths.slice(1).map((p, i): [string, string] => [paths[i] ?? p, p]),
    });
  };

  it("keeps the first 12 nodes a draft names and only edges among them", () => {
    const c = chain();
    expect(c.nodes).toHaveLength(16);
    const source = renderDiagram(
      {
        nodes: c.nodes.map((n) => n.id),
        edges: c.edges.map((e) => ({ from: e.from, to: e.to, label: "next" })),
      },
      c,
    );
    const lines = source?.split("\n") ?? [];
    expect(lines.filter((l) => /^ {2}n\d+\[/.test(l))).toHaveLength(MAX_DIAGRAM_NODES);
    expect(lines.filter((l) => l.includes("-->"))).toHaveLength(MAX_DIAGRAM_NODES - 1);
    expect(lines.join("\n")).not.toContain("n13");
    expect(diagramProblems(source ?? "")).toEqual([]);
  });

  it("shows a node label in full, however long; only edge labels are cut", () => {
    const path = `src/${"d".repeat(60)}/main.py`;
    const c = world({
      owners: { [path]: "mine", "src/b.py": "mine" },
      imports: [[path, "src/b.py"]],
    });
    const source = renderDiagram(
      { nodes: ["n1", "n2"], edges: [{ from: "n2", to: "n1", label: "e".repeat(60) }] },
      c,
    );
    const lines = source?.split("\n") ?? [];
    expect(lines[2]).toBe(`  n2["${path}"]`);
    expect(lines[3]).toBe(`  n2 -->|"${"e".repeat(40)}"| n1`);
  });
});

describe("renderCandidates", () => {
  it("puts every untrusted string through plain(): one capped line per node and edge", () => {
    const c: DiagramCandidates = {
      nodes: [
        { id: "n1", kind: "file", ref: "src/a\n- n9: file forged\u202e.py", label: "x" },
        {
          id: "n2",
          kind: "feature",
          ref: "other",
          label: `Evil\n## heading\u202e${"t".repeat(300)}`,
        },
      ],
      edges: [{ from: "n1", to: "n2", kind: "calls" }],
    };
    const text = renderCandidates(c, plain);
    expect(text.split("\n")).toEqual([
      "nodes:",
      "- n1: file src/a\uFFFD- n9: file forged\uFFFD.py",
      `- n2: feature ${plain(`other (${c.nodes[1]?.label})`)}`,
      "edges:",
      "- n1 -> n2 (calls)",
    ]);
    expect(text.split("\n")[2]?.length).toBeLessThanOrEqual("- n2: feature ".length + 201);
    expect(renderCandidates({ nodes: [], edges: [] }, plain)).toBe("(no candidates)");
  });
});
