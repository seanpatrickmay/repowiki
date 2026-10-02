import { Architecture } from "@repowiki/core";
import { LlmError } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import type { ArchitectureDraft, ArchitectureFixes } from "../verify/index.ts";
import { writeArchitecture } from "./architecture.ts";
import { ARCHITECTURE_GIVE_UP, architectureSystemPrompt } from "./architecture-prompt.ts";
import { architectureDraft, testArchitectureInput } from "./test-architecture.ts";
import { memoryWikipediaCache } from "./test-cache.ts";
import { fakeWikipedia, pageProvider } from "./test-provider.ts";

function run(
  answer: (call: number) => ArchitectureDraft | ArchitectureFixes | Error,
  edit: (draft: ArchitectureDraft) => void = () => {},
) {
  const { provider, requests } = pageProvider((_featureId, call) => {
    const out = answer(call);
    if (!(out instanceof Error) && "sections" in out) edit(out);
    return out;
  });
  const lines: string[] = [];
  const input = testArchitectureInput();
  const result = writeArchitecture(
    { ...input, parent: null, number: 1 },
    {
      provider,
      repoName: "sample",
      wikipedia: { cache: memoryWikipediaCache(), fetch: fakeWikipedia },
      now: () => new Date("2026-10-02T12:00:00Z"),
      log: (line) => lines.push(line),
    },
  );
  return { result, requests, lines, input };
}

const withClaim =
  (key: string, claim: ArchitectureDraft["sections"][number]["claims"][number]) =>
  (draft: ArchitectureDraft) => {
    draft.sections.find((s) => s.key === key)?.claims.push(claim);
  };

describe("writeArchitecture", () => {
  it("writes the project's article in one batched call with no cache key, linked and with its diagram", async () => {
    const { result, requests, input } = run(() => architectureDraft());
    const outcome = await result;
    expect(outcome).toMatchObject({ failure: null, dropped: [], calls: 1 });
    const article = outcome.architecture as Architecture;
    expect(Architecture.parse(article)).toEqual(article);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ purpose: "write", batch: true, maxTokens: 8000 });
    expect(requests[0]?.cacheKey).toBeUndefined();
    expect(requests[0]?.featureId).toBeUndefined();
    expect(requests[0]?.system).toBe(architectureSystemPrompt("sample", input.manifest));
    expect(requests[0]?.messages).toEqual([{ role: "user", content: outcome.pack.text }]);
    expect(article).toMatchObject({
      id: `architecture-${input.index.sha.slice(0, 12)}-1`,
      sha: input.index.sha,
      title: "Sample Ops",
      parentId: null,
      reason: "build",
      basis: ["deliverables-aaaaaaaaaaaa", "signals-aaaaaaaaaaaa"],
      edges: [{ from: "deliverables", to: "signals", imports: 1, calls: 1 }],
      tokens: { in: 100, out: 10, cacheRead: 0, cacheWrite: 0 },
      model: "claude-haiku-4-5-20251001",
      generatedAt: "2026-10-02T12:00:00.000Z",
    });
    expect(article.sections.map((s) => [s.key, s.claims.map((c) => c.id)])).toEqual([
      ["lead", ["c1"]],
      ["purpose", ["c2"]],
      ["layers", ["c3"]],
      ["request-paths", ["c4"]],
      ["dependencies", ["c5"]],
    ]);
    const [lead, purpose, , path, deps] = article.sections.map((s) => s.claims[0]);
    expect(lead?.text).toBe(
      "**Sample Ops** is built from [[signals|signal ingestion]] and [[deliverables]].",
    );
    expect(lead?.supports).toEqual(["c2", "c3", "c4", "c5"]);
    // A purpose claim cites the README by line range, like code.
    expect(purpose?.citations).toMatchObject([
      { kind: "code", path: "README.md", startLine: 3, endLine: 5 },
    ]);
    expect(path?.citations).toMatchObject([
      { kind: "code", path: "src/deliverables/crud.py", startLine: 7, endLine: 7 },
    ]);
    // Each feature is linked on its first mention only; the Wikipedia title checked out.
    expect(deps?.text).toBe(
      "Deliverables depends on Signal ingestion, which works like a [[wp:Message queue]].",
    );
    expect(deps?.pages).toEqual(["deliverables", "signals"]);
    expect(article.diagram).toBe(
      [
        "flowchart LR",
        '  n1[["Deliverables"]]',
        '  n2[["Signal ingestion"]]',
        '  n1 -->|"1 call, 1 import"| n2',
      ].join("\n"),
    );
  });

  it("sends failing claims back once with the article's give-up rule, and keeps the fixes", async () => {
    const ghost = { id: "g1", text: "Ghosts haunt it.", cite: [], pages: ["ghost"], supports: [] };
    const { result, requests } = run(
      (call) =>
        call === 1
          ? architectureDraft()
          : { claims: [{ ...ghost, cite: ["src/signals/store.py:1-2"], pages: [] }] },
      withClaim("layers", ghost),
    );
    const outcome = await result;
    expect(outcome).toMatchObject({ failure: null, dropped: [], calls: 2 });
    const turn = String(requests[1]?.messages.at(-1)?.content);
    expect(turn).toContain(
      '- "g1": the claim names "ghost", which is not a feature page of this wiki',
    );
    expect(turn.endsWith(ARCHITECTURE_GIVE_UP)).toBe(true);
    expect(requests[1]?.maxTokens).toBe(4000);
    const layers = outcome.architecture?.sections.find((s) => s.key === "layers");
    expect(layers?.claims.map((c) => c.text)).toContain("Ghosts haunt it.");
  });

  it("drops a claim given up or failing twice, and logs it", async () => {
    const ghost = { id: "g1", text: "Ghosts haunt it.", cite: [], pages: ["ghost"], supports: [] };
    const { result, lines } = run(
      (call) => (call === 1 ? architectureDraft() : { claims: [{ ...ghost, pages: [] }] }),
      withClaim("layers", ghost),
    );
    const outcome = await result;
    expect(outcome.failure).toBeNull();
    expect(outcome.dropped).toEqual([
      {
        section: "layers",
        text: "Ghosts haunt it.",
        problems: [
          'the claim names "ghost", which is not a feature page of this wiki',
          "body claims need a citation or a feature page",
        ],
      },
    ]);
    expect(lines).toContain(
      'architecture: dropped a layers claim: the claim names "ghost", which is not a feature page of this wiki; body claims need a citation or a feature page',
    );
  });

  it("asks again for the whole article when the first answer has no body", async () => {
    const { result, requests } = run((call) =>
      call === 1 ? { sections: architectureDraft().sections.slice(0, 1) } : architectureDraft(),
    );
    const outcome = await result;
    expect(outcome).toMatchObject({ failure: null, calls: 2 });
    expect(String(requests[1]?.messages.at(-1)?.content)).toContain(
      "That answer was rejected: the answer needs at least one lead claim and one body claim",
    );
  });

  it("reports a failed call as a failure, never a throw, and writes nothing", async () => {
    const { result, lines } = run(() => new LlmError("expired"));
    const outcome = await result;
    expect(outcome).toMatchObject({ architecture: null, calls: 0 });
    expect(outcome.failure).toBe("the architecture call failed: LlmError: expired");
    expect(lines).toEqual([
      "architecture: not written: the architecture call failed: LlmError: expired",
    ]);
  });

  it("is not written when no lead survives", async () => {
    const { result } = run(
      (call) => (call === 1 ? architectureDraft() : { claims: [] }),
      (draft) => {
        const lead = draft.sections[0]?.claims[0];
        if (lead !== undefined) lead.supports = ["nothing"];
      },
    );
    const outcome = await result;
    expect(outcome.architecture).toBeNull();
    expect(outcome.failure).toBe("no lead or no body claim survived verification");
  });

  it("makes links to unknown features plain text, and draws no diagram without an edge", async () => {
    const { provider } = pageProvider(() => {
      const draft = architectureDraft();
      const layer = draft.sections[1]?.claims[0];
      if (layer !== undefined) layer.text = "It calls [[ghost]] and [[javascript:alert(1)|x]].";
      return draft;
    });
    const input = testArchitectureInput();
    const outcome = await writeArchitecture(
      { ...input, index: { ...input.index, imports: [], calls: [] }, parent: null, number: 1 },
      {
        provider,
        repoName: "sample",
        wikipedia: { cache: memoryWikipediaCache(), fetch: fakeWikipedia },
      },
    );
    const article = outcome.architecture as Architecture;
    expect(article.sections[1]?.claims[0]?.text).toBe("It calls ghost and x.");
    expect(article.edges).toEqual([]);
    expect(article.diagram).toBeNull();
  });

  it("takes its title from the README, else the repository's name, never from the model", async () => {
    // Without the README, the purpose claim's citation fails, and the retry gives it up.
    const { provider } = pageProvider((_id, call) =>
      call === 1 ? architectureDraft() : { claims: [] },
    );
    const input = testArchitectureInput();
    input.sources.delete("README.md");
    const outcome = await writeArchitecture(
      { ...input, parent: null, number: 1 },
      {
        provider,
        repoName: "next-chief-of-staff",
        wikipedia: { cache: memoryWikipediaCache(), fetch: fakeWikipedia },
      },
    );
    expect(outcome.architecture?.title).toBe("next-chief-of-staff");
    expect(outcome.pack.text.split("\n")[0]).toBe(
      "# Project: next-chief-of-staff (2 features with pages, 5 files)",
    );
  });

  it("names its parent and takes the next number when it replaces an article", async () => {
    const first = (await run(() => architectureDraft()).result).architecture as Architecture;
    const { provider } = pageProvider(() => architectureDraft());
    const input = testArchitectureInput();
    const next = await writeArchitecture(
      { ...input, parent: first, number: 2 },
      {
        provider,
        repoName: "sample",
        wikipedia: { cache: memoryWikipediaCache(), fetch: fakeWikipedia },
      },
    );
    expect(next.architecture?.id).toBe(`architecture-${input.index.sha.slice(0, 12)}-2`);
    expect(next.architecture?.parentId).toBe(first.id);
  });
});
