import type { Manifest } from "@repowiki/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ancestorsOf, PERSON_BUDGET_TOKENS, packFor, packText } from "./pack.ts";
import type { Refreshed } from "./refresh.ts";
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
