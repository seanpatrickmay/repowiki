import type { Claim } from "@repowiki/core";
import {
  bodyClaim,
  codeCitation,
  commitCitation,
  leadClaim,
  makeFeature,
  SHA_A,
  SHA_C,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import type { RewriteOutcome } from "./rewrite.ts";
import { REVERT_COMMIT, signalsRewrite, storedSignalsPage } from "./test-update.ts";
import { testWiki } from "./test-wiki.ts";
import { buildUpdatePack, type PageRewrite } from "./update-pack.ts";
import { assembleUpdate } from "./update-page.ts";

const wiki = testWiki();
const rewritten: Claim = bodyClaim({
  id: "c2",
  text: "`ingest_chunk()` now pages through chunks.",
  citations: [codeCitation()],
});
const newLead: Claim = leadClaim({
  id: "c1",
  text: "**Signal ingestion** pages through chunks.",
  supports: ["c2", "n1"],
});
// A new history claim cites a commit of this update (R15): the revert signalsRewrite() carries.
const added: Claim = bodyClaim({
  id: "n1",
  kind: "history",
  text: "A revert undid paging through long chunks.",
  citations: [
    commitCitation({
      sha: REVERT_COMMIT.sha,
      subject: REVERT_COMMIT.subject,
      pr: REVERT_COMMIT.pr,
    }),
  ],
});

function outcomeOf(rewrite: PageRewrite, over: Partial<RewriteOutcome> = {}): RewriteOutcome {
  return {
    featureId: rewrite.featureId,
    pack: buildUpdatePack({ rewrite, ...wiki }),
    replaced: new Map([
      ["c1", newLead],
      ["c2", rewritten],
    ]),
    keptStale: [],
    added: [{ key: "history", claim: added }],
    dropped: [],
    diagram: null,
    calls: 1,
    tokens: { in: 500, out: 80, cacheRead: 0, cacheWrite: 0 },
    model: "claude-haiku-4-5-20251001",
    failure: null,
    ...over,
  };
}
const assemble = (rewrite = signalsRewrite(), over: Partial<RewriteOutcome> = {}) =>
  assembleUpdate({
    rewrite,
    outcome: outcomeOf(rewrite, over),
    index: wiki.index,
    manifest: wiki.manifest,
    history: wiki.history,
    commitDate: "2026-02-03T10:00:00-05:00",
    generatedAt: "2026-10-03T12:00:00Z",
    pr: 12,
    reason: "update",
    neighbours: new Map([["signals", new Map([["deliverables", 2]])]]),
    wikipedia: new Map(),
  });
const texts = (r: ReturnType<typeof assemble>) =>
  r.revision?.sections.map((s) => [s.key, s.claims.map((c) => [c.id, c.text, c.staleSince])]);

describe("assembleUpdate", () => {
  it("replaces stale claims, keeps the rest word for word and appends new ones, renumbered", () => {
    const result = assemble();
    expect(texts(result)).toEqual([
      ["lead", [["c1", "**Signal ingestion** pages through chunks.", null]]],
      ["overview", [["c2", "`ingest_chunk()` now pages through chunks.", null]]],
      [
        "history",
        [
          ["c3", "Signal ingestion was added in January 2026.", null],
          ["c4", "A revert undid paging through long chunks.", null],
        ],
      ],
    ]);
    expect(result.revision?.sections[0]?.claims[0]?.supports).toEqual(["c2", "c4"]);
    expect(result.revision).toMatchObject({
      id: `signals-${SHA_A.slice(0, 12)}`,
      sha: SHA_A,
      parentId: "signals-cccccccccccc",
      reason: "update",
      pr: 12,
      tokens: { in: 500, out: 80 },
      seeAlso: ["deliverables"],
      infobox: { files: 3, entryPoints: ["src/signals/ingest.py"] },
    });
  });

  it("keeps a claim that failed as stored, marked stale since the new commit", () => {
    const result = assemble(signalsRewrite(), {
      replaced: new Map([["c1", newLead]]),
      keptStale: ["c2"],
      added: [],
    });
    expect(texts(result)?.[1]).toEqual([
      "overview",
      [["c2", "`ingest_chunk()` keeps at most 50 signals.", SHA_A]],
    ]);
    // The stale claim keeps its old citation, which still resolves at its own sha.
    expect(result.revision?.sections[1]?.claims[0]?.citations[0]).toMatchObject({ sha: SHA_C });
  });

  it("keeps the first stale sha of a claim that stays stale", () => {
    const rewrite = signalsRewrite();
    const earlier = rewrite.claims.map((c) =>
      c.claim.id === "c2" ? { ...c, claim: { ...c.claim, staleSince: SHA_C } } : c,
    );
    const result = assemble(
      { ...rewrite, claims: earlier },
      { replaced: new Map([["c1", newLead]]), keptStale: ["c2"], added: [] },
    );
    expect(texts(result)?.[1]?.[1]).toEqual([
      ["c2", "`ingest_chunk()` keeps at most 50 signals.", SHA_C],
    ]);
  });

  it("makes no revision when the answers changed nothing", () => {
    const quiet = signalsRewrite({
      claims: signalsRewrite().claims.map((c) => ({ ...c, status: "fresh" as const })),
    });
    expect(assemble(quiet, { replaced: new Map(), added: [] })).toEqual({
      revision: null,
      why: "nothing changed",
    });
  });

  it("falls back to the old claims, the stale ones marked, when the rewrite leaves no lead", () => {
    const blank = bodyClaim({
      id: "n1",
      kind: "history",
      text: "[[ ]]",
      citations: [commitCitation()],
    });
    const result = assemble(signalsRewrite(), {
      replaced: new Map([
        ["c1", leadClaim({ id: "c1", supports: ["n1"] })],
        ["c2", rewritten],
      ]),
      added: [{ key: "history", claim: blank }],
    });
    expect(texts(result)).toEqual([
      ["lead", [["c1", "**Signal ingestion** turns chunks into signals.", SHA_A]]],
      ["overview", [["c2", "`ingest_chunk()` keeps at most 50 signals.", SHA_A]]],
      ["history", [["c3", "Signal ingestion was added in January 2026.", null]]],
    ]);
  });

  it("links every claim against the new manifest, following a merged feature", () => {
    const manifest = {
      ...wiki.manifest,
      features: [
        ...wiki.manifest.features,
        makeFeature({
          id: "old-deliverables",
          title: "Old deliverables",
          aliases: [],
          status: { kind: "redirect", to: "deliverables" },
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "merge", sha: SHA_A, into: "deliverables" },
          ],
        }),
      ],
    };
    const linking = bodyClaim({
      id: "c3",
      kind: "history",
      text: "It fed [[old-deliverables]].",
      citations: [commitCitation()],
    });
    const rewrite = signalsRewrite();
    const claims = rewrite.claims.map((c) => (c.claim.id === "c3" ? { ...c, claim: linking } : c));
    const result = assembleUpdate({
      rewrite: { ...rewrite, claims },
      outcome: outcomeOf(rewrite),
      index: wiki.index,
      manifest,
      history: wiki.history,
      commitDate: "2026-02-03T10:00:00-05:00",
      generatedAt: "2026-10-03T12:00:00Z",
      pr: null,
      reason: "update",
      neighbours: new Map(),
      wikipedia: new Map(),
    });
    expect(result.revision?.sections[2]?.claims[0]?.text).toBe(
      "It fed [[deliverables|Old deliverables]].",
    );
  });

  it("draws the diagram again from the answer when the feature's files changed", () => {
    const rewrite = signalsRewrite({ membershipChanged: true });
    const result = assemble(rewrite, {
      diagram: { nodes: ["n1", "n2"], edges: [{ from: "n1", to: "n2", label: "saves signals" }] },
    });
    expect(result.revision?.diagram).toContain("flowchart LR");
    expect(assemble().revision?.diagram).toBeNull();
  });

  it("keeps the stored diagram when the feature's files did not change", () => {
    const drawn = 'flowchart LR\n  n1["ingest.py"]';
    const rewrite = signalsRewrite({ revision: { ...storedSignalsPage(), diagram: drawn } });
    const result = assemble(rewrite, {
      diagram: { nodes: ["n1", "n2"], edges: [{ from: "n1", to: "n2", label: "saves signals" }] },
    });
    expect(result.revision?.diagram).toBe(drawn);
  });

  it("drops a redrawn diagram the verifier refuses, and returns its problems", () => {
    const rewrite = signalsRewrite({ membershipChanged: true });
    const base = outcomeOf(rewrite);
    const node = (id: string) => ({ id, kind: "file" as const, ref: "src/a.py", label: "a.py" });
    // A node id with a space cannot be a Mermaid statement the verifier accepts.
    const pack = {
      ...base.pack,
      candidates: {
        nodes: [node("n 1"), node("n2")],
        edges: [{ from: "n 1", to: "n2", kind: "imports" as const }],
      },
    };
    const result = assembleUpdate({
      rewrite,
      outcome: {
        ...base,
        pack,
        diagram: { nodes: ["n 1", "n2"], edges: [{ from: "n 1", to: "n2", label: "x" }] },
      },
      index: wiki.index,
      manifest: wiki.manifest,
      history: wiki.history,
      commitDate: "2026-02-03T10:00:00-05:00",
      generatedAt: "2026-10-03T12:00:00Z",
      pr: 12,
      reason: "update",
      neighbours: new Map(),
      wikipedia: new Map(),
    });
    if (result.revision === null) throw new Error("expected a revision");
    expect(result.revision.diagram).toBeNull();
    expect("diagramProblems" in result && result.diagramProblems.length).toBeGreaterThan(0);
  });

  it("keeps a lead the model gave up, marked stale, beside the claims it did rewrite", () => {
    const result = assemble(signalsRewrite(), {
      replaced: new Map([["c2", rewritten]]),
      keptStale: ["c1"],
      added: [],
    });
    expect(texts(result)?.slice(0, 2)).toEqual([
      ["lead", [["c1", "**Signal ingestion** turns chunks into signals.", SHA_A]]],
      ["overview", [["c2", "`ingest_chunk()` now pages through chunks.", null]]],
    ]);
  });

  it("dates the revision by the new commit, and stamps when it was generated", () => {
    expect(assemble().revision).toMatchObject({
      commitDate: "2026-02-03T10:00:00-05:00",
      generatedAt: "2026-10-03T12:00:00Z",
    });
  });

  it("draws only candidate nodes and edges, whatever the answer names", () => {
    const rewrite = signalsRewrite({ membershipChanged: true });
    const result = assemble(rewrite, {
      diagram: {
        nodes: ["n1", "n2", "n99"],
        edges: [
          { from: "n1", to: "n2", label: "saves signals" },
          { from: "n2", to: "n99", label: "invented" },
          { from: "n99", to: "n1", label: "invented" },
        ],
      },
    });
    const diagram = result.revision?.diagram ?? "";
    expect(diagram).toContain('n1 -->|"saves signals"| n2');
    expect(diagram).not.toContain("n99");
    expect(diagram).not.toContain("invented");
  });
});
