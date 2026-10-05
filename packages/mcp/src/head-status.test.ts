import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_FILE_BYTES, diffCommits, readSources, remapClaims } from "@repowiki/engine";
import { type HistoryWiki, historyWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFreshness } from "./head-status.ts";

let h: HistoryWiki;
beforeAll(() => {
  h = historyWiki();
});
afterAll(() => h.repo.remove());

const page = (featureId: string) => {
  const found = h.wiki.pages.find((p) => p.featureId === featureId);
  if (found === undefined) throw new Error(`no page ${featureId}`);
  return found;
};

describe("createFreshness: the head status", () => {
  it("compares the wiki's head with HEAD: commits ahead and behind, changed and added files", () => {
    const status = createFreshness({ repo: h.repo.dir, wikiHead: h.sha, pinned: null }).status();
    expect(status).toEqual({
      compare: h.commits.after,
      wikiHead: h.sha,
      known: true,
      ahead: 1,
      behind: 0,
      changedFiles: new Set(["src/signals/ingest.py", "src/signals/store.py"]),
      addedFiles: new Set(),
    });
  });

  it("re-resolves HEAD on every call unless the compare commit is pinned", () => {
    const followed = createFreshness({ repo: h.repo.dir, wikiHead: h.sha, pinned: null });
    const pinned = createFreshness({ repo: h.repo.dir, wikiHead: h.sha, pinned: h.sha });
    expect(pinned.status()).toMatchObject({ compare: h.sha, ahead: 0, behind: 0 });
    expect(pinned.status().changedFiles.size).toBe(0);
    h.repo.write("notes/new.md", "new\n");
    const next = h.repo.commit("docs: add notes");
    try {
      expect(followed.status()).toMatchObject({ compare: next, ahead: 2, behind: 0 });
      expect(followed.status().addedFiles).toEqual(new Set(["notes/new.md"]));
      expect(pinned.status().compare).toBe(h.sha);
    } finally {
      h.repo.git("reset", "-q", "--hard", h.commits.after);
    }
  });

  it("counts a compare commit behind the wiki's head", () => {
    const status = createFreshness({
      repo: h.repo.dir,
      wikiHead: h.sha,
      pinned: h.commits.first,
    }).status();
    expect(status).toMatchObject({ known: true, ahead: 0, behind: 2 });
    expect(status.addedFiles).toEqual(new Set());
    expect(status.changedFiles).toEqual(
      new Set(["src/deliverables/crud.py", "src/signals/ingest.py"]),
    );
  });

  it("is unknown when the repository lacks the wiki's head", () => {
    const status = createFreshness({
      repo: h.repo.dir,
      wikiHead: "f".repeat(40),
      pinned: null,
    }).status();
    expect(status).toMatchObject({ known: false, ahead: 0, behind: 0 });
    const freshness = createFreshness({ repo: h.repo.dir, wikiHead: "f".repeat(40), pinned: null });
    expect(freshness.marks("signals-3", page("signals").sections).size).toBe(0);
  });
});

describe("createFreshness: per-claim marks", () => {
  it("marks moved and changed claims, and a lead that summarizes a changed one", () => {
    const freshness = createFreshness({ repo: h.repo.dir, wikiHead: h.sha, pinned: null });
    const marks = freshness.marks("signals-3", page("signals").sections);
    expect(Object.fromEntries(marks)).toEqual({
      "s-1": { kind: "moved", citations: 1 },
      "s-2": { kind: "moved", citations: 1 },
      "s-3": {
        kind: "changed",
        reasons: ["src/signals/store.py:6-8: the cited lines changed"],
      },
      "s-lead": {
        kind: "changed",
        reasons: ["it summarizes 1 claim below that changed, in Overview"],
      },
    });
    expect(freshness.marks("deliverables-2", page("deliverables").sections).size).toBe(0);
  });

  it("marks exactly the claims wiki:update's remapClaims would find stale", async () => {
    const compare = h.commits.after;
    const ctx = {
      sha: compare,
      changesSince: (from: string) => diffCommits(h.repo.dir, from, compare),
      sources: await readSources(h.repo.dir, compare, 1 << 20),
      symbolsOf: () => [],
    };
    const touched = new Set(["src/signals/ingest.py", "src/signals/store.py"]);
    const freshness = createFreshness({ repo: h.repo.dir, wikiHead: h.sha, pinned: compare });
    for (const featureId of ["signals", "deliverables"]) {
      const { id, sections } = page(featureId);
      const stale = remapClaims(sections, ctx, touched)
        .filter((r) => r.status === "stale")
        .map((r) => r.claim.id)
        .sort();
      const changed = [...freshness.marks(id, sections)]
        .filter(([, mark]) => mark.kind === "changed")
        .map(([claimId]) => claimId)
        .sort();
      expect(changed, featureId).toEqual(stale);
    }
  });

  it("reads sources within wiki:update's file-size limit, so a file grown past it is marked", async () => {
    const crudNow = readFileSync(join(h.repo.dir, "src/deliverables/crud.py"), "utf8");
    // The cited lines stay as they are; the file grows to between the limit and 2 MiB.
    h.repo.write("src/deliverables/crud.py", `${crudNow}${"# padding\n".repeat(150_000)}`);
    const grown = h.repo.commit("chore: pad crud.py");
    try {
      const ctx = {
        sha: grown,
        changesSince: (from: string) => diffCommits(h.repo.dir, from, grown),
        sources: await readSources(h.repo.dir, grown, DEFAULT_MAX_FILE_BYTES),
        symbolsOf: () => [],
      };
      const { id, sections } = page("deliverables");
      const stale = remapClaims(sections, ctx, new Set(["src/deliverables/crud.py"]))
        .filter((r) => r.status === "stale")
        .map((r) => r.claim.id)
        .sort();
      expect(stale.length).toBeGreaterThan(0);
      const freshness = createFreshness({ repo: h.repo.dir, wikiHead: h.sha, pinned: grown });
      const changed = [...freshness.marks(id, sections)]
        .filter(([, mark]) => mark.kind === "changed")
        .map(([claimId]) => claimId)
        .sort();
      expect(changed).toEqual(stale);
    } finally {
      h.repo.git("reset", "-q", "--hard", h.commits.after);
    }
  });

  it("says where a cited range is now: unchanged, moved, changed, or unknown", () => {
    const freshness = createFreshness({ repo: h.repo.dir, wikiHead: h.sha, pinned: null });
    const cited = page("signals").sections.flatMap((s) =>
      s.claims.flatMap((c) => c.citations.flatMap((x) => (x.kind === "code" ? [x] : []))),
    );
    const [ingest, store, limit] = cited;
    if (ingest === undefined || limit === undefined || store === undefined)
      throw new Error("fixture");
    expect(freshness.citationNow(ingest)).toEqual({
      kind: "moved",
      path: "src/signals/ingest.py",
      startLine: 12,
      endLine: 26,
    });
    expect(freshness.citationNow(limit)).toMatchObject({ kind: "moved", startLine: 9 });
    expect(freshness.citationNow(store)).toEqual({ kind: "changed", path: "src/signals/store.py" });
    const crud = page("deliverables").sections[1]?.claims[0]?.citations[0];
    if (crud?.kind !== "code") throw new Error("fixture");
    expect(freshness.citationNow(crud)).toEqual({
      kind: "unchanged",
      path: "src/deliverables/crud.py",
      startLine: 4,
      endLine: 6,
    });
    const lost = createFreshness({ repo: h.repo.dir, wikiHead: "f".repeat(40), pinned: null });
    expect(lost.citationNow(crud)).toEqual({
      kind: "unknown",
      why: "the repository does not hold the wiki's commit",
    });
  });
});
