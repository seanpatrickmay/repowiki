import { makeFeature, makeManifest } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import type { FileChange } from "../index/index.ts";
import { coverageGaps, nextMembership, placeNewFiles } from "./membership.ts";
import { indexedFile, indexOf } from "./test-index.ts";

/** signals owns src/signals/ingest.py (and its symbol), deliverables src/deliverables/crud.py. */
const previous = makeManifest({
  features: [
    makeFeature(),
    makeFeature({ id: "deliverables", title: "Deliverables", aliases: [] }),
    makeFeature({
      id: "old",
      title: "Old",
      aliases: [],
      status: { kind: "retired" },
      lineage: [
        { kind: "create", sha: "a".repeat(40) },
        { kind: "retire", sha: "a".repeat(40) },
      ],
    }),
  ],
  membership: {
    "src/signals/ingest.py": { featureId: "signals", weight: 0.9 },
    "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 },
    "src/deliverables/crud.py": { featureId: "deliverables", weight: 0.7 },
  },
});
const ingest = indexedFile("src/signals/ingest.py", [["ingest_chunk", 10, 24]]);
const crud = indexedFile("src/deliverables/crud.py");

describe("placeNewFiles", () => {
  it("decides a new file when every signal with an opinion agrees", () => {
    const index = indexOf(
      [ingest, crud, indexedFile("src/deliverables/routes.py")],
      [["src/deliverables/routes.py", "src/deliverables/crud.py"]],
    );
    expect(placeNewFiles(previous, index, [])).toEqual({
      decided: new Map([["src/deliverables/routes.py", "deliverables"]]),
      disputed: [],
    });
  });

  it("disputes a new file whose import and directory disagree", () => {
    const index = indexOf(
      [ingest, crud, indexedFile("src/signals/bridge.py")],
      [["src/signals/bridge.py", "src/deliverables/crud.py"]],
    );
    expect(placeNewFiles(previous, index, []).disputed).toEqual([
      { path: "src/signals/bridge.py", candidates: ["deliverables", "signals"] },
    ]);
  });

  it("counts co-changes, and looks up the directory tree when the file's own has no member", () => {
    const index = indexOf(
      [ingest, crud, indexedFile("src/signals/sub/deep.py"), indexedFile("docs/notes.md")],
      [],
      [["docs/notes.md", "src/deliverables/crud.py", 3]],
    );
    const placement = placeNewFiles(previous, index, []);
    expect(placement.decided.get("src/signals/sub/deep.py")).toBe("signals");
    expect(placement.disputed).toEqual([]);
    expect(placement.decided.get("docs/notes.md")).toBe("deliverables");
  });

  it("disputes a file no signal reaches between every active feature", () => {
    const index = indexOf([ingest, crud, indexedFile("README.md")]);
    expect(placeNewFiles(previous, index, []).disputed).toEqual([
      { path: "README.md", candidates: ["deliverables", "signals"] },
    ]);
  });

  it("disputes a new file whose one signal ties between two features", () => {
    const index = indexOf(
      [ingest, crud, indexedFile("lib/bridge.py")],
      [
        ["lib/bridge.py", "src/signals/ingest.py"],
        ["lib/bridge.py", "src/deliverables/crud.py"],
      ],
    );
    expect(placeNewFiles(previous, index, []).disputed).toEqual([
      { path: "lib/bridge.py", candidates: ["deliverables", "signals"] },
    ]);
  });

  it("reads an import either way: a new file a member imports goes to the member's feature", () => {
    const index = indexOf(
      [ingest, crud, indexedFile("lib/helpers.py")],
      [["src/deliverables/crud.py", "lib/helpers.py"]],
    );
    expect(placeNewFiles(previous, index, []).decided).toEqual(
      new Map([["lib/helpers.py", "deliverables"]]),
    );
  });

  it("lists the disputed files in path order", () => {
    const index = indexOf([
      ingest,
      crud,
      indexedFile("z.md"),
      indexedFile("a.md"),
      indexedFile("m.md"),
    ]);
    expect(placeNewFiles(previous, index, []).disputed.map((d) => d.path)).toEqual([
      "a.md",
      "m.md",
      "z.md",
    ]);
  });

  it("leaves a renamed member file alone", () => {
    const moved = indexedFile("src/signals/chunks.py", [["ingest_chunk", 10, 24]]);
    const rename: FileChange = {
      status: "renamed",
      oldPath: "src/signals/ingest.py",
      newPath: "src/signals/chunks.py",
      hunks: [],
      binary: false,
    };
    const placement = placeNewFiles(previous, indexOf([moved, crud]), [rename]);
    expect(placement).toEqual({ decided: new Map(), disputed: [] });
  });
});

describe("nextMembership", () => {
  const graph = {
    nodes: [],
    edges: [
      { a: "src/deliverables/crud.py", b: "src/deliverables/routes.py", weight: 3 },
      { a: "src/deliverables/routes.py", b: "src/signals/ingest.py", weight: 1 },
    ],
  };

  it("keeps known members, moves a renamed file's members and weighs new files", () => {
    const moved = indexedFile("src/signals/chunks.py", [
      ["ingest_chunk", 10, 24],
      ["split", 30, 40],
    ]);
    const routes = indexedFile("src/deliverables/routes.py", [["route", 1, 5]]);
    const test = indexedFile("tests/test_routes.py");
    const changes: FileChange[] = [
      {
        status: "renamed",
        oldPath: "src/signals/ingest.py",
        newPath: "src/signals/chunks.py",
        hunks: [],
        binary: false,
      },
    ];
    const membership = nextMembership(
      previous,
      indexOf([moved, crud, routes, test]),
      changes,
      graph,
      new Map([
        ["src/deliverables/routes.py", "deliverables"],
        ["tests/test_routes.py", "deliverables"],
      ]),
    );
    expect(membership).toEqual({
      "src/signals/chunks.py": { featureId: "signals", weight: 0.9 },
      "src/signals/chunks.py#ingest_chunk": { featureId: "signals", weight: 0.9 },
      "src/signals/chunks.py#split": { featureId: "signals", weight: 0.9 },
      "src/deliverables/crud.py": { featureId: "deliverables", weight: 0.7 },
      // 3 of its 4 edge weight stays in deliverables; a code file's role is 1.
      "src/deliverables/routes.py": { featureId: "deliverables", weight: 0.75 },
      "src/deliverables/routes.py#route": { featureId: "deliverables", weight: 0.75 },
      // No edges: the lowest centrality, times a test's role of 0.5.
      "tests/test_routes.py": { featureId: "deliverables", weight: 0.025 },
    });
  });

  it("drops a deleted file and its symbols", () => {
    const membership = nextMembership(previous, indexOf([crud]), [], graph, new Map());
    expect(Object.keys(membership)).toEqual(["src/deliverables/crud.py"]);
  });

  it("throws for a new file nothing placed", () => {
    expect(() =>
      nextMembership(previous, indexOf([ingest, indexedFile("x.py")]), [], graph, new Map()),
    ).toThrow("no feature for the new file x.py");
  });
});

describe("coverageGaps", () => {
  const noGraph = { nodes: [], edges: [] };

  it("lists a renamed file's new symbols, not the ones it had under its old path", () => {
    const moved = indexedFile("src/signals/chunks.py", [
      ["ingest_chunk", 10, 24],
      ["split", 30, 40],
    ]);
    const changes: FileChange[] = [
      {
        status: "renamed",
        oldPath: "src/signals/ingest.py",
        newPath: "src/signals/chunks.py",
        hunks: [],
        binary: false,
      },
    ];
    const index = indexOf([moved, crud]);
    const membership = nextMembership(previous, index, changes, noGraph, new Map());
    expect(coverageGaps(previous, index, changes, membership, new Map())).toEqual(
      new Map([
        [
          "signals",
          [{ path: "src/signals/chunks.py", symbol: "split", startLine: 30, endLine: 40 }],
        ],
      ]),
    );
  });

  it("counts a public module-level constant of a Python file as a gap, as R23 reads", () => {
    const grown = indexedFile("src/signals/ingest.py", [["ingest_chunk", 10, 24]]);
    grown.symbols.push({
      id: "src/signals/ingest.py#MAX_SIGNALS",
      qualifiedName: "MAX_SIGNALS",
      kind: "variable",
      startLine: 3,
      endLine: 3,
      exported: true,
    });
    const index = indexOf([grown, crud]);
    const membership = nextMembership(previous, index, [], noGraph, new Map());
    expect(coverageGaps(previous, index, [], membership, new Map()).get("signals")).toEqual([
      { path: "src/signals/ingest.py", symbol: "MAX_SIGNALS", startLine: 3, endLine: 3 },
    ]);
  });

  it("gives each feature its gaps in path, then line order", () => {
    const index = indexOf([
      indexedFile("src/signals/ingest.py", [
        ["ingest_chunk", 10, 24],
        ["early", 30, 35],
        ["late", 90, 95],
      ]),
      indexedFile("src/signals/b.py", [["b_one", 1, 2]]),
      indexedFile("src/deliverables/crud.py", [["complete", 4, 7]]),
      indexedFile("src/deliverables/a.py", [["a_one", 1, 2]]),
    ]);
    const placed = new Map([
      ["src/signals/b.py", "signals"],
      ["src/deliverables/a.py", "deliverables"],
    ]);
    const membership = nextMembership(previous, index, [], noGraph, placed);
    const gaps = coverageGaps(previous, index, [], membership, new Map());
    const listed = (id: string) => gaps.get(id)?.map((g) => `${g.path}#${g.symbol}`);
    expect(listed("deliverables")).toEqual([
      "src/deliverables/a.py#a_one",
      "src/deliverables/crud.py#complete",
    ]);
    // The indexer gives a file's symbols in line order, and the gaps keep it.
    expect(listed("signals")).toEqual([
      "src/signals/b.py#b_one",
      "src/signals/ingest.py#early",
      "src/signals/ingest.py#late",
    ]);
  });

  it("lists new top-level exported symbols of source files that no fresh citation covers", () => {
    const grown = indexedFile("src/signals/ingest.py", [
      ["ingest_chunk", 10, 24],
      ["drain", 30, 40],
      ["batch", 50, 60],
      ["_private", 70, 75, false],
      ["Queue.push", 80, 85],
    ]);
    const test = indexedFile("tests/test_ingest.py", [["test_drain", 1, 5]]);
    const index = indexOf([grown, crud, test]);
    const membership = nextMembership(
      previous,
      index,
      [],
      { nodes: [], edges: [] },
      new Map([["tests/test_ingest.py", "signals"]]),
    );
    const cited = new Map([["src/signals/ingest.py", [{ start: 55, end: 56 }]]]);
    expect(coverageGaps(previous, index, [], membership, cited)).toEqual(
      new Map([
        [
          "signals",
          [{ path: "src/signals/ingest.py", symbol: "drain", startLine: 30, endLine: 40 }],
        ],
      ]),
    );
  });
});
