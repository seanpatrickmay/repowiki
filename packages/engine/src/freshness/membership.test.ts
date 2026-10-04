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
