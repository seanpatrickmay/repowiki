import { CLAIM_TEXT_MAX_LENGTH, Revision, Section, type SectionKey } from "@repowiki/core";
import {
  bodyClaim,
  commitCitation,
  leadClaim,
  makeFeature,
  makeRevision,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import type { CommitInfo } from "../index/index.ts";
import { verifyClaim } from "../verify/index.ts";
import { buildPack } from "./pack.ts";
import { assembleRevision, computeInfobox, pageSections, type RevisionParts } from "./page.ts";
import { signalsDraft } from "./test-provider.ts";
import { testVerifyContext, testWiki } from "./test-wiki.ts";

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

describe("assembleRevision", () => {
  function parts(): RevisionParts {
    const wiki = testWiki();
    const pack = buildPack({
      featureId: "signals",
      ...wiki,
      neighbours: new Map(),
      budgetTokens: 30_000,
    });
    const draft = signalsDraft();
    const claims = draft.sections.flatMap((section) =>
      section.claims.flatMap((claim) => {
        const verified = verifyClaim(section.key, claim, testVerifyContext()).claim;
        return verified === null ? [] : [{ key: section.key, claim: verified }];
      }),
    );
    return {
      featureId: "signals",
      index: wiki.index,
      manifest: wiki.manifest,
      commitDate: "2026-02-03T10:00:00-05:00",
      generatedAt: "2026-10-01T12:00:00.000Z",
      model: "claude-haiku-4-5-20251001",
      tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 },
      claims,
      diagram: draft.diagram,
      pack,
      neighbours: new Map([["signals", new Map([["deliverables", 2]])]]),
      wikipedia: new Map([["Message queue", null]]),
    };
  }

  it("links, orders and renumbers the claims and fills in the computed fields", () => {
    const assembled = assembleRevision(parts());
    expect(assembled.revision).toMatchObject({
      id: `signals-${"a".repeat(12)}`,
      reason: "build",
      seeAlso: ["deliverables"],
      infobox: { files: 3, entryPoints: ["src/signals/ingest.py"] },
    });
    expect(assembled.revision?.sections[1]?.claims[0]?.text).toBe(
      "`ingest_chunk()` keeps at most 50 signals, like a Message queue would.",
    );
    expect(assembled.revision?.diagram).toContain('n1 -->|"saves signals"| n2');
    expect(Revision.parse(assembled.revision)).toEqual(assembled.revision);
  });

  it("returns a revision the core schema accepts, with the lead linking the other page", () => {
    const { revision } = assembleRevision(parts());
    expect(Revision.parse(revision)).toEqual(revision);
    expect(revision?.sections[0]?.claims[0]?.text).toBe(
      "**Signal ingestion** turns chunks into signals for [[deliverables|deliverable records]].",
    );
  });

  it("is not written without a body", () => {
    const leadOnly = { ...parts(), claims: parts().claims.filter((c) => c.key === "lead") };
    expect(assembleRevision(leadOnly)).toEqual({
      revision: null,
      failure: "no lead or no body claim survived verification",
    });
  });

  it("drops a diagram the verifier refuses and returns its problems", () => {
    const base = parts();
    const node = (id: string) => ({ id, kind: "file" as const, ref: "src/a.py", label: "a.py" });
    // A node id with a space cannot be a Mermaid statement the verifier accepts.
    const pack = {
      ...base.pack,
      candidates: {
        nodes: [node("n 1"), node("n2")],
        edges: [{ from: "n 1", to: "n2", kind: "imports" as const }],
      },
    };
    const diagram = { nodes: ["n 1", "n2"], edges: [{ from: "n 1", to: "n2", label: "x" }] };
    const assembled = assembleRevision({ ...base, pack, diagram });
    if (assembled.revision === null) throw new Error("expected a revision");
    expect(assembled.revision.diagram).toBeNull();
    expect(assembled.diagramProblems.length).toBeGreaterThan(0);
    expect(Revision.parse(assembled.revision)).toEqual(assembled.revision);
  });

  it("keeps a linked claim that grew past the cap by turning its links into plain words", () => {
    const base = parts();
    const filler = "\u{1F600}".repeat(943);
    const text = `${filler} [[deliverable records]] [[wp:message queue]] [[wp:Evil]]`;
    expect([...text].length).toBeLessThanOrEqual(1000);
    expect(text.length).toBeLessThanOrEqual(CLAIM_TEXT_MAX_LENGTH);
    const canonical = "Message queue (software architecture and distributed systems terminology)";
    const claims = base.claims.map((c) =>
      c.key === "overview" ? { ...c, claim: { ...c.claim, text } } : c,
    );
    const { revision } = assembleRevision({
      ...base,
      claims,
      wikipedia: new Map([["Message queue", canonical]]),
    });
    const stored = revision?.sections[1]?.claims[0]?.text ?? "";
    expect(stored).toBe(`${filler} deliverable records message queue Evil`);
    expect(stored).not.toContain("[[");
    expect(Revision.parse(revision)).toEqual(revision);
  });

  it("falls back to the claim's own words when even the plain titles do not fit", () => {
    const base = parts();
    const manifest = {
      ...base.manifest,
      features: base.manifest.features.map((f) =>
        f.id === "deliverables" ? { ...f, title: "D".repeat(300) } : f,
      ),
    };
    const filler = "\u{1F600}".repeat(940);
    const claims = base.claims.map((c) =>
      c.key === "overview"
        ? { ...c, claim: { ...c.claim, text: `${filler} [[deliverables]] [[deliverables]]` } }
        : c,
    );
    const { revision } = assembleRevision({ ...base, manifest, claims });
    const stored = revision?.sections[1]?.claims[0]?.text ?? "";
    expect(stored).toBe(`${filler} deliverables deliverables`);
    expect(Revision.parse(revision)).toEqual(revision);
  });

  const withText = (base: RevisionParts, key: SectionKey, text: string): RevisionParts => ({
    ...base,
    claims: base.claims.map((c) => (c.key === key ? { ...c, claim: { ...c.claim, text } } : c)),
  });
  const textOf = (assembled: ReturnType<typeof assembleRevision>, section: number) =>
    assembled.revision?.sections[section]?.claims.map((c) => c.text);

  it("does not throw or write a live link for a redirect title that holds brackets", () => {
    const base = parts();
    const manifest = {
      ...base.manifest,
      features: [
        ...base.manifest.features,
        makeFeature({
          id: "old",
          title: "a`x [[nope",
          aliases: [],
          status: { kind: "redirect" as const, to: "deliverables" },
        }),
      ],
    };
    const assembled = assembleRevision({
      ...withText(withText(base, "lead", "A plain lead."), "overview", "Uses ` tick [[old]] here."),
      manifest,
    });
    expect(textOf(assembled, 1)).toEqual(["Uses ` tick [[deliverables|ax nope]] here."]);
    expect(Revision.parse(assembled.revision)).toEqual(assembled.revision);
  });

  it("replaces a claim whose Wikipedia link is not one that checked out", () => {
    const base = parts();
    // A canonical title holding "|" would be written as a link to "wp:Message", which was never checked.
    const assembled = assembleRevision({
      ...withText(base, "overview", "Like a [[wp:Message queue]] would."),
      wikipedia: new Map([["Message queue", "Message|queue"]]),
    });
    expect(textOf(assembled, 1)).toEqual(["Like a queue|Message queue would."]);
  });

  it("drops claims that are blank once linked, and a lead left without support", () => {
    const base = parts();
    const blank = `${String.fromCharCode(0xe000)}[[ ]]`;
    const overview = base.claims.filter((c) => c.key === "overview");
    const extra = overview.map((c) => ({
      ...c,
      claim: { ...c.claim, id: "o2", text: blank, citations: [], supports: [] },
    }));
    const assembled = assembleRevision({ ...base, claims: [...base.claims, ...extra] });
    const ids = assembled.revision?.sections.flatMap((s) => s.claims.map((c) => c.text)) ?? [];
    expect(ids.every((t) => t.trim() !== "")).toBe(true);
    expect(textOf(assembled, 1)).toHaveLength(1);
    expect(Revision.parse(assembled.revision)).toEqual(assembled.revision);

    const leadBlank = assembleRevision(withText(base, "lead", blank));
    expect(leadBlank).toEqual({
      revision: null,
      failure: "no lead or no body claim survived verification",
    });
  });

  it("re-checks the lead after blank body claims are dropped", () => {
    const base = parts();
    const blank = String.fromCharCode(0xe000);
    const claims = base.claims.map((c) =>
      c.key === "overview" || c.key === "history"
        ? { ...c, claim: { ...c.claim, text: blank } }
        : c,
    );
    expect(assembleRevision({ ...base, claims }).revision).toBeNull();
  });

  it("does not let a lead claim that is dropped use up a concept's first mention", () => {
    const base = parts();
    const lead = base.claims.find((c) => c.key === "lead");
    if (lead === undefined) throw new Error("fixture has a lead");
    const orphan = {
      key: "lead" as const,
      claim: { ...lead.claim, id: "l9", text: "Orphan [[deliverables]].", supports: ["gone"] },
    };
    const assembled = assembleRevision({ ...base, claims: [orphan, ...base.claims] });
    expect(textOf(assembled, 0)).toEqual([
      "**Signal ingestion** turns chunks into signals for [[deliverables|deliverable records]].",
    ]);
  });
});
