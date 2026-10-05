import type { InFlightFeature, Manifest } from "@repowiki/core";
import { makeFeature, makeGitHubIssue, SHA_A } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { type ClosingPull, mapIssues, type Suggest } from "./issues.ts";

const manifest: Manifest = {
  sha: SHA_A,
  features: [
    makeFeature({ id: "signals", title: "Signal ingestion", aliases: ["signal pipeline", "UI"] }),
    makeFeature({ id: "deliverables", title: "Deliverables", aliases: ["work items", "Docs"] }),
    makeFeature({ id: "scheduler", title: "Scheduler", aliases: [] }),
    makeFeature({
      id: "exporter",
      title: "CSV exporter",
      aliases: [],
      status: { kind: "retired" },
      lineage: [
        { kind: "create", sha: SHA_A },
        { kind: "retire", sha: SHA_A },
      ],
    }),
  ],
  membership: {
    "src/signals/ingest.py": { featureId: "signals", weight: 1 },
    "src/signals/index.ts": { featureId: "signals", weight: 1 },
    "src/web/index.ts": { featureId: "deliverables", weight: 1 },
    "src/deliverables/crud.py": { featureId: "deliverables", weight: 1 },
    "src/scheduler/cron.py": { featureId: "scheduler", weight: 1 },
  },
};

const feature = (featureId: string, changedLines: number, files = 1): InFlightFeature => ({
  featureId,
  files,
  changedLines,
  added: 0,
  removed: 0,
  churn: 0,
  drifts: false,
});

const map = (
  overrides: Parameters<typeof makeGitHubIssue>[0],
  pulls: ClosingPull[] = [],
  suggest?: Suggest,
) =>
  mapIssues(
    [makeGitHubIssue({ title: "x", body: "", labels: [], ...overrides })],
    pulls,
    manifest,
    suggest,
  )[0];

describe("mapIssues (R12)", () => {
  it("maps through a closing pull request holding at least a quarter of its lines", () => {
    const pulls = [
      {
        number: 12,
        closes: [7],
        features: [feature("signals", 60), feature("deliverables", 10), feature("scheduler", 30)],
      },
    ];
    expect(map({}, pulls)).toMatchObject({
      features: [
        { featureId: "signals", kind: "pull", detail: "#12" },
        { featureId: "scheduler", kind: "pull", detail: "#12" },
      ],
      pulls: [12],
    });
  });

  it("uses file shares for a closing pull request whose head was not fetched", () => {
    const pulls = [
      {
        number: 3,
        closes: [7],
        features: [feature("signals", 0, 1), feature("deliverables", 0, 3)],
      },
    ];
    expect(map({}, pulls)?.features.map((e) => e.featureId)).toEqual(["deliverables", "signals"]);
  });

  it.each([
    [
      "a member path in the title",
      { title: "Crash in src/signals/ingest.py." },
      "signals",
      "src/signals/ingest.py",
    ],
    [
      "a member path in the body",
      { body: "See ./src/deliverables/crud.py, line 4" },
      "deliverables",
      "src/deliverables/crud.py",
    ],
    [
      "a basename only one member has",
      { title: "cron.py runs twice" },
      "scheduler",
      "src/scheduler/cron.py",
    ],
  ])("maps by path: %s", (_name, overrides, featureId, path) => {
    expect(map(overrides)?.features).toEqual([{ featureId, kind: "path", detail: path }]);
  });

  it("ignores a basename two members share", () => {
    expect(map({ title: "index.ts is slow" })?.features).toEqual([]);
  });

  it.each([
    ["a title", { title: "Signal ingestion drops sentences" }, "signals", "Signal ingestion"],
    [
      "an alias, in any case",
      { body: "the WORK ITEMS list is empty" },
      "deliverables",
      "work items",
    ],
    ["an id", { title: "scheduler: run at midnight" }, "scheduler", "scheduler"],
  ])("maps by name: %s", (_name, overrides, featureId, name) => {
    expect(map(overrides)?.features).toEqual([{ featureId, kind: "name", detail: name }]);
  });

  it("never matches a short name, a stop-word name, part of a word, or a retired feature", () => {
    for (const title of [
      "The UI is broken",
      "Docs are out of date",
      "Deliverablesx",
      "CSV exporter crashes",
    ])
      expect(map({ title })?.features, title).toEqual([]);
  });

  it("maps by label, minus an area: or feature: prefix", () => {
    expect(map({ labels: ["area:signals"] })?.features).toEqual([
      { featureId: "signals", kind: "label", detail: "area:signals" },
    ]);
    expect(map({ labels: ["feature:Work Items"] })?.features[0]?.featureId).toBe("deliverables");
    expect(map({ labels: ["bug", "area:ghost"] })?.features).toEqual([]);
  });

  it("reads only the body's first 2,000 characters", () => {
    expect(map({ body: `${"x ".repeat(1000)}Scheduler` })?.features).toEqual([]);
    expect(map({ body: `${"x ".repeat(990)}Scheduler` })?.features[0]?.featureId).toBe("scheduler");
  });

  it("orders evidence strongest first, one per feature, at most three", () => {
    const pulls = [{ number: 12, closes: [7], features: [feature("signals", 10)] }];
    const issue = map(
      {
        title: "Scheduler and Deliverables break src/signals/ingest.py",
        labels: ["area:signals", "area:scheduler"],
      },
      pulls,
    );
    expect(issue?.features.map((e) => [e.featureId, e.kind])).toEqual([
      ["signals", "pull"],
      ["scheduler", "name"],
      ["deliverables", "name"],
    ]);
  });

  it("suggests the top search hit for an unmapped issue only when it is strong and clear", () => {
    const hits =
      (...scores: [string, number][]): Suggest =>
      () =>
        scores.map(([featureId, score]) => ({ featureId, score }));
    expect(map({}, [], hits(["scheduler", 6], ["signals", 3]))?.features).toEqual([
      { featureId: "scheduler", kind: "search", detail: "score 6.0" },
    ]);
    expect(map({}, [], hits(["scheduler", 6], ["signals", 5]))?.features).toEqual([]);
    expect(map({}, [], hits(["scheduler", 2]))?.features).toEqual([]);
    expect(map({}, [], hits(["exporter", 9]))?.features).toEqual([]);
    // An issue other evidence maps is not searched at all.
    let asked = false;
    map({ title: "Scheduler" }, [], () => {
      asked = true;
      return [];
    });
    expect(asked).toBe(false);
  });

  it("keeps hostile text as plain evidence and lists an unmapped issue with none", () => {
    const issue = map({ title: "<script>alert(1)</script>", labels: ["<b>x</b>"] });
    expect(issue?.features).toEqual([]);
    expect(issue?.title).toBe("<script>alert(1)</script>");
  });
});
