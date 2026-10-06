import { describe, expect, it } from "vitest";
import { WikiExport } from "./export.ts";
import type { Revision } from "./revision.ts";
import {
  architectureClaim,
  makeArchitecture,
  makeInFlight,
  makeInFlightIssue,
  makeInFlightPull,
  makeManifest,
  makeRevision,
  SHA_A,
  SHA_B,
} from "./test-fixtures.ts";

const first = makeRevision();
const second = makeRevision({ id: "rev-2", parentId: "rev-1", reason: "update", sha: SHA_B });

function makeExport(overrides: Partial<WikiExport> = {}): WikiExport {
  return {
    schemaVersion: 3,
    repo: "next-chief-of-staff",
    head: SHA_B,
    exportedAt: "2026-09-30T21:00:00Z",
    manifest: makeManifest(),
    pages: [second],
    history: { signals: [first, second] },
    wikipedia: {},
    architecture: [],
    runs: [],
    inflight: null,
    people: null,
    ...overrides,
  };
}

function messages(wiki: unknown): string[] {
  const result = WikiExport.safeParse(wiki);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("WikiExport", () => {
  it("carries each run's token totals, and defaults them to none", () => {
    const runs = [
      {
        kind: "build" as const,
        sha: SHA_B,
        calls: 3,
        tokens: { in: 9, out: 3, cacheRead: 1, cacheWrite: 0 },
      },
    ];
    expect(WikiExport.parse(makeExport({ runs })).runs).toEqual(runs);
    const { runs: _omitted, ...without } = makeExport();
    expect(WikiExport.parse(without).runs).toEqual([]);
    const pathsOf = (bad: Record<string, unknown>): string[] => {
      const result = WikiExport.safeParse({ ...makeExport(), runs: [{ ...runs[0], ...bad }] });
      return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
    };
    expect(pathsOf({ kind: "replay" })).toEqual(["runs.0.kind"]);
    expect(pathsOf({ sha: "not-a-sha" })).toEqual(["runs.0.sha"]);
    expect(pathsOf({ calls: -1 })).toEqual(["runs.0.calls"]);
  });

  it("carries the Architecture article's revisions, and defaults them to none", () => {
    const architecture = [makeArchitecture({ basis: [second.id], edges: [] })];
    expect(WikiExport.parse(makeExport({ architecture })).architecture).toEqual(architecture);
    const { architecture: _omitted, ...without } = makeExport();
    expect(WikiExport.parse(without).architecture).toEqual([]);
  });

  it("chains the Architecture revisions by parent", () => {
    const first = makeArchitecture({ edges: [] });
    const next = makeArchitecture({
      id: "architecture-aaaaaaaaaaaa-2",
      parentId: "architecture-aaaaaaaaaaaa-1",
      edges: [],
    });
    expect(messages(makeExport({ architecture: [first, next] }))).toEqual([]);
    expect(messages(makeExport({ architecture: [first, { ...next, parentId: null }] }))).toEqual([
      "architecture revision architecture-aaaaaaaaaaaa-2 must have parent architecture-aaaaaaaaaaaa-1",
    ]);
  });

  it("refuses two Architecture revisions with one id", () => {
    const first = makeArchitecture({ edges: [] });
    const again = { ...first, parentId: first.id };
    expect(messages(makeExport({ architecture: [first, again] }))).toEqual([
      "duplicate architecture revision id architecture-aaaaaaaaaaaa-1",
    ]);
  });

  it("refuses a current Architecture article that names a feature without a page", () => {
    const article = makeArchitecture();
    const sections = [
      ...article.sections.slice(0, 2),
      {
        key: "dependencies" as const,
        claims: [architectureClaim({ id: "a-2", citations: [], pages: ["deliverables"] })],
      },
    ];
    expect(messages(makeExport({ architecture: [{ ...article, sections }] }))).toEqual([
      "architecture claim a-2 names deliverables, which has no page",
      "architecture edge deliverables -> signals joins a feature with no page",
    ]);
  });

  it("carries a work-in-flight snapshot, and defaults it to null (spec v2 #9 R14)", () => {
    const inflight = makeInFlight();
    expect(WikiExport.parse(makeExport({ inflight })).inflight).toEqual(inflight);
    const { inflight: _omitted, ...without } = makeExport();
    expect(WikiExport.parse(without).inflight).toBeNull();
  });

  it("refuses a snapshot naming a feature the manifest lacks", () => {
    const pull = makeInFlightPull();
    const ghost = { ...pull.features[0], featureId: "ghost" } as (typeof pull.features)[number];
    const issue = makeInFlightIssue({
      features: [{ featureId: "ghost", kind: "name", detail: "x" }],
    });
    const inflight = makeInFlight({
      pulls: [{ ...pull, features: [...pull.features, ghost], summary: null }],
      issues: [issue],
    });
    expect(messages(makeExport({ inflight }))).toEqual([
      "ghost is not in the manifest",
      "ghost is not in the manifest",
    ]);
  });

  it("checks effects against the current pages only when derived at the export's head", () => {
    // Derived against SHA_A, an older head than the export's SHA_B: shown as stale, not refused.
    expect(messages(makeExport({ inflight: makeInFlight({ wikiHead: SHA_A }) }))).toEqual([]);
    expect(messages(makeExport({ inflight: makeInFlight({ wikiHead: SHA_B }) }))).toEqual([
      "claim c-1 is not on the current page of signals",
      "claim lead-1 is not on the current page of signals",
    ]);
    const current = makeInFlightPull({
      effects: makeInFlightPull().effects.map((e) => ({ ...e, revisionId: "rev-2" })),
    });
    const inflight = makeInFlight({ wikiHead: SHA_B, pulls: [current] });
    expect(messages(makeExport({ inflight }))).toEqual([]);
  });

  it("accepts a consistent export with full revision bodies in history", () => {
    expect(WikiExport.parse(makeExport())).toEqual(makeExport());
  });

  it("rejects schema version 2, which had no Wikipedia summaries", () => {
    expect(messages({ ...makeExport(), schemaVersion: 2 })).toHaveLength(1);
  });

  it("carries Wikipedia summaries, and defaults them to none", () => {
    const summary = {
      title: "Message queue",
      extract: "A message queue is a form of asynchronous communication.",
      url: "https://en.wikipedia.org/wiki/Message_queue",
    };
    const wiki = makeExport({ wikipedia: { "Message queue": summary } });
    expect(WikiExport.parse(wiki).wikipedia).toEqual({ "Message queue": summary });
    const { wikipedia: _omitted, ...without } = makeExport();
    expect(WikiExport.parse(without).wikipedia).toEqual({});
  });

  it.each([
    ["a non-Wikipedia URL", { url: "javascript:alert(1)" }],
    ["another site", { url: "https://evil.example/wiki/X" }],
    ["an over-long extract", { extract: "x".repeat(1201) }],
  ])("rejects a summary with %s", (_name, overrides) => {
    const summary = {
      title: "X",
      extract: "x",
      url: "https://en.wikipedia.org/wiki/X",
      ...overrides,
    };
    expect(messages(makeExport({ wikipedia: { X: summary } }))).toHaveLength(1);
  });

  it("rejects schema version 1, whose history held metadata only", () => {
    const result = WikiExport.safeParse({ ...makeExport(), schemaVersion: 1 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["schemaVersion"]);
  });

  it("rejects pages for features missing from the manifest", () => {
    const page = makeRevision({ featureId: "ghost" });
    expect(messages(makeExport({ pages: [page], history: { ghost: [page] } }))).toContain(
      "ghost is not in the manifest",
    );
  });

  it("requires each page to be the last entry of its history", () => {
    expect(messages(makeExport({ history: { signals: [first] } }))).toContain(
      "history for signals must end with page rev-2",
    );
  });

  it("rejects two pages for the same feature", () => {
    expect(messages(makeExport({ pages: [second, second] }))).toEqual(["two pages for signals"]);
  });

  it("rejects a history revision filed under another feature", () => {
    const stray: Revision = { ...first, featureId: "deliverables" };
    expect(messages(makeExport({ history: { signals: [stray, second] } }))).toContain(
      "history for signals holds revision rev-1 of deliverables",
    );
  });

  it("rejects a history whose parent chain is broken", () => {
    const orphan = makeRevision({ id: "rev-2", parentId: "rev-x", reason: "update" });
    expect(
      messages(makeExport({ pages: [orphan], history: { signals: [first, orphan] } })),
    ).toEqual(["revision rev-2 must have parent rev-1"]);
  });

  it("rejects a history that starts with a parented revision", () => {
    expect(messages(makeExport({ history: { signals: [second] } }))).toEqual([
      "revision rev-2 must have parent null",
    ]);
  });

  it("rejects a history with no page", () => {
    const wiki = makeExport({ history: { signals: [first, second], deliverables: [first] } });
    expect(messages(wiki)).toContain("history for deliverables has no page");
  });
});
