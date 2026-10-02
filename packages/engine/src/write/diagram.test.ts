import { describe, expect, it } from "vitest";
import { diagramProblems } from "../verify/index.ts";
import {
  type DiagramCandidates,
  diagramCandidates,
  mermaidLabel,
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
  const fromLabels = (edgeLabel: string): DiagramCandidates => ({
    ...all,
    nodes: all.nodes.map((n) => ({ ...n, label: edgeLabel })),
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

describe("mermaidLabel", () => {
  it("is the verifier's escaper, re-exported", () => {
    expect(mermaidLabel('say "hi"')).toBe("say #quot;hi#quot;");
  });
});

describe("diagramCandidates ordering", () => {
  it("breaks weight ties by code-unit order, not locale", () => {
    const { index, manifest } = testWiki();
    const files = ["src/signals/ingest.py", "src/signals/store.py"];
    const reversed = [...files].reverse();
    expect(diagramCandidates("signals", manifest, index, reversed)).toEqual(
      diagramCandidates("signals", manifest, index, files),
    );
  });
});
