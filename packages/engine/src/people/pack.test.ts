import { type Manifest, PeopleConfig } from "@repowiki/core";
import { makeFeature } from "@repowiki/core/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRepo, type TestRepo } from "../index/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { ancestorsOf, PERSON_BUDGET_TOKENS, packFor, packText } from "./pack.ts";
import { type Refreshed, refreshPeople } from "./refresh.ts";

const ADA = { name: "Ada Lovelace", email: "ada.q7pack@example.com" };
const BOB = { name: "Bob Smith", email: "bob@example.com" };
const KIM = { name: "Kim Filler", email: "kim@example.com" };

// The tests only read the fixture, so it is built once.
let repo: TestRepo;
let store: Store;
let built: ReturnType<typeof build>;
beforeAll(() => {
  repo = createTestRepo();
  store = openStore(":memory:");
  built = build();
});
afterAll(() => {
  store.close();
  repo.remove();
});
const history = () => built;

/** Ada: a January commit, PR #3 merged by Bob, a February commit; she merges Bob's PR #6. */
async function build() {
  repo.write("src/signals/ingest.py", "a = 1\n");
  const jan = repo.commit("feat: start signals", "+0100", ADA);
  repo.git("switch", "-q", "-c", "topic");
  repo.write("src/signals/ingest.py", "a = 1\nb = 2\n");
  const a1 = repo.commit("feat: parse chunks", "+0100", ADA);
  repo.write("src/deliverables/crud.py", "x = 1\n");
  const a2 = repo.commit("feat: store chunks, mail ada.q7pack@example.com", "+0100", ADA);
  repo.git("switch", "-q", "main");
  const pr3 = repo.merge(
    "topic",
    "Merge pull request #3 from ada/topic\n\nAdd signal ingestion",
    BOB,
  );
  repo.git("switch", "-q", "-c", "topic2");
  repo.write("src/deliverables/crud.py", "x = 2\n");
  const b1 = repo.commit("fix: crud", "+0000", BOB);
  repo.git("switch", "-q", "main");
  const pr6 = repo.merge("topic2", "Merge pull request #6 from bob/topic2\n\nFix crud", ADA);
  for (let i = 0; i < 30; i++) {
    repo.write("docs/filler.md", `${i}\n`);
    repo.commit(`docs: filler ${i}`, "+0000", KIM);
  }
  repo.write("src/signals/ingest.py", "a = 1\nb = 3\n");
  const feb = repo.commit("fix: signals \u202E\u2028 edge", "+0100", ADA);
  const manifest: Manifest = {
    sha: feb,
    features: [
      makeFeature({
        id: "signals",
        title: "Signal ingestion",
        aliases: [],
        lineage: [{ kind: "create", sha: jan }],
      }),
      makeFeature({
        id: "deliverables",
        title: "Deliverables",
        aliases: [],
        lineage: [{ kind: "create", sha: jan }],
      }),
    ],
    membership: {
      "src/signals/ingest.py": { featureId: "signals", weight: 1 },
      "src/deliverables/crud.py": { featureId: "deliverables", weight: 1 },
    },
  };
  store.putManifest(manifest);
  store.setHead(feb);
  const refreshed = await refreshPeople({
    repo: repo.dir,
    sha: feb,
    store,
    config: PeopleConfig.parse({}),
    ownerEmail: null,
  });
  return { jan, a1, a2, pr3, b1, pr6, feb, manifest, refreshed };
}

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
