import { Revision, Section, type SectionKey } from "@repowiki/core";
import { bodyClaim, commitCitation, leadClaim, makeRevision } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import type { CommitInfo } from "../index/index.ts";
import { computeInfobox, pageSections } from "./page.ts";
import { testWiki } from "./test-wiki.ts";

const claims = (entries: [SectionKey, ReturnType<typeof bodyClaim>[]][]) => new Map(entries);

describe("pageSections", () => {
  it("orders sections, renumbers claims lead first, and maps supports", () => {
    const sections = pageSections(
      claims([
        ["history", [bodyClaim({ id: "h1", kind: "history" })]],
        ["lead", [leadClaim({ id: "l1", supports: ["o1", "h1", "o1"] })]],
        ["overview", [bodyClaim({ id: "o1" }), bodyClaim({ id: "o2" })]],
      ]),
    );
    expect(sections?.map((s) => [s.key, s.claims.map((c) => [c.id, c.supports])])).toEqual([
      ["lead", [["c1", ["c2", "c4"]]]],
      [
        "overview",
        [
          ["c2", []],
          ["c3", []],
        ],
      ],
      ["history", [["c4", []]]],
    ]);
  });

  it("drops lead claims whose supported claims were all dropped", () => {
    const sections = pageSections(
      claims([
        [
          "lead",
          [leadClaim({ id: "l1", supports: ["gone"] }), leadClaim({ id: "l2", supports: ["o1"] })],
        ],
        ["overview", [bodyClaim({ id: "o1" })]],
      ]),
    );
    expect(sections?.[0]?.claims.map((c) => c.id)).toEqual(["c1"]);
  });

  it("keeps only the supports that name surviving body claims", () => {
    const sections = pageSections(
      claims([
        ["lead", [leadClaim({ id: "l1", supports: ["gone", "o2", "l1"] })]],
        ["overview", [bodyClaim({ id: "o1" }), bodyClaim({ id: "o2" })]],
      ]),
    );
    expect(sections?.[0]?.claims.map((c) => c.supports)).toEqual([["c3"]]);
  });

  it("resolves supports against body ids even when a lead claim shares an id with a body claim", () => {
    const sections = pageSections(
      claims([
        ["lead", [leadClaim({ id: "x", supports: ["x"] })]],
        ["overview", [bodyClaim({ id: "x" })]],
      ]),
    );
    expect(sections?.map((s) => s.claims.map((c) => [c.id, c.supports]))).toEqual([
      [["c1", ["c2"]]],
      [["c2", []]],
    ]);
  });

  it("leaves out empty sections", () => {
    const sections = pageSections(
      claims([
        ["lead", [leadClaim({ supports: ["c-1"] })]],
        ["overview", [bodyClaim()]],
        ["data-flow", []],
      ]),
    );
    expect(sections?.map((s) => s.key)).toEqual(["lead", "overview"]);
  });

  it("is null without a lead or without a body", () => {
    expect(pageSections(claims([["overview", [bodyClaim()]]]))).toBeNull();
    expect(
      pageSections(
        claims([
          ["lead", [leadClaim()]],
          ["overview", []],
        ]),
      ),
    ).toBeNull();
  });

  it("produces sections the core schema accepts", () => {
    const sections = pageSections(
      claims([
        ["lead", [leadClaim({ supports: ["c-1"] })]],
        ["overview", [bodyClaim()]],
      ]),
    );
    for (const section of sections ?? []) expect(Section.parse(section)).toEqual(section);
  });

  it("produces a page the revision schema accepts, with every lead support naming a body claim", () => {
    const sections = pageSections(
      claims([
        ["history", [bodyClaim({ id: "h1", kind: "history", citations: [commitCitation()] })]],
        [
          "lead",
          [
            leadClaim({ id: "l1", supports: ["o2", "h1"] }),
            leadClaim({ id: "l2", supports: ["gone"] }),
          ],
        ],
        ["overview", [bodyClaim({ id: "o1" }), bodyClaim({ id: "o2" })]],
      ]),
    );
    expect(sections).not.toBeNull();
    const revision = Revision.parse(makeRevision({ sections: sections ?? [] }));
    const ids = revision.sections.flatMap((s) => s.claims.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    const bodyIds = new Set(revision.sections.slice(1).flatMap((s) => s.claims.map((c) => c.id)));
    for (const claim of revision.sections[0]?.claims ?? []) {
      expect(claim.supports.length).toBeGreaterThan(0);
      for (const id of claim.supports) expect(bodyIds.has(id)).toBe(true);
    }
  });
});

describe("computeInfobox", () => {
  it("counts member files and lines, names languages, finds entry points and commit dates", () => {
    const { index, manifest, history } = testWiki();
    expect(computeInfobox("signals", manifest, index, history, "2026-03-01T00:00:00Z")).toEqual({
      files: 3,
      loc: 31 + 2 + 3,
      languages: ["Python", "Markdown"],
      entryPoints: ["src/signals/ingest.py"],
      firstCommitDate: "2026-01-26T09:00:00-05:00",
      lastCommitDate: "2026-02-03T10:00:00-05:00",
    });
  });

  it("falls back to the build commit's date when no commit touched the feature", () => {
    const { index, manifest } = testWiki();
    const box = computeInfobox("deliverables", manifest, index, [], "2026-03-01T00:00:00Z");
    expect(box).toMatchObject({
      entryPoints: ["src/deliverables/crud.py"],
      firstCommitDate: "2026-03-01T00:00:00Z",
      lastCommitDate: "2026-03-01T00:00:00Z",
    });
  });

  it("ignores commits that touched no member file", () => {
    const { index, manifest, history } = testWiki();
    const elsewhere: CommitInfo = {
      sha: `c${"1".repeat(39)}`,
      parents: [],
      date: "2026-02-20T10:00:00-05:00",
      subject: "docs: unrelated",
      files: ["README.md"],
      pr: null,
    };
    const box = computeInfobox(
      "signals",
      manifest,
      index,
      [elsewhere, ...history],
      "2026-03-01T00:00:00Z",
    );
    expect(box.lastCommitDate).toBe("2026-02-03T10:00:00-05:00");
    expect(
      computeInfobox("signals", manifest, index, [elsewhere], "2026-03-01T00:00:00Z"),
    ).toMatchObject({
      firstCommitDate: "2026-03-01T00:00:00Z",
      lastCommitDate: "2026-03-01T00:00:00Z",
    });
  });

  it("orders commit dates by instant, not by list position or string order", () => {
    const { index, manifest } = testWiki();
    const commit = (date: string): CommitInfo => ({
      sha: `d${"1".repeat(39)}`,
      parents: [],
      date,
      subject: "feat: x",
      files: ["src/signals/store.py"],
      pr: null,
    });
    // As strings the -05:00 date sorts first, but it is the later instant.
    const earlier = "2026-02-03T01:00:00+05:00";
    const later = "2026-02-02T22:00:00-05:00";
    const middle = "2026-02-03T00:00:00Z";
    const box = computeInfobox(
      "signals",
      manifest,
      index,
      [commit(middle), commit(later), commit(earlier)],
      "2026-03-01T00:00:00Z",
    );
    expect(box.firstCommitDate).toBe(earlier);
    expect(box.lastCommitDate).toBe(later);
  });

  it("skips commit dates that are not ISO 8601 date-times", () => {
    const { index, manifest, history } = testWiki();
    const bad: CommitInfo = { ...(history[0] as CommitInfo), date: "last tuesday" };
    const box = computeInfobox(
      "signals",
      manifest,
      index,
      [bad, ...history],
      "2026-03-01T00:00:00Z",
    );
    expect(box.firstCommitDate).toBe("2026-01-26T09:00:00-05:00");
    expect(box.lastCommitDate).toBe("2026-02-03T10:00:00-05:00");
  });
});
