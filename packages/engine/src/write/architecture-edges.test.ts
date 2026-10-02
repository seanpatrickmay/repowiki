import { makeFeature } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { diagramProblems, MAX_DIAGRAM_CHARS } from "../verify/index.ts";
import {
  architectureDiagram,
  crossFeatureEdges,
  edgeWeightLabel,
  MAX_ARCHITECTURE_EDGES,
  MAX_ARCHITECTURE_NODES,
} from "./architecture-edges.ts";
import { testWiki } from "./test-wiki.ts";

const both = new Set(["signals", "deliverables"]);

describe("crossFeatureEdges", () => {
  it("counts the imports and calls from one feature's files into another's, with their lines", () => {
    const { index, manifest } = testWiki();
    expect(crossFeatureEdges(index, manifest, both)).toEqual([
      {
        from: "deliverables",
        to: "signals",
        imports: 1,
        calls: 1,
        sites: [
          { path: "src/deliverables/crud.py", line: 1, kind: "import" },
          { path: "src/deliverables/crud.py", line: 7, kind: "call" },
        ],
      },
    ]);
  });

  it("leaves out edges inside a feature and to a feature outside the set", () => {
    const { index, manifest } = testWiki();
    expect(crossFeatureEdges(index, manifest, new Set(["signals"]))).toEqual([]);
  });

  it("leaves out edges of a retired or redirected feature, even inside the set", () => {
    const { index, manifest } = testWiki();
    for (const status of [
      { kind: "retired" as const },
      { kind: "redirect" as const, to: "deliverables" },
    ]) {
      const features = manifest.features.map((f) => (f.id === "signals" ? { ...f, status } : f));
      expect(crossFeatureEdges(index, { ...manifest, features }, both)).toEqual([]);
    }
  });

  it("orders edges heaviest first and keeps the first two sites of each", () => {
    const { index, manifest } = testWiki();
    const crud = "src/deliverables/crud.py";
    index.calls.push(
      { from: `${crud}#complete`, to: "src/signals/store.py#save_signal", line: 6 },
      { from: "src/signals/ingest.py#ingest_chunk", to: `${crud}#complete`, line: 12 },
    );
    const edges = crossFeatureEdges(index, manifest, both);
    expect(edges.map((e) => [e.from, e.to, e.calls, e.imports])).toEqual([
      ["deliverables", "signals", 2, 1],
      ["signals", "deliverables", 1, 0],
    ]);
    expect(edges[0]?.sites.map((s) => s.line)).toEqual([1, 6]);
  });

  it("breaks weight ties by from, then to, in code-unit order, whatever the index order", () => {
    const { index, manifest } = testWiki();
    const template = manifest.features[0];
    if (template === undefined) throw new Error("no feature");
    const ids = ["zeta", "Alpha", "alpha", "beta"];
    const membership: typeof manifest.membership = {};
    const imports = ids.flatMap((from) =>
      ids
        .filter((to) => to !== from)
        .map((to) => ({ from: `src/${from}.py`, to: `src/${to}.py`, line: 1 })),
    );
    for (const id of ids) membership[`src/${id}.py`] = { featureId: id, weight: 1 };
    const features = ids.map((id) => ({ ...template, id }));
    const big = { ...manifest, features, membership };
    const among = new Set(ids);
    const order = (list: typeof imports) =>
      crossFeatureEdges({ ...index, imports: list, calls: [] }, big, among).map(
        (e) => `${e.from}>${e.to}`,
      );
    const forward = order(imports);
    expect(forward.slice(0, 3)).toEqual(["Alpha>alpha", "Alpha>beta", "Alpha>zeta"]);
    expect(forward).toEqual([...forward].sort());
    expect(order([...imports].reverse())).toEqual(forward);
  });

  it("finds nothing in a repository with no cross-feature edge", () => {
    const { index, manifest } = testWiki();
    index.imports = [];
    index.calls = [];
    expect(crossFeatureEdges(index, manifest, both)).toEqual([]);
  });
});

describe("edgeWeightLabel", () => {
  it("names calls and imports with no zero part", () => {
    expect(edgeWeightLabel({ from: "a", to: "b", calls: 3, imports: 1 })).toBe("3 calls, 1 import");
    expect(edgeWeightLabel({ from: "a", to: "b", calls: 0, imports: 2 })).toBe("2 imports");
  });
});

describe("architectureDiagram", () => {
  const features = [
    { id: "signals", title: "Signal ingestion" },
    { id: "deliverables", title: "Deliverables" },
  ];

  it("draws each feature as a node and each edge with its weight, as verify accepts", () => {
    const source = architectureDiagram(
      [{ from: "deliverables", to: "signals", imports: 1, calls: 1 }],
      features,
    );
    expect(source).toBe(
      [
        "flowchart LR",
        '  n1[["Deliverables"]]',
        '  n2[["Signal ingestion"]]',
        '  n1 -->|"1 call, 1 import"| n2',
      ].join("\n"),
    );
    expect(diagramProblems(source ?? "")).toEqual([]);
  });

  it("is null with no edge or a single feature", () => {
    expect(architectureDiagram([], features)).toBeNull();
    expect(
      architectureDiagram(
        [{ from: "deliverables", to: "signals", imports: 1, calls: 0 }],
        features.slice(0, 1),
      ),
    ).toBeNull();
  });

  it("escapes hostile titles so verify still accepts the source", () => {
    const hostile = [
      { id: "a", title: '"]] --> x\nclick a "javascript:alert(1)" %%{init}%% <img src=x>' },
      { id: "b", title: "\u202E" },
    ];
    const source = architectureDiagram([{ from: "a", to: "b", imports: 1, calls: 0 }], hostile);
    expect(source).not.toBeNull();
    expect(diagramProblems(source ?? "")).toEqual([]);
    expect(source).toContain('  n2[["b"]]');
  });

  it("falls back to the feature id, then to a fixed word, for a title that escapes to nothing", () => {
    const source = architectureDiagram(
      [{ from: "a", to: "\u200B", imports: 1, calls: 0 }],
      [
        { id: "a", title: "\u200B\u202E" },
        { id: "\u200B", title: "" },
      ],
    );
    expect(source).toContain('  n1[["a"]]');
    expect(source).toContain('  n2[["feature"]]');
    expect(diagramProblems(source ?? "")).toEqual([]);
  });

  it("passes verify for every combination of hostile titles", () => {
    const pieces = [
      '"',
      "'",
      "[",
      "]",
      "[[",
      "]]",
      "(",
      ")",
      "{",
      "}",
      "<",
      ">",
      "<img src=x onerror=alert(1)>",
      "#",
      "#quot;",
      "#59;",
      "&amp;",
      "&#35;",
      ";",
      ":",
      "%%",
      "%%{init: {}}%%",
      "$$",
      "$x^2$",
      "-->",
      "|",
      "\\",
      "`",
      "\n",
      "\r\n",
      "\t",
      "\u0000",
      "\u0085",
      "\u2028",
      "\u2029",
      "\u00A0",
      "\u202E",
      "\u202A",
      "\u2066",
      "\u200B",
      "\u200F",
      "\uFEFF",
      "\u00AD",
      "\uE000",
      "\uE001",
      "\uD800",
      "\u00DF",
      "\uFB02",
      "\uFB02°°",
      "¶",
      "°",
      "\u{1F600}",
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
      "é",
      "\u0301",
      "中文",
      "click a href",
      "classDef x fill:#f00",
      "n1@{ img: x }",
      " ",
      "a",
      "Z",
      "7",
      ".-_/+!?@*",
    ];
    // A small deterministic generator, so a failure replays.
    let state = 0x2545f491;
    const next = (bound: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % bound;
    };
    const titles = [
      ...pieces,
      ...pieces.map((p) => p.repeat(200)),
      "x".repeat(200),
      "\u00DF".repeat(200),
      "\u{1F600}".repeat(200),
      Array.from({ length: 200 }, () => pieces[next(pieces.length)])
        .join("")
        .slice(0, 200),
      ...Array.from({ length: 300 }, () =>
        Array.from({ length: 1 + next(8) }, () => pieces[next(pieces.length)]).join(""),
      ),
    ];
    for (let i = 0; i < titles.length; i += 2) {
      const pair = [
        { id: "left", title: titles[i] ?? "" },
        { id: "right", title: titles[i + 1] ?? "" },
      ];
      const source = architectureDiagram(
        [{ from: "left", to: "right", imports: 1, calls: 2 }],
        pair,
      );
      expect(source, JSON.stringify(pair)).not.toBeNull();
      expect(diagramProblems(source ?? ""), JSON.stringify(pair)).toEqual([]);
    }
  });

  it("keeps the 40 best-connected of 70 features and the 80 heaviest edges, under verify's caps", () => {
    const many = Array.from({ length: 70 }, (_, i) => {
      const id = `feature-${String(i).padStart(2, "0")}`;
      return makeFeature({ id, title: `Feature ${i} with a long descriptive title` });
    });
    const edges = many.flatMap((f, i) =>
      many
        .slice(i + 1, i + 4)
        .map((g, j) => ({ from: f.id, to: g.id, imports: 1, calls: 70 - i + j })),
    );
    edges.sort((x, y) => y.calls + y.imports - (x.calls + x.imports));
    const source = architectureDiagram(edges, many) ?? "";
    const lines = source.split("\n");
    expect(lines.filter((l) => l.includes("[[")).length).toBe(MAX_ARCHITECTURE_NODES);
    expect(lines.filter((l) => l.includes("-->")).length).toBe(MAX_ARCHITECTURE_EDGES);
    expect(source).toContain('[["Feature 0 with a long descriptive title"]]');
    expect(source).not.toContain('[["Feature 69 with a long descriptive title"]]');
    expect(source.length).toBeLessThan(MAX_DIAGRAM_CHARS);
    expect(diagramProblems(source)).toEqual([]);
  });
});
