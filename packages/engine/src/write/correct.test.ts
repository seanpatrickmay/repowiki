import { type Architecture, type Revision, SCHEMA_VERSION, WikiExport } from "@repowiki/core";
import {
  bodyClaim,
  codeCitation,
  leadClaim,
  makeArchitecture,
  makeManifest,
  makeRevision,
} from "@repowiki/core/test-fixtures";
import type { GenerateRequest, Provider } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import {
  ABOUT_ARTICLE,
  type AboutCorrectionAnswer,
  type CorrectionAnswer,
  correctClaims,
  MAX_NOTE_LENGTH,
} from "./correct.ts";
import { testVerifyContext } from "./test-wiki.ts";

const NOW = "2026-10-22T12:00:00.000Z";
/** Two cited body claims under one lead that summarizes both. */
const page = (): Revision =>
  makeRevision({
    sections: [
      { key: "lead", claims: [leadClaim({ id: "c1", supports: ["c2", "c3"] })] },
      {
        key: "overview",
        claims: [
          bodyClaim({ id: "c2" }),
          bodyClaim({
            id: "c3",
            text: "At most 50 signals are made from one chunk.",
            citations: [codeCitation({ startLine: 7, endLine: 7, symbol: null })],
          }),
        ],
      },
    ],
  });
const exportOf = (revision: Revision, architecture: Architecture[] = []) =>
  WikiExport.parse({
    schemaVersion: SCHEMA_VERSION,
    repo: "demo",
    head: revision.sha,
    exportedAt: NOW,
    manifest: makeManifest(),
    pages: [revision],
    history: { [revision.featureId]: [revision] },
    architecture,
  });

/** A provider answering each call in turn from `answers`, keeping every request. */
function scripted(...answers: (CorrectionAnswer | AboutCorrectionAnswer)[]) {
  const requests: GenerateRequest<unknown>[] = [];
  const provider: Provider = {
    async generate<T>(request: GenerateRequest<T>) {
      requests.push(request as GenerateRequest<unknown>);
      const answer = answers[requests.length - 1];
      if (answer === undefined) throw new Error("no answer scripted");
      const usage = { in: 100, out: 10, cacheRead: 0, cacheWrite: 0 };
      return { output: request.schema.parse(answer), usage, model: "claude-haiku-5-5" };
    },
  };
  return { provider, requests };
}

const rewrite = (id: string, text: string, cite: string[]) => ({
  id,
  drop: false,
  text,
  cite,
  supports: [],
});
const run = (provider: Provider, requests: Parameters<typeof correctClaims>[0]["requests"]) =>
  correctClaims({ exp: exportOf(page()), requests, ctx: testVerifyContext(), provider, now: NOW });

describe("correcting sentences a student flagged (sentence corrections spec)", () => {
  it("replaces a flagged claim with a rewrite that verifies, in a new correction revision", async () => {
    const { provider } = scripted({
      claims: [rewrite("c3", "One chunk makes at most 50 signals.", ["src/signals/ingest.py:7"])],
    });
    const done = await run(provider, [{ page: "signals", claimId: "c3", note: "It's per chunk." }]);
    expect(done.outcomes).toEqual([
      { page: "signals", claimId: "c3", outcome: "rewritten", detail: null },
    ]);
    const [revision] = done.exp.pages;
    expect(revision).toMatchObject({ parentId: "rev-1", reason: "correction", generatedAt: NOW });
    expect(revision?.sections[1]?.claims.map((c) => c.text)).toContain(
      "One chunk makes at most 50 signals.",
    );
    expect(done.exp.history.signals?.map((r) => r.id)).toEqual(["rev-1", revision?.id]);
  });

  it("removes a claim the model drops, and a lead left with nothing to summarize", async () => {
    const lonely = makeRevision({
      sections: [
        {
          key: "lead",
          claims: [
            leadClaim({ id: "c1", supports: ["c2"] }),
            leadClaim({ id: "c4", text: "It also caps them.", supports: ["c3"] }),
          ],
        },
        {
          key: "overview",
          claims: [
            bodyClaim({ id: "c2" }),
            bodyClaim({
              id: "c3",
              text: "It caps them at 50.",
              citations: [codeCitation({ startLine: 7, endLine: 7, symbol: null })],
            }),
          ],
        },
      ],
    });
    const { provider } = scripted({ claims: [{ ...rewrite("c3", "", []), drop: true }] });
    const done = await correctClaims({
      exp: exportOf(lonely),
      requests: [{ page: "signals", claimId: "c3", note: "Not true." }],
      ctx: testVerifyContext(),
      provider,
      now: NOW,
    });
    expect(done.outcomes[0]?.outcome).toBe("removed");
    const texts = done.exp.pages[0]?.sections.flatMap((s) => s.claims.map((c) => c.text));
    expect(texts).not.toContain("It caps them at 50.");
    expect(texts).not.toContain("It also caps them.");
  });

  it("asks once more about a rewrite that fails, then removes it if it fails again", async () => {
    const bad = rewrite("c3", "One chunk makes at most 50 signals.", ["src/signals/ingest.py:900"]);
    const { provider, requests } = scripted({ claims: [bad] }, { claims: [bad] });
    const done = await run(provider, [{ page: "signals", claimId: "c3", note: "Wrong." }]);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain("These claims failed");
    expect(done.outcomes[0]).toMatchObject({ outcome: "removed" });
  });

  it("refuses an id or page the export doesn't have, and calls no model for it", async () => {
    const { provider, requests } = scripted();
    const done = await run(provider, [
      { page: "signals", claimId: "c99", note: "x" },
      { page: "nowhere", claimId: "c1", note: "x" },
    ]);
    expect(requests).toEqual([]);
    expect(done.outcomes.map((o) => o.outcome)).toEqual(["refused", "refused"]);
    expect(done.exp.pages[0]?.id).toBe("rev-1");
  });

  it("shows the model the note as a cleaned, clipped hint, and never stores it", async () => {
    const note = `${"x".repeat(MAX_NOTE_LENGTH + 50)}\u202E`;
    const { provider, requests } = scripted({
      claims: [rewrite("c3", "One chunk makes at most 50 signals.", ["src/signals/ingest.py:7"])],
    });
    const done = await run(provider, [{ page: "signals", claimId: "c3", note }]);
    const prompt = JSON.stringify(requests[0]?.messages);
    expect(prompt).toContain("x".repeat(MAX_NOTE_LENGTH));
    expect(prompt).not.toContain("x".repeat(MAX_NOTE_LENGTH + 1));
    expect(prompt).not.toContain("\u202E");
    expect(prompt).toContain("src/signals/ingest.py");
    expect(JSON.stringify(done.exp)).not.toContain("x".repeat(40));
  });

  it("links a rewrite as a built sentence is linked: known pages kept, unknown ones plain", async () => {
    const text =
      "One chunk makes at most 50 signals for [[deliverables|records]] and [[nowhere|others]].";
    const { provider } = scripted({ claims: [rewrite("c3", text, ["src/signals/ingest.py:7"])] });
    const done = await run(provider, [{ page: "signals", claimId: "c3", note: "Per chunk." }]);
    const texts = done.exp.pages[0]?.sections.flatMap((s) => s.claims.map((c) => c.text));
    expect(texts).toContain(
      "One chunk makes at most 50 signals for [[deliverables|records]] and others.",
    );
  });
});

describe("correcting the About article (sentence corrections spec)", () => {
  /** The About article with no edges: the export holds only the signals page. */
  const about = () => makeArchitecture({ edges: [] });
  const runAbout = (provider: Provider, claimId: string) =>
    correctClaims({
      exp: exportOf(page(), [about()]),
      requests: [{ page: ABOUT_ARTICLE, claimId, note: "Not what it does." }],
      ctx: testVerifyContext(),
      provider,
      now: NOW,
    });

  it("rewrites a flagged claim as the article's next revision, under the article's rules", async () => {
    const { provider } = scripted({
      claims: [
        {
          ...rewrite("a-1", "Signal ingestion turns chunks into signals.", [
            "src/signals/ingest.py:10-24",
          ]),
          pages: ["signals"],
        },
      ],
    });
    const done = await runAbout(provider, "a-1");
    expect(done.outcomes).toEqual([
      { page: ABOUT_ARTICLE, claimId: "a-1", outcome: "rewritten", detail: null },
    ]);
    expect(done.exp.architecture.map((a) => a.id)).toEqual([
      "architecture-aaaaaaaaaaaa-1",
      "architecture-aaaaaaaaaaaa-2",
    ]);
    const article = done.exp.architecture.at(-1);
    expect(article).toMatchObject({
      parentId: "architecture-aaaaaaaaaaaa-1",
      reason: "correction",
      generatedAt: NOW,
    });
    const texts = article?.sections.flatMap((s) => s.claims.map((c) => c.text));
    expect(texts?.some((t) => t.includes("turns chunks into signals"))).toBe(true);
    expect(done.exp.pages[0]?.id).toBe("rev-1");
  });

  it("removes a claim that names a page the wiki lacks twice, keeping the rest", async () => {
    const bad = { ...rewrite("a-2", "Signals depend on nothing.", []), pages: ["nowhere"] };
    const { provider, requests } = scripted({ claims: [bad] }, { claims: [bad] });
    const done = await runAbout(provider, "a-2");
    expect(requests).toHaveLength(2);
    expect(done.outcomes[0]?.outcome).toBe("removed");
    const article = done.exp.architecture.at(-1);
    expect(article?.sections.map((s) => s.key)).toEqual(["lead", "layers"]);
  });

  it("refuses a claim of an About article the export doesn't have", async () => {
    const { provider, requests } = scripted();
    const done = await correctClaims({
      exp: exportOf(page()),
      requests: [{ page: ABOUT_ARTICLE, claimId: "a-1", note: "x" }],
      ctx: testVerifyContext(),
      provider,
      now: NOW,
    });
    expect(requests).toEqual([]);
    expect(done.outcomes[0]?.outcome).toBe("refused");
  });
});
