import { Revision } from "@repowiki/core";
import { makeFeature } from "@repowiki/core/test-fixtures";
import { CassetteMissError, LlmError, LlmOutputError } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { LIMITATION_EVIDENCE_PROBLEM } from "../verify/index.ts";
import { type WritePagesOptions, writeCacheKey, writePages } from "./build.ts";
import { memoryWikipediaCache } from "./test-cache.ts";
import {
  type Answer,
  deliverablesDraft,
  fakeWikipedia,
  pageProvider,
  signalsDraft,
} from "./test-provider.ts";
import { testWiki } from "./test-wiki.ts";

function run(
  answer: (featureId: string, call: number) => Answer,
  extra: Partial<WritePagesOptions> = {},
  wiki: ReturnType<typeof testWiki> & { only?: string[] } = testWiki(),
) {
  const { provider, requests } = pageProvider(answer);
  const lines: string[] = [];
  const options: WritePagesOptions = {
    provider,
    repoName: "next-chief-of-staff",
    wikipedia: { cache: memoryWikipediaCache(), fetch: fakeWikipedia },
    now: () => new Date("2026-10-01T12:00:00Z"),
    log: (line) => lines.push(line),
    ...extra,
  };
  return { written: writePages(wiki, options), requests, lines };
}

const answers = (featureId: string) =>
  featureId === "signals" ? signalsDraft() : deliverablesDraft();

describe("writePages", () => {
  it("writes one verified, linked page per active feature", async () => {
    const { written, requests } = run(answers);
    const { pages, cacheKey, system } = await written;
    expect(pages.map((p) => [p.featureId, p.failure, p.calls])).toEqual([
      ["deliverables", null, 1],
      ["signals", null, 1],
    ]);
    const signals = pages[1]?.revision;
    expect(Revision.parse(signals)).toEqual(signals);
    expect(signals).toMatchObject({
      id: `signals-${"a".repeat(12)}`,
      reason: "build",
      parentId: null,
      model: "claude-haiku-4-5-20251001",
      tokens: { in: 100, out: 10, cacheRead: 0, cacheWrite: 0 },
      seeAlso: ["deliverables"],
      diagram:
        'flowchart LR\n  n1["src/signals/ingest.py"]\n  n2["src/signals/store.py"]\n  n1 -->|"saves signals"| n2',
    });
    expect(signals?.sections.map((s) => [s.key, s.claims.map((c) => c.text)])).toEqual([
      [
        "lead",
        [
          "**Signal ingestion** turns chunks into signals for [[deliverables|deliverable records]].",
        ],
      ],
      [
        "overview",
        ["`ingest_chunk()` keeps at most 50 signals, like a [[wp:Message queue]] would."],
      ],
      ["history", ["Signal ingestion was added in January 2026."]],
      ["known-limitations", ["A TODO notes that long chunks are truncated."]],
    ]);
    expect(cacheKey).toBe(writeCacheKey("a".repeat(40), system));
    expect(
      requests.every((r) => r.purpose === "write" && r.batch === true && r.cacheKey === cacheKey),
    ).toBe(true);
  });

  it("issues every page's first call in one event-loop turn, so they share one batch", async () => {
    const { written, requests } = run(answers);
    await written;
    expect(requests.map((r) => [r.featureId, r.turn])).toEqual([
      ["deliverables", 0],
      ["signals", 0],
    ]);
  });

  it("retries failing claims once, in one later turn, quoting the verifier's problems", async () => {
    const broken = signalsDraft();
    const overview = broken.sections[1]?.claims[0];
    if (overview) overview.cite = ["src/signals/ingest.py:90-99"];
    const { written, requests } = run((featureId, call) => {
      if (featureId !== "signals") return deliverablesDraft();
      if (call === 1) return broken;
      return {
        claims: [
          {
            ...(overview ?? signalsDraft().sections[0]?.claims[0]),
            cite: ["src/signals/ingest.py:10-24"],
          },
        ],
      } as Answer;
    });
    const { pages } = await written;
    expect(pages[1]?.calls).toBe(2);
    expect(pages[1]?.dropped).toEqual([]);
    const retry = requests[2];
    expect(retry?.turn).toBe(1);
    expect(retry?.cacheKey).toBeUndefined();
    expect(retry?.messages.at(-1)?.content).toContain(
      '- "o1": citation "src/signals/ingest.py:90-99" is outside the file\'s lines 1-31',
    );
    expect(pages[1]?.revision?.sections[1]?.claims[0]?.citations[0]).toMatchObject({
      startLine: 10,
      endLine: 24,
    });
  });

  it("drops a claim that fails twice, logs it, and keeps the rest of the page", async () => {
    const broken = signalsDraft();
    const overview = broken.sections[1]?.claims[0];
    if (overview) overview.cite = ["src/signals/ingest.py:90-99"];
    const { written, lines } = run((featureId, call) =>
      featureId !== "signals"
        ? deliverablesDraft()
        : call === 1
          ? broken
          : ({ claims: [overview] } as Answer),
    );
    const { pages } = await written;
    expect(pages[1]?.calls).toBe(2);
    expect(pages[1]?.dropped).toEqual([
      {
        section: "overview",
        text: "`ingest_chunk()` keeps at most 50 signals, like a [[wp:Message queue]] would.",
        problems: ['citation "src/signals/ingest.py:90-99" is outside the file\'s lines 1-31'],
      },
    ]);
    expect(pages[1]?.revision?.sections.map((s) => s.key)).toEqual([
      "lead",
      "history",
      "known-limitations",
    ]);
    expect(lines).toEqual([
      expect.stringMatching(/^signals: dropped an? overview claim: citation/),
    ]);
  });

  it("drops a limitation claim that lacks only evidence at once: no retry can give it one", async () => {
    const broken = signalsDraft();
    const limitation = broken.sections[3]?.claims[0];
    if (limitation) limitation.cite = ["src/signals/ingest.py:10-14"];
    const { written, requests, lines } = run((featureId) =>
      featureId !== "signals" ? deliverablesDraft() : broken,
    );
    const { pages } = await written;
    expect(requests).toHaveLength(2);
    expect(pages[1]?.calls).toBe(1);
    expect(pages[1]?.dropped).toEqual([
      {
        section: "known-limitations",
        text: "A TODO notes that long chunks are truncated.",
        problems: [LIMITATION_EVIDENCE_PROBLEM],
      },
    ]);
    expect(pages[1]?.revision?.sections.map((s) => s.key)).toEqual(["lead", "overview", "history"]);
    expect(lines).toEqual([
      expect.stringMatching(/^signals: dropped a known-limitations claim: limitation claims/),
    ]);
  });

  it("retries a page's other failing claims without the evidence-less limitation claim", async () => {
    const broken = signalsDraft();
    const overview = broken.sections[1]?.claims[0];
    if (overview) overview.cite = ["src/signals/ingest.py:90-99"];
    const limitation = broken.sections[3]?.claims[0];
    if (limitation) limitation.cite = ["src/signals/ingest.py:10-14"];
    const { written, requests } = run((featureId, call) =>
      featureId !== "signals"
        ? deliverablesDraft()
        : call === 1
          ? broken
          : ({ claims: [{ ...overview, cite: ["src/signals/ingest.py:10-24"] }] } as Answer),
    );
    const { pages } = await written;
    const turn = requests[2]?.messages.at(-1)?.content ?? "";
    expect(turn).toContain('- "o1": ');
    expect(turn).not.toContain('"k1"');
    expect(pages[1]?.dropped.map((d) => d.section)).toEqual(["known-limitations"]);
    expect(pages[1]?.revision?.sections.map((s) => s.key)).toEqual(["lead", "overview", "history"]);
  });

  it("asks again for the whole page when the first answer is unusable", async () => {
    const { written, requests } = run((featureId, call) =>
      featureId !== "signals" || call === 2
        ? answers(featureId)
        : new LlmOutputError("model output is not JSON", "{oops"),
    );
    const { pages } = await written;
    expect(pages[1]?.failure).toBeNull();
    expect(requests[2]?.messages.slice(1)).toEqual([
      { role: "assistant", content: "{oops" },
      {
        role: "user",
        content:
          "That answer was rejected: model output is not JSON\nReturn the corrected JSON object.",
      },
    ]);
  });

  it("issues every retry in one event-loop turn, with no cacheKey, after the first round", async () => {
    const broken = (featureId: string) => {
      const draft = answers(featureId);
      const body = draft.sections[1]?.claims[0];
      if (body) body.cite = ["src/signals/ingest.py:90-99"];
      return draft;
    };
    const { written, requests } = run((featureId, call) =>
      call === 1 ? broken(featureId) : ({ claims: [] } as Answer),
    );
    await written;
    expect(requests.map((r) => [r.featureId, r.turn, r.cacheKey === undefined, r.batch])).toEqual([
      ["deliverables", 0, false, true],
      ["signals", 0, false, true],
      ["deliverables", 1, true, true],
      ["signals", 1, true, true],
    ]);
  });

  it("ignores a fix for an id that is not failing, and keeps the claim it did not fix", async () => {
    const broken = signalsDraft();
    const overview = broken.sections[1]?.claims[0];
    if (overview) overview.cite = ["src/signals/ingest.py:90-99"];
    const wrong = {
      ...(overview as NonNullable<typeof overview>),
      id: "h1",
      cite: ["src/signals/ingest.py:10-24"],
    };
    const stray = { ...wrong, id: "zzz" };
    const { written, lines } = run((featureId, call) =>
      featureId !== "signals"
        ? deliverablesDraft()
        : call === 1
          ? broken
          : ({ claims: [wrong, stray] } as Answer),
    );
    const { pages } = await written;
    expect(pages[1]?.dropped.map((d) => d.text)).toEqual([overview?.text]);
    expect(pages[1]?.revision?.sections.map((s) => s.key)).toEqual([
      "lead",
      "history",
      "known-limitations",
    ]);
    const history = pages[1]?.revision?.sections.find((s) => s.key === "history");
    expect(history?.claims[0]?.text).toBe("Signal ingestion was added in January 2026.");
    expect(lines).toHaveLength(1);
  });

  it("drops a body claim given up with an empty cite list, and a lead claim with no supports", async () => {
    const broken = signalsDraft();
    const overview = broken.sections[1]?.claims[0];
    if (overview) overview.cite = ["src/signals/ingest.py:90-99"];
    const lead = broken.sections[0]?.claims[0];
    if (lead) lead.supports = ["nowhere"];
    const { written, lines } = run((featureId, call) =>
      featureId !== "signals"
        ? deliverablesDraft()
        : call === 1
          ? broken
          : ({
              claims: [
                { ...overview, cite: [] },
                { ...lead, supports: [] },
              ],
            } as Answer),
    );
    const { pages } = await written;
    expect(pages[1]?.dropped.map((d) => d.section)).toEqual(["overview", "lead"]);
    expect(pages[1]?.failure).toBe("no lead or no body claim survived verification");
    expect(lines.filter((l) => l.includes("dropped a"))).toHaveLength(2);
  });

  it("verifies a fixed lead claim whose supports it still names", async () => {
    const broken = signalsDraft();
    const lead = broken.sections[0]?.claims[0];
    if (lead) lead.supports = ["nowhere"];
    const { written } = run((featureId, call) =>
      featureId !== "signals"
        ? deliverablesDraft()
        : call === 1
          ? broken
          : ({ claims: [{ ...lead, supports: ["o1", "h1"] }] } as Answer),
    );
    const { pages } = await written;
    expect(pages[1]?.dropped).toEqual([]);
    expect(pages[1]?.failure).toBeNull();
    expect(pages[1]?.revision?.sections[0]?.key).toBe("lead");
  });

  it("adds the retry's tokens to the page's, a rejected retry's included", async () => {
    const usage = { in: 700, out: 80, cacheRead: 5, cacheWrite: 9 };
    const { written } = run((featureId) =>
      featureId === "signals"
        ? new LlmOutputError("model output is not JSON", "{oops", {
            usage,
            model: "claude-haiku-4-5-20251001",
          })
        : answers(featureId),
    );
    const { pages } = await written;
    expect(pages[1]).toMatchObject({
      revision: null,
      calls: 2,
      tokens: { in: 1400, out: 160, cacheRead: 10, cacheWrite: 18 },
    });
    expect(pages[0]).toMatchObject({ calls: 1, tokens: { in: 100, out: 10 } });
  });

  it("adds a fix call's tokens to the page's", async () => {
    const broken = signalsDraft();
    const overview = broken.sections[1]?.claims[0];
    if (overview) overview.cite = ["src/signals/ingest.py:90-99"];
    const { written } = run((featureId, call) =>
      featureId !== "signals"
        ? deliverablesDraft()
        : call === 1
          ? broken
          : ({ claims: [{ ...overview, cite: ["src/signals/ingest.py:10-24"] }] } as Answer),
    );
    const { pages } = await written;
    expect(pages[1]).toMatchObject({ calls: 2, tokens: { in: 200, out: 20 } });
    expect(pages[1]?.revision?.tokens).toEqual(pages[1]?.tokens);
  });

  it("does not write a page whose retry call fails, and still writes the others", async () => {
    const broken = signalsDraft();
    const overview = broken.sections[1]?.claims[0];
    if (overview) overview.cite = ["src/signals/ingest.py:90-99"];
    class ApiError extends Error {}
    const { written, lines } = run((featureId, call) =>
      featureId !== "signals"
        ? deliverablesDraft()
        : call === 1
          ? broken
          : new ApiError("the model said something private"),
    );
    const { pages } = await written;
    expect(pages.map((p) => [p.featureId, p.revision === null, p.calls])).toEqual([
      ["deliverables", false, 1],
      ["signals", true, 1],
    ]);
    expect(pages[1]?.failure).toBe("the write call failed twice: ApiError");
    expect(lines).toContain("signals: not written: the write call failed twice: ApiError");
  });

  it("does not write a page whose whole-page retry is rejected again", async () => {
    const { written } = run((featureId) =>
      featureId === "signals"
        ? new LlmOutputError("model output is not JSON", "{oops")
        : answers(featureId),
    );
    const { pages } = await written;
    expect(pages[1]).toMatchObject({
      revision: null,
      failure: "the write call failed twice: LlmOutputError: model output is not JSON",
      calls: 2,
    });
    expect(pages[0]?.revision).not.toBeNull();
  });

  it("does not write a page whose call fails, and still writes the others", async () => {
    const { written, lines } = run((featureId) =>
      featureId === "signals"
        ? new LlmError("batch request req-1 did not succeed: expired")
        : answers(featureId),
    );
    const { pages } = await written;
    expect(pages.map((p) => [p.featureId, p.revision === null])).toEqual([
      ["deliverables", false],
      ["signals", true],
    ]);
    expect(lines).toEqual([
      "signals: not written: the write call failed: LlmError: batch request req-1 did not succeed: expired",
    ]);
  });

  it("counts only answered calls: a failed call is none, a rejected answer is one", async () => {
    const { written } = run((featureId) =>
      featureId === "signals"
        ? new LlmError("batch request req-1 did not succeed: expired")
        : new LlmOutputError("model output is not JSON", "{oops"),
    );
    const { pages } = await written;
    expect(pages.map((p) => [p.featureId, p.calls])).toEqual([
      ["deliverables", 2],
      ["signals", 0],
    ]);
  });

  it("verifies and stores the draft under unique claim ids", async () => {
    const draft = deliverablesDraft();
    const overview = draft.sections[1];
    const first = overview?.claims[0];
    if (overview && first)
      overview.claims.push({ ...first, text: "`complete()` is also idempotent." });
    const { written } = run((featureId) => (featureId === "signals" ? signalsDraft() : draft));
    const { pages } = await written;
    expect(pages[0]?.failure).toBeNull();
    expect(pages[0]?.revision?.sections.map((s) => [s.key, s.claims.length])).toEqual([
      ["lead", 1],
      ["overview", 2],
    ]);
  });

  it("fails one page, not the build, when its assembly throws, and names only the error class", async () => {
    let calls = 0;
    const { written, lines } = run(answers, {
      now: () => {
        calls += 1;
        if (calls === 1) throw new RangeError("the model said something private");
        return new Date("2026-10-01T12:00:00Z");
      },
    });
    const { pages } = await written;
    expect(pages.map((p) => [p.featureId, p.failure, p.revision === null])).toEqual([
      ["deliverables", "assembling the page failed: RangeError", true],
      ["signals", null, false],
    ]);
    expect(lines).toEqual(["deliverables: not written: assembling the page failed: RangeError"]);
  });

  it("logs a failed call's error class only, unless it is an LlmError with its own message", async () => {
    class ApiError extends Error {}
    const { written, lines } = run((featureId) =>
      featureId === "signals"
        ? new ApiError('400 {"error":"the model said something private"}')
        : answers(featureId),
    );
    const { pages } = await written;
    expect(pages[1]?.failure).toBe("the write call failed: ApiError");
    expect(lines).toEqual(["signals: not written: the write call failed: ApiError"]);
  });

  it("asks again when an answer has no lead claim or no body claim, and writes the retry", async () => {
    const noLead = deliverablesDraft();
    noLead.sections = noLead.sections.filter((s) => s.key !== "lead");
    const noBody = signalsDraft();
    noBody.sections = noBody.sections.filter((s) => s.key === "lead");
    const { written, requests, lines } = run((featureId, call) =>
      call === 2 ? answers(featureId) : featureId === "signals" ? noBody : noLead,
    );
    const { pages } = await written;
    expect(pages.map((p) => [p.featureId, p.failure, p.calls, p.dropped])).toEqual([
      ["deliverables", null, 2, []],
      ["signals", null, 2, []],
    ]);
    expect(requests[2]?.messages.at(-1)?.content).toContain(
      "the answer needs at least one lead claim and one body claim",
    );
    expect(lines).toEqual([]);
  });

  it("does not write a page whose retry still has no lead claim or no body claim", async () => {
    const noLead = deliverablesDraft();
    noLead.sections = noLead.sections.filter((s) => s.key !== "lead");
    const { written, lines } = run((featureId) =>
      featureId === "signals" ? signalsDraft() : noLead,
    );
    const { pages } = await written;
    expect(pages[0]).toMatchObject({
      revision: null,
      failure: "no lead or no body claim survived verification",
      calls: 2,
    });
    expect(lines).toEqual([
      "deliverables: not written: no lead or no body claim survived verification",
    ]);
  });

  it("writes only the features named by `only`", async () => {
    const wiki = { ...testWiki(), only: ["signals"] };
    const { written, requests } = run(answers, {}, wiki);
    const { pages, packs } = await written;
    expect(pages.map((p) => p.featureId)).toEqual(["signals"]);
    expect(packs.map((p) => p.featureId)).toEqual(["signals"]);
    expect(requests.map((r) => r.featureId)).toEqual(["signals"]);
  });

  it("writes no page for a retired feature or a redirect", async () => {
    const wiki = testWiki();
    wiki.manifest.features.push(
      makeFeature({
        id: "old-signals",
        title: "Old signals",
        aliases: [],
        status: { kind: "retired" },
      }),
      makeFeature({
        id: "legacy-deliverables",
        title: "Legacy deliverables",
        aliases: [],
        status: { kind: "redirect", to: "deliverables" },
      }),
    );
    const { written, requests } = run(answers, {}, wiki);
    const { pages } = await written;
    expect(pages.map((p) => p.featureId)).toEqual(["deliverables", "signals"]);
    expect(requests.map((r) => r.featureId)).toEqual(["deliverables", "signals"]);
  });

  it("sends batch: false when asked", async () => {
    const { written, requests } = run(answers, { batch: false });
    await written;
    expect(requests.map((r) => r.batch)).toEqual([false, false]);
    expect(requests.every((r) => r.cacheKey?.startsWith("write-"))).toBe(true);
  });

  it("fetches each Wikipedia title once, and none from a dropped claim", async () => {
    const urls: string[] = [];
    const fetch = async (input: string | URL | Request) => {
      urls.push(String(input));
      return fakeWikipedia(input);
    };
    const signals = signalsDraft();
    const limitation = signals.sections[3]?.claims[0];
    if (limitation) {
      limitation.text = "A TODO notes that [[wp:Dropped page]] is truncated.";
      limitation.cite = ["src/signals/ingest.py:10-14"];
    }
    const deliverables = deliverablesDraft();
    const overview = deliverables.sections[1]?.claims[0];
    if (overview) overview.text = "`complete()` is like a [[wp:Message queue]] for notes.";
    const { written } = run((featureId) => (featureId === "signals" ? signals : deliverables), {
      wikipedia: { cache: memoryWikipediaCache(), fetch },
    });
    const { wikipedia } = await written;
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/Message_queue$/);
    expect([...wikipedia.links.keys()]).toEqual(["Message queue"]);
  });

  it("fails one page, not the build, when verifying its claims throws", async () => {
    const wiki = testWiki();
    let armed = false;
    class Sources extends Map<string, string> {
      override get(path: string) {
        if (armed && path === "src/signals/ingest.py") throw new TypeError("private source text");
        return super.get(path);
      }
    }
    const sources = new Sources(wiki.sources);
    const { written, lines } = run(
      (featureId) => {
        armed = true;
        return answers(featureId);
      },
      {},
      { ...wiki, sources },
    );
    const { pages } = await written;
    expect(pages.map((p) => [p.featureId, p.failure, p.revision === null])).toEqual([
      ["deliverables", null, false],
      ["signals", "verifying the claims failed: TypeError", true],
    ]);
    expect(lines).toEqual(["signals: not written: verifying the claims failed: TypeError"]);
  });

  it("writes every page with plain Wikipedia text when the title check throws", async () => {
    const cache = {
      get: () => {
        throw new RangeError("cache is broken");
      },
      put: () => {},
    };
    const { written, lines } = run(answers, { wikipedia: { cache, fetch: fakeWikipedia } });
    const { pages, wikipedia } = await written;
    expect(pages.map((p) => p.failure)).toEqual([null, null]);
    const overview = pages[1]?.revision?.sections.find((s) => s.key === "overview");
    expect(overview?.claims[0]?.text).not.toContain("[[wp:");
    expect(overview?.claims[0]?.text).toContain("Message queue");
    expect([...wikipedia.links]).toEqual([["Message queue", null]]);
    expect(lines).toEqual(["Wikipedia could not be checked (RangeError); left as plain text"]);
  });

  it("does not write a page left without a body", async () => {
    const leadOnly = deliverablesDraft();
    const body = leadOnly.sections[1]?.claims[0];
    if (body) body.cite = [];
    const { written } = run((featureId, call) =>
      featureId === "signals" ? signalsDraft() : call === 1 ? leadOnly : ({ claims: [] } as Answer),
    );
    const { pages } = await written;
    expect(pages[0]).toMatchObject({
      revision: null,
      failure: "no lead or no body claim survived verification",
    });
  });

  it("lets a missing cassette fail the build instead of leaving Wikipedia as plain text", async () => {
    const cache = {
      get: () => {
        throw new CassetteMissError("wikipedia.json", "GET", "/api/rest_v1/page/summary/Lost");
      },
      put: () => {},
    };
    const { written } = run(answers, { wikipedia: { cache, fetch: fakeWikipedia } });
    await expect(written).rejects.toBeInstanceOf(CassetteMissError);
  });
});
