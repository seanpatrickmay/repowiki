import type { WikiExport } from "@repowiki/core";
import { isAncestor, resolveCommit } from "@repowiki/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsOf,
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

  it("orders commit dates by time, not by text, when their offsets differ", () => {
    // Both are written on 2026-01-03; the second is later in real time but sorts first as text.
    const [one, two, three] = signals();
    if (one === undefined || two === undefined || three === undefined) throw new Error("fixture");
    const wiki: WikiExport = {
      ...h.wiki,
      history: {
        signals: [
          { ...one, commitDate: "2026-01-03T01:00:00+09:00" },
          { ...two, commitDate: "2026-01-03T00:30:00-05:00" },
          { ...three, commitDate: "2026-01-05T00:00:00Z" },
        ],
      },
      architecture: [],
    };
    expect(pointAt(wiki, { kind: "date", date: "2026-01-03" })).toBe(h.commits.second);
  });

  it("gives each feature the status and aliases it had then (R5)", () => {
    // signals is retired at the third commit; deliverables is merged into it at `after`.
    const [signalsNow, deliverablesNow] = h.wiki.manifest.features;
    if (signalsNow === undefined || deliverablesNow === undefined) throw new Error("fixture");
    const wiki: WikiExport = {
      ...h.wiki,
      manifest: {
        ...h.wiki.manifest,
        features: [
          {
            ...signalsNow,
            status: { kind: "retired" },
            lineage: [...signalsNow.lineage, { kind: "retire", sha: h.commits.third }],
          },
          {
            ...deliverablesNow,
            status: { kind: "redirect", to: "signals" },
            lineage: [
              ...deliverablesNow.lineage,
              { kind: "merge", sha: h.commits.after, into: "signals" },
            ],
          },
        ],
      },
    };
    const at = (asOf: AsOf) => {
      const view = viewAt(wiki, asOf, ancestor);
      const feature = (id: string) => {
        const f = view.features.get(id);
        return { title: f?.title, aliases: f?.aliases, status: f?.status.kind };
      };
      return { signals: feature("signals"), deliverables: feature("deliverables") };
    };
    const second = at({ kind: "commit", sha: h.commits.second });
    expect(second).toEqual({
      signals: { title: "Signal ingestion", aliases: [], status: "active" },
      deliverables: { title: "Deliverable records", aliases: [], status: "active" },
    });
    expect(at({ kind: "date", date: "2026-01-03" })).toEqual(second);
    const third = at({ kind: "commit", sha: h.commits.third });
    expect(third).toEqual({
      signals: { title: "Signal ingestion", aliases: [], status: "retired" },
      deliverables: {
        title: "Deliverables",
        aliases: ["Deliverable records"],
        status: "active",
      },
    });
    expect(at({ kind: "date", date: "2026-01-04" })).toEqual(third);
    expect(at({ kind: "commit", sha: h.commits.after }).deliverables).toEqual({
      title: "Deliverables",
      aliases: ["Deliverable records"],
      status: "redirect",
    });
  });

  it("ends the About article's revisions at the point", () => {
    const shas = (date: string) =>
      viewAt(h.wiki, { kind: "date", date }, ancestor).wiki.architecture.map((a) => a.sha);
    expect(shas("2026-01-01")).toEqual([]);
    expect(shas("2026-01-03")).toEqual([h.commits.first]);
    expect(shas("2026-01-04")).toEqual([h.commits.first, h.commits.third]);
    const onSide = viewAt(h.wiki, { kind: "commit", sha: side }, ancestor);
    expect(onSide.wiki.architecture.map((a) => a.sha)).toEqual([h.commits.first]);
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

  it("numbers a copy of a revision (one taken from a view as of a point) as the revision it is", () => {
    const old = (h.wiki.history.deliverables ?? [])[0];
    if (old === undefined) throw new Error("fixture");
    const banner = asOfBanner(
      h.wiki,
      "deliverables",
      { ...old },
      { kind: "date", date: "2026-01-03" },
      ancestor,
    );
    expect(banner[0]).toMatch(/^This is the page as of 2026-01-03: revision 1 of 2, /);
  });

  it("says where a page's history begins", () => {
    const first = (h.wiki.history.deliverables ?? [])[0];
    if (first === undefined) throw new Error("fixture");
    expect(historyBegins("deliverables", first)).toBe(
      "The wiki's history of deliverables begins on 2026-01-03 (commit 594d833).\n",
    );
  });
});
