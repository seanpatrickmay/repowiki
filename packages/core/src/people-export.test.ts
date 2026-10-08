import { describe, expect, it } from "vitest";
import { WikiExport } from "./export.ts";
import { LedgerEntry, LlmConfigFile, LlmRole, RunKind } from "./llm.ts";
import { contributorsOf, PeopleExport } from "./person.ts";
import {
  makeLedgerEntry,
  makeManifest,
  makePeopleSnapshot,
  makePersonFacts,
  makePersonRevision,
  makeRevision,
  SHA_A,
} from "./test-fixtures.ts";

const people = (overrides: Partial<PeopleExport> = {}): PeopleExport => ({
  snapshot: makePeopleSnapshot(),
  pages: [makePersonRevision()],
  ...overrides,
});

const wiki = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 3,
  repo: "demo",
  head: SHA_A,
  exportedAt: "2026-10-06T12:00:00Z",
  manifest: makeManifest(),
  pages: [makeRevision()],
  history: { signals: [makeRevision()] },
  ...extra,
});

const messages = (value: unknown): string[] => {
  const result = WikiExport.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("WikiExport.people (spec v2 #6 R28)", () => {
  it("defaults to null, so every earlier schema-3 export still parses", () => {
    expect(WikiExport.parse(wiki()).people).toBeNull();
  });

  it("carries the snapshot and the current pages", () => {
    expect(WikiExport.parse(wiki({ people: people() })).people).toEqual(people());
  });

  it("refuses a page for a bot, for someone not in the snapshot, or twice", () => {
    const page = makePersonRevision();
    const bot = makePersonRevision({
      id: "person-dependabot-aaaaaaaaaaaa-1",
      personId: "dependabot",
    });
    const ghost = makePersonRevision({ id: "person-ghost-aaaaaaaaaaaa-1", personId: "ghost" });
    expect(messages(wiki({ people: people({ pages: [bot] }) }))).toEqual([
      "dependabot is not a person of the snapshot with a page",
    ]);
    expect(messages(wiki({ people: people({ pages: [ghost] }) }))).toEqual([
      "ghost is not a person of the snapshot with a page",
    ]);
    expect(messages(wiki({ people: people({ pages: [page, page] }) }))).toEqual([
      "two pages for ada-lovelace",
    ]);
  });

  it("refuses a feature id the manifest lacks", () => {
    const snapshot = makePeopleSnapshot({ featureLines: { ghost: 0, signals: 200 } });
    const [ada, ...rest] = snapshot.people;
    const strayed = {
      ...snapshot,
      people: [
        { ...ada, features: [{ featureId: "ghost", commits: 1, currentLines: 0 }] },
        ...rest,
      ],
    };
    expect(messages(wiki({ people: { snapshot: strayed, pages: [] } }))).toEqual([
      "ghost is not in the manifest",
      "ghost is not in the manifest",
    ]);
  });

  it("has no field that can hold an email (spec v2 #6 §5 rule 3)", () => {
    const leaky = [
      makePeopleSnapshot({ people: [makePersonFacts({ name: "ada@example.com" })] }),
      makePeopleSnapshot({ people: [makePersonFacts({ otherNames: ["x@example.com"] })] }),
      makePeopleSnapshot({
        people: [
          makePersonFacts({
            prsAuthored: [
              { number: 3, title: "From ada@example.com", mergedAt: "2026-01-20T09:00:00Z" },
            ],
          }),
        ],
      }),
    ];
    for (const snapshot of leaky)
      expect(PeopleExport.safeParse({ snapshot, pages: [] }).success).toBe(false);
    expect(JSON.stringify(WikiExport.parse(wiki({ people: people() })))).not.toMatch(/@[a-z]/);
  });
});

describe("the people role and run kind (spec v2 #6 R30, R33)", () => {
  it("adds people to LlmRole and RunKind, so its ledger rows and config parse", () => {
    expect(LlmRole.options).toContain("people");
    expect(RunKind.options).toEqual(["build", "update", "inflight", "people"]);
    const row = makeLedgerEntry({ purpose: "people", runKind: "people", sha: SHA_A });
    expect(LedgerEntry.parse(row)).toEqual(row);
    expect(LlmConfigFile.parse({ models: { people: "claude-haiku-4-5" } }).models).toEqual({
      people: "claude-haiku-4-5",
    });
  });
});

describe("contributorsOf (spec v2 #6 R23)", () => {
  it("lists the humans with lines in the feature, most first, with their shares", () => {
    expect(contributorsOf(people(), "signals")).toEqual({
      contributors: [
        { id: "grace-hopper", name: "Grace Hopper", lines: 110, share: 0.55 },
        { id: "ada-lovelace", name: "Ada Lovelace", lines: 80, share: 0.4 },
      ],
      more: 0,
    });
  });

  it("cuts at the limit and counts the rest", () => {
    expect(contributorsOf(people(), "signals", 1)).toEqual({
      contributors: [{ id: "grace-hopper", name: "Grace Hopper", lines: 110, share: 0.55 }],
      more: 1,
    });
  });

  it("gives nothing for a feature with no blamed lines, an unknown one, or no People", () => {
    const none = { contributors: [], more: 0 };
    const empty = people({ snapshot: makePeopleSnapshot({ featureLines: { signals: 0 } }) });
    expect(contributorsOf(empty, "signals")).toEqual(none);
    expect(contributorsOf(people(), "constructor")).toEqual(none);
    expect(contributorsOf(null, "signals")).toEqual(none);
  });
});
