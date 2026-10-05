import { isAncestor, resolveCommit } from "@repowiki/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  architectureAt,
  asOfBanner,
  historyBegins,
  parseAsOf,
  pointAt,
  revisionAt,
  viewAt,
} from "./as-of.ts";
import { type HistoryWiki, historyWiki } from "./test-wiki.ts";
import { ToolError } from "./tools.ts";
import { readPage } from "./wiki-page.ts";

let h: HistoryWiki;
let ancestor: (a: string, b: string) => boolean;
let resolve: (prefix: string) => string | null;
let side: string;
beforeAll(() => {
  h = historyWiki();
  ancestor = (a, b) => isAncestor(h.repo.dir, a, b);
  resolve = (prefix) => {
    try {
      return resolveCommit(h.repo.dir, prefix);
    } catch {
      return null;
    }
  };
  // A branch off the first commit: its commit's only wiki ancestor is the first revision.
  h.repo.git("switch", "-q", "-c", "side", h.commits.first);
  h.repo.write("side.txt", "side\n");
  side = h.repo.commit("chore: a side branch");
  h.repo.git("switch", "-q", "main");
});
afterAll(() => h.repo.remove());

const signals = () => h.wiki.history.signals ?? [];
const ids = (r: { id: string } | null) => r?.id ?? null;

describe("parseAsOf", () => {
  it("reads a calendar date, and a short or full sha the repository resolves", () => {
    expect(parseAsOf(" 2026-01-03 ", resolve)).toEqual({ kind: "date", date: "2026-01-03" });
    expect(parseAsOf(h.commits.second.slice(0, 7).toUpperCase(), resolve)).toEqual({
      kind: "commit",
      sha: h.commits.second,
    });
    expect(parseAsOf(h.commits.third, resolve)).toEqual({ kind: "commit", sha: h.commits.third });
  });

  it("refuses an impossible date, an unknown commit and anything else, naming both forms", () => {
    expect(() => parseAsOf("2026-02-30", resolve)).toThrow(
      'as_of "2026-02-30" is not a real date; use a date YYYY-MM-DD or a commit sha of 7 to 40 hex characters',
    );
    expect(() => parseAsOf("fffffff", resolve)).toThrow(
      "no single commit fffffff in the repository; as_of is a date YYYY-MM-DD or a commit sha of 7 to 40 hex characters",
    );
    for (const bad of ["HEAD", "main", "--all", "abc", "2026-1-3", "yesterday", ""]) {
      expect(() => parseAsOf(bad, resolve), bad).toThrow(ToolError);
    }
  });

  it("never passes anything but a hex prefix to the resolver", () => {
    const seen: string[] = [];
    const spy = (prefix: string) => {
      seen.push(prefix);
      return null;
    };
    for (const text of ["HEAD~1", "main", "--output=x", "2026-01-03", "abcdef1"]) {
      try {
        parseAsOf(text, spy);
      } catch {}
    }
    expect(seen).toEqual(["abcdef1"]);
  });
});

describe("revisionAt", () => {
  it("picks the revision current on a date: none before the first, the day's, the last before", () => {
    const at = (date: string) => ids(revisionAt(signals(), { kind: "date", date }, ancestor));
    expect(at("2026-01-01")).toBeNull();
    expect(at("2026-01-02")).toBe("signals-1");
    expect(at("2026-01-03")).toBe("signals-2");
    expect(at("2026-01-04")).toBe("signals-3");
    expect(at("2026-12-31")).toBe("signals-3");
  });

  it("picks the revision made at a commit, else the last whose commit is its ancestor", () => {
    const at = (sha: string) => ids(revisionAt(signals(), { kind: "commit", sha }, ancestor));
    expect(at(h.commits.second)).toBe("signals-2");
    expect(at(h.commits.after)).toBe("signals-3");
    expect(at(side)).toBe("signals-1");
    const deliverables = h.wiki.history.deliverables ?? [];
    expect(revisionAt(deliverables, { kind: "commit", sha: h.commits.first }, ancestor)).toBeNull();
  });

  it("does the same for the About article", () => {
    const at = (date: string) =>
      architectureAt(h.wiki.architecture, { kind: "date", date }, ancestor)?.sha ?? null;
    expect(at("2026-01-03")).toBe(h.commits.first);
    expect(at("2026-01-04")).toBe(h.commits.third);
  });
});

describe("viewAt", () => {
  it("serves each page as it was, with its history up to then", () => {
    const view = viewAt(h.wiki, { kind: "date", date: "2026-01-03" }, ancestor);
    expect(view.pages.get("signals")?.id).toBe("signals-2");
    expect(view.pages.get("deliverables")?.id).toBe("deliverables-1");
    expect(view.wiki.history.signals?.map((r) => r.id)).toEqual(["signals-1", "signals-2"]);
    expect(view.article?.sha).toBe(h.commits.first);
    const page = readPage(view, "signals");
    expect(page).toContain("Ingestion stops after `MAX_SIGNALS` (100) signals.");
    expect(page).toContain(
      "Page history, oldest first: 2026-01-02 commit d08c5a4 (build); 2026-01-03 commit 594d833 (update, pull request #7)",
    );
  });

  it("leaves out a feature with no page yet, and gives a renamed feature its old title", () => {
    const first = viewAt(h.wiki, { kind: "date", date: "2026-01-02" }, ancestor);
    expect([...first.pages.keys()]).toEqual(["signals"]);
    expect(() => readPage(first, "deliverables")).toThrow(/no page "deliverables"/);
    const second = viewAt(h.wiki, { kind: "commit", sha: h.commits.second }, ancestor);
    expect(second.title("deliverables")).toBe("Deliverable records");
    const third = viewAt(h.wiki, { kind: "commit", sha: h.commits.third }, ancestor);
    expect(third.title("deliverables")).toBe("Deliverables");
  });

  it("finds the commit the wiki stood at on a date", () => {
    expect(pointAt(h.wiki, { kind: "date", date: "2026-01-01" })).toBeNull();
    expect(pointAt(h.wiki, { kind: "date", date: "2026-01-03" })).toBe(h.commits.second);
    expect(pointAt(h.wiki, { kind: "date", date: "2030-01-01" })).toBe(h.commits.third);
  });
});

describe("asOfBanner and historyBegins", () => {
  it("names the revision, the current one, and the lineage up to then", () => {
    const deliverables = h.wiki.history.deliverables ?? [];
    const old = deliverables[0];
    if (old === undefined) throw new Error("fixture");
    expect(
      asOfBanner(h.wiki, "deliverables", old, { kind: "date", date: "2026-01-03" }, ancestor),
    ).toEqual([
      "This is the page as of 2026-01-03: revision 1 of 2, commit 594d833, 2026-01-03. The current revision is 2026-01-04 (commit 3d751d3).",
      "Lineage up to then: created at commit 594d833. 1 later lineage event is on the current page.",
    ]);
    const now = deliverables[1];
    if (now === undefined) throw new Error("fixture");
    expect(
      asOfBanner(
        h.wiki,
        "deliverables",
        now,
        { kind: "commit", sha: h.commits.third },
        ancestor,
      )[1],
    ).toBe(
      'Lineage up to then: created at commit 594d833; renamed from "Deliverable records" at commit 3d751d3.',
    );
  });

  it("says where a page's history begins", () => {
    const first = (h.wiki.history.deliverables ?? [])[0];
    if (first === undefined) throw new Error("fixture");
    expect(historyBegins("deliverables", first)).toBe(
      "The wiki's history of deliverables begins on 2026-01-03 (commit 594d833).\n",
    );
  });
});
