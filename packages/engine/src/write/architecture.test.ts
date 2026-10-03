import { Architecture } from "@repowiki/core";
import {
  createClaudeProvider,
  createLedger,
  DEFAULT_MODELS,
  type FetchLike,
  LlmError,
  LlmOutputError,
  MAX_TOKENS_STOP_REASON,
} from "@repowiki/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchitectureDraft, ArchitectureFixes } from "../verify/index.ts";
import { writeArchitecture } from "./architecture.ts";
import { ARCHITECTURE_GIVE_UP, architectureSystemPrompt } from "./architecture-prompt.ts";
import { architectureDraft, testArchitectureInput } from "./test-architecture.ts";
import { memoryWikipediaCache } from "./test-cache.ts";
import { fakeWikipedia, pageProvider } from "./test-provider.ts";

// A test may force the diagram the engine draws, to reach the branch that refuses a bad one.
const forced = vi.hoisted(() => ({ diagram: null as string | null }));
vi.mock("./architecture-edges.ts", async (importOriginal) => {
  const edges = await importOriginal<typeof import("./architecture-edges.ts")>();
  return {
    ...edges,
    architectureDiagram: (...args: Parameters<typeof edges.architectureDiagram>) =>
      forced.diagram ?? edges.architectureDiagram(...args),
  };
});
afterEach(() => {
  forced.diagram = null;
});

function run(
  answer: (call: number) => ArchitectureDraft | ArchitectureFixes | Error,
  edit: (draft: ArchitectureDraft) => void = () => {},
  tweak: (input: ReturnType<typeof testArchitectureInput>) => void = () => {},
) {
  const { provider, requests } = pageProvider((_featureId, call) => {
    const out = answer(call);
    if (!(out instanceof Error) && "sections" in out) edit(out);
    return out;
  });
  const lines: string[] = [];
  const input = testArchitectureInput();
  tweak(input);
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

const withSupports = (supports: string[]) => (draft: ArchitectureDraft) => {
  const lead = draft.sections[0]?.claims[0];
  if (lead !== undefined) lead.supports = supports;
};

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
    expect(requests[0]).toMatchObject({ purpose: "write", batch: true, maxTokens: 16000 });
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
          : { claims: [{ ...ghost, cite: ["src/signals/ingest.py:10-11"], pages: [] }] },
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

  it("sends a claim citing lines the pack did not show to the retry round", async () => {
    // The pack shows crud.py's lines 4-5 (signatures) and 1 and 7 (edge sites), not line 6.
    const y1 = { id: "y1", text: "`complete()` hands notes on.", pages: [], supports: [] };
    const { result, requests } = run(
      (call) =>
        call === 1
          ? architectureDraft()
          : { claims: [{ ...y1, cite: ["src/deliverables/crud.py:4-5"] }] },
      (draft) => {
        const layers = draft.sections.find((s) => s.key === "layers");
        if (layers !== undefined)
          layers.claims = [{ ...y1, cite: ["src/deliverables/crud.py:4-7"] }];
      },
    );
    const outcome = await result;
    expect(outcome).toMatchObject({ failure: null, dropped: [], calls: 2 });
    expect(String(requests[1]?.messages.at(-1)?.content)).toContain(
      '- "y1": the claim cites "src/deliverables/crud.py" lines 4-7, which the pack did not show; cite only lines the pack numbers or gives for an edge, or name the feature page instead',
    );
    const layers = outcome.architecture?.sections.find((s) => s.key === "layers");
    expect(layers?.claims[0]?.citations).toMatchObject([{ startLine: 4, endLine: 5 }]);
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
      // Without edges the pack gives no edge site to cite, so the request path cites a signature.
      const path = draft.sections.find((s) => s.key === "request-paths")?.claims[0];
      if (path !== undefined) path.cite = ["src/deliverables/crud.py:4"];
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

  it("names an unknown lead support once, and says how many more it left out", async () => {
    const body = ["u1", "y1", "p1", "d1"];
    const twice = await run(
      (call) => (call === 1 ? architectureDraft() : { claims: [] }),
      withSupports([...body, "nothing", "nothing"]),
    ).result;
    expect(twice.dropped.map((d) => d.problems)).toEqual([
      ['the lead supports "nothing", which are not body claims'],
    ]);
    const many = run(
      (call) => (call === 1 ? architectureDraft() : { claims: [] }),
      withSupports([...body, "a", "b", "c", "d", "e"]),
    );
    const outcome = await many.result;
    expect(outcome.dropped.map((d) => d.problems)).toEqual([
      ['the lead supports "a", "b", "c", and 2 more, which are not body claims'],
    ]);
    expect(String(many.requests[1]?.messages.at(-1)?.content)).toContain(
      '- "l1": the lead supports "a", "b", "c", and 2 more, which are not body claims',
    );
  });

  it("falls back to the build time when the commit's date is not one the article can store", async () => {
    const commit = (input: ReturnType<typeof testArchitectureInput>, date: string) => {
      input.history = [
        { ...(input.history[0] as (typeof input.history)[number]), sha: input.index.sha, date },
      ];
    };
    const good = await run(
      () => architectureDraft(),
      () => {},
      (input) => commit(input, "2026-02-03T10:00:00-05:00"),
    ).result;
    expect(good.architecture?.commitDate).toBe("2026-02-03T10:00:00-05:00");
    const bad = await run(
      () => architectureDraft(),
      () => {},
      (input) => commit(input, "yesterday"),
    ).result;
    expect(bad.failure).toBeNull();
    expect(bad.architecture?.commitDate).toBe("2026-10-02T12:00:00.000Z");
  });

  it("reports a failed retry as a failure of the second call, with the first call's tokens", async () => {
    const ghost = { id: "g1", text: "Ghosts haunt it.", cite: [], pages: ["ghost"], supports: [] };
    const { result, lines } = run(
      (call) => (call === 1 ? architectureDraft() : new LlmError("gone")),
      withClaim("layers", ghost),
    );
    const outcome = await result;
    expect(outcome).toMatchObject({ architecture: null, calls: 1 });
    expect(outcome.tokens.in).toBe(100);
    expect(outcome.failure).toBe("the architecture call failed twice: LlmError: gone");
    expect(lines).toContain(
      "architecture: not written: the architecture call failed twice: LlmError: gone",
    );
  });

  it("asks again, and counts the call and its tokens, when the first answer is unusable", async () => {
    const usage = { in: 7, out: 3, cacheRead: 1, cacheWrite: 2 };
    const { result, requests } = run((call) =>
      call === 1
        ? new LlmOutputError("the answer is not JSON", "not json", { usage, model: "m-1" })
        : architectureDraft(),
    );
    const outcome = await result;
    expect(outcome).toMatchObject({ failure: null, calls: 2, dropped: [] });
    expect(outcome.tokens).toEqual({ in: 107, out: 13, cacheRead: 1, cacheWrite: 2 });
    expect(outcome.architecture?.model).toBe("m-1");
    expect(requests[1]?.messages.map((m) => m.content)).toEqual([
      outcome.pack.text,
      "not json",
      "That answer was rejected: the answer is not JSON\nReturn the corrected JSON object.",
    ]);
  });

  it("asks for a shorter answer, with the same cap, when the first one stopped at max_tokens", async () => {
    const usage = { in: 7, out: 16000, cacheRead: 0, cacheWrite: 0 };
    const { result, requests } = run((call) =>
      call === 1
        ? new LlmOutputError(
            "model stopped with max_tokens",
            '{"sections":[',
            { usage, model: "m-1" },
            MAX_TOKENS_STOP_REASON,
          )
        : architectureDraft(),
    );
    const outcome = await result;
    expect(outcome).toMatchObject({ failure: null, calls: 2, dropped: [] });
    expect(requests.map((r) => r.maxTokens)).toEqual([16000, 16000]);
    expect(requests[1]?.messages.at(-1)?.content).toBe(
      "That answer was rejected: model stopped with max_tokens; it was too long, so answer shorter, with fewer and shorter claims\nReturn the corrected JSON object.",
    );
  });

  it("asks for nothing shorter when an unusable answer was not cut off", async () => {
    const { result, requests } = run((call) =>
      call === 1
        ? new LlmOutputError("model stopped with max_tokens", "{", undefined, null)
        : architectureDraft(),
    );
    await result;
    expect(String(requests[1]?.messages.at(-1)?.content)).not.toContain("shorter");
  });

  it("asks for a shorter answer when the Claude provider's answer stopped at max_tokens", async () => {
    // The real provider over a fake Messages API: the first answer is cut off, the retry is whole.
    const bodies: { messages: { content: unknown }[]; max_tokens: number }[] = [];
    const fetch: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const [text, stop] =
        bodies.length === 1
          ? ['{"sections":[', "max_tokens"]
          : [JSON.stringify(architectureDraft()), "end_turn"];
      const message = {
        id: `msg_${bodies.length}`,
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text }],
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      return new Response(JSON.stringify(message), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const provider = createClaudeProvider({
      models: DEFAULT_MODELS,
      ledger: createLedger(),
      runId: "test-run",
      apiKey: "canned",
      fetch,
    });
    const outcome = await writeArchitecture(
      { ...testArchitectureInput(), parent: null, number: 1 },
      {
        provider,
        repoName: "sample",
        batch: false,
        wikipedia: { cache: memoryWikipediaCache(), fetch: fakeWikipedia },
      },
    );
    expect(outcome).toMatchObject({ failure: null, calls: 2 });
    expect(bodies.map((b) => b.max_tokens)).toEqual([16000, 16000]);
    expect(bodies[1]?.messages.at(-1)?.content).toBe(
      "That answer was rejected: model stopped with max_tokens; it was too long, so answer shorter, with fewer and shorter claims\nReturn the corrected JSON object.",
    );
  });

  it("fails the article, not the build, when verifying a claim throws", async () => {
    let armed = 0;
    const armedSources = (input: ReturnType<typeof testArchitectureInput>) => {
      const sources = input.sources;
      input.sources = new (class extends Map<string, string> {
        override get(path: string) {
          if (armed > 0) throw new Error("boom: secret model text");
          return super.get(path);
        }
      })(sources);
    };
    const first = await run(
      () => {
        armed = 1;
        return architectureDraft();
      },
      () => {},
      armedSources,
    ).result;
    expect(first).toMatchObject({ architecture: null, calls: 1 });
    expect(first.failure).toBe("verifying the claims failed: Error");

    armed = 0;
    const ghost = { id: "g1", text: "Ghosts haunt it.", cite: [], pages: ["ghost"], supports: [] };
    const second = await run(
      (call) => {
        armed = call === 2 ? 1 : 0;
        return call === 1
          ? architectureDraft()
          : { claims: [{ ...ghost, cite: ["src/signals/store.py:1-2"], pages: [] }] };
      },
      withClaim("layers", ghost),
      armedSources,
    ).result;
    expect(second).toMatchObject({ architecture: null, calls: 2 });
    expect(second.failure).toBe("verifying the claims failed: Error");
  });

  it("draws no diagram, and logs why, when the diagram fails verification", async () => {
    forced.diagram = 'flowchart LR\n  click n1 "https://example.com"';
    const { result, lines } = run(() => architectureDraft());
    const outcome = await result;
    expect(outcome.failure).toBeNull();
    expect(outcome.architecture?.diagram).toBeNull();
    expect(lines.filter((l) => l.startsWith("architecture: diagram refused: "))).not.toEqual([]);
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
