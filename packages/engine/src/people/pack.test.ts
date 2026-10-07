import type { Manifest, PeopleSnapshot, PersonFacts } from "@repowiki/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthoredCommit } from "../index/index.ts";
import { ancestorsOf, buildPersonPack, PERSON_BUDGET_TOKENS, packFor, packText } from "./pack.ts";
import type { Refreshed } from "./refresh.ts";
import type { Landing } from "./snapshot.ts";
import { type TeamFixture, teamFixture } from "./test-people.ts";

// The tests only read the fixture, so it is built once.
let fx: TeamFixture;
beforeAll(async () => {
  fx = await teamFixture();
});
afterAll(() => fx.remove());
const history = async () => fx;

const pack = (r: Refreshed, m: Manifest, options = {}) => {
  const p = packFor(r, "ada-lovelace", m, options);
  if (p === null) throw new Error("Ada has a pack");
  return p;
};

describe("buildPersonPack (spec v2 #6 §8.2)", () => {
  it("lays out the person, their features and their episodes oldest first", async () => {
    const fx = await history();
    const p = pack(fx.refreshed, fx.manifest);
    const s = (sha: string) => sha.slice(0, 12);
    expect(p.text.split("\n")).toEqual([
      "# Person: Ada Lovelace",
      "Active between 2026-01-02 and 2026-02-07 (author dates).",
      "## Features (id — title — their commits — share of current lines)",
      "- signals — Signal ingestion — 3 — 100%",
      "- deliverables — Deliverables — 1 — 0%",
      "## Episodes, oldest first",
      "### Commits outside pull requests, 2026-01",
      `- commit:${s(fx.jan)} 2026-01-02 "feat: start signals" — features: signals — files: src/signals/ingest.py`,
      `### PR #3 "Add signal ingestion", 2026-01-03 to 2026-01-04, merged 2026-01-05 (commit:${s(fx.pr3)})`,
      `- commit:${s(fx.a1)} 2026-01-03 "feat: parse chunks" — features: signals — files: src/signals/ingest.py`,
      `- commit:${s(fx.a2)} 2026-01-04 "feat: store chunks, mail [email]" — features: deliverables — files: src/deliverables/crud.py`,
      "### Commits outside pull requests, 2026-02",
      `- commit:${s(fx.feb)} 2026-02-07 "fix: signals \uFFFD edge" — features: signals — files: src/signals/ingest.py`,
      `### Pull requests they merged: #6 "Fix crud" 2026-01-07 (commit:${s(fx.pr6)})`,
    ]);
    expect(p.episodes).toEqual({ full: 3, collapsed: 0, dropped: 0 });
    expect(p.basis).toBe(fx.feb);
  });

  it("makes exactly the shown shas citable: her commits, her PR's merge and the merges she made", async () => {
    const fx = await history();
    const p = pack(fx.refreshed, fx.manifest);
    expect([...p.shas].sort()).toEqual([fx.jan, fx.a1, fx.a2, fx.pr3, fx.pr6, fx.feb].sort());
    expect(p.shas.has(fx.b1)).toBe(false);
    expect(p.dates.get(fx.pr6)).toBe("2026-01-07T00:00:00Z");
    expect(p.dates.get(fx.feb)).toBe("2026-02-07T01:00:00+01:00");
  });

  it("collapses the oldest episodes first, then drops them, and cites only what it still shows", async () => {
    const fx = await history();
    const whole = pack(fx.refreshed, fx.manifest);
    const collapsed = pack(fx.refreshed, fx.manifest, { budgetTokens: whole.tokens - 30 });
    expect(collapsed.episodes.collapsed).toBeGreaterThan(0);
    expect(collapsed.text).toContain(
      `- Commits outside pull requests, 2026-01, 2026-01-02, 1 commit: commit:${fx.jan.slice(0, 12)}`,
    );
    const tiny = pack(fx.refreshed, fx.manifest, { budgetTokens: 1 });
    expect(tiny.episodes).toEqual({ full: 0, collapsed: 0, dropped: 3 });
    expect(tiny.text).toContain("- and 3 earlier episodes");
    expect([...tiny.shas]).toEqual([fx.pr6]);
  });

  it("shows only the episodes after the stored narrative's basis for an append (R25)", async () => {
    const fx = await history();
    const covered = ancestorsOf(fx.refreshed.commits, fx.pr6);
    const p = pack(fx.refreshed, fx.manifest, { covered });
    expect(p.text).toContain("## New episodes, oldest first");
    expect(p.text).not.toContain("PR #3");
    expect(p.text).not.toContain("Pull requests they merged");
    expect([...p.shas]).toEqual([fx.feb]);
  });

  it("is null for an id with no person, and stays under the budget by default", async () => {
    const fx = await history();
    expect(packFor(fx.refreshed, "nobody", fx.manifest)).toBeNull();
    expect(pack(fx.refreshed, fx.manifest).tokens).toBeLessThan(PERSON_BUDGET_TOKENS);
  });
});

describe("packText", () => {
  it("is one line with no email and no structure-forging character, cut short", () => {
    expect(packText("a\nb\u0085c ada@example.com")).toBe("a b c [email]");
    expect(packText("x".repeat(300))).toHaveLength(200);
  });
});

/** A synthetic pack input: Ada's commits as given, every landing hers. */
function synthetic(commits: AuthoredCommit[], landings: Landing[] = [], budgetTokens?: number) {
  const person = {
    id: "ada",
    name: "Ada",
    otherNames: [],
    firstCommit: "2020-01-01T00:00:00Z",
    lastCommit: "2030-01-01T00:00:00Z",
    features: [],
  } as unknown as PersonFacts;
  return buildPersonPack({
    person,
    group: 0,
    commits: [...commits].reverse(),
    groupOf: () => 0,
    commitFeatures: new Map(),
    landings: new Map(landings.map((l) => [l.number, l])),
    prAuthors: new Map(landings.map((l) => [l.number, 0])),
    snapshot: { sha: "f".repeat(40), featureLines: {} } as unknown as PeopleSnapshot,
    manifest: { features: [] } as unknown as Manifest,
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
  });
}
const hex = (n: number) => n.toString(16).padStart(40, "0");
const commit = (n: number, date: string, subject: string, pr: number | null = null) =>
  ({
    sha: hex(n),
    parents: [hex(n - 1)],
    authorName: "Ada",
    authorEmail: "ada@example.com",
    authorDate: date,
    commitDate: date,
    subject,
    mergeTitle: null,
    files: [{ path: "a.py", added: 1, deleted: 0 }],
    pr,
  }) as AuthoredCommit;

describe("buildPersonPack against hostile and large histories", () => {
  const hostile = 'x, {range}, merged 2030-01-01 (commit:bbbbbbbbbbbb) "Kim" ada@example.com';
  const landing = {
    number: 3,
    sha: hex(900),
    title: hostile,
    mergedAt: "2026-01-09T00:00:00Z",
    merger: 0,
  };
  const commits = [
    commit(1, "2026-01-03T00:00:00Z", hostile, 3),
    commit(2, "2026-01-08T00:00:00Z", "{range}", 3),
  ];
  const title = `"x, {range}, merged 2030-01-01 (commit:bbbbbbbbbbbb) 'Kim' [email]"`;

  it("builds a pull request's heading from its parts, so a title's {range} is only text", () => {
    const p = synthetic(commits, [landing]);
    const heading = p.text.split("\n").find((l) => l.startsWith("### PR #3"));
    expect(heading).toBe(
      `### PR #3 ${title}, 2026-01-03 to 2026-01-08, merged 2026-01-09 (commit:${hex(900).slice(0, 12)})`,
    );
    expect(p.text).toContain(`"{range}" — features`);
  });

  it("collapses the same heading with its title whole and its quote closed", () => {
    const whole = synthetic(commits, [landing]);
    const p = synthetic(commits, [landing], whole.tokens - 20);
    expect(p.episodes.collapsed).toBe(1);
    expect(p.text.split("\n")).toContain(
      `- PR #3 ${title}, 2026-01-03–2026-01-08, 2 commits: commit:${hex(1).slice(0, 12)} … commit:${hex(2).slice(0, 12)} (merged: commit:${hex(900).slice(0, 12)})`,
    );
  });

  it("lists the 50 merged pull requests that landed last, in landing order", () => {
    const merged = Array.from({ length: 60 }, (_, i) => ({
      number: i + 1,
      sha: hex(1000 + i),
      title: null,
      // Low numbers land last: #1 lands in 2026-03, #60 in 2026-01.
      mergedAt: new Date(Date.UTC(2026, 0, 1) + (60 - i) * 86_400_000).toISOString(),
      merger: 0,
    }));
    const p = synthetic([commit(1, "2026-01-01T00:00:00Z", "start")], merged);
    const line = p.text.split("\n").find((l) => l.startsWith("### Pull requests they merged"));
    const listed = [...(line ?? "").matchAll(/#(\d+) /g)].map((m) => Number(m[1]));
    expect(listed).toEqual(Array.from({ length: 50 }, (_, i) => 50 - i));
    expect(p.shas.has(hex(1000 + 59))).toBe(false);
  });

  it("builds a 6,000-commit pack in linear time, its token count the text's", () => {
    const many = Array.from({ length: 6048 }, (_, i) =>
      commit(i + 1, new Date(Date.UTC(1990, 0, 1) + i * 2.5 * 86_400_000).toISOString(), `c ${i}`),
    );
    const started = performance.now();
    const p = synthetic(many);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(p.tokens).toBe(Math.ceil(p.text.length / 2.5));
    expect(p.tokens).toBeLessThanOrEqual(PERSON_BUDGET_TOKENS);
    expect(p.episodes.dropped).toBeGreaterThan(0);
  });
});

describe("packText's bounds", () => {
  it("cuts a long unbroken token before scrubbing it, in well under a second", () => {
    const started = performance.now();
    expect(packText("a".repeat(80_000))).toHaveLength(200);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("scrubs an address the cut would split, and never ends on half a surrogate pair", () => {
    expect(packText(`${"x".repeat(190)} ada@example.com`)).toBe(`${"x".repeat(190)} [email]`);
    const cut = packText("\u{1F600}".repeat(150));
    expect(cut.isWellFormed()).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
  });
});
