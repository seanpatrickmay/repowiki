import { Revision } from "@repowiki/core";
import { LlmError, LlmOutputError } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
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
  return { written: writePages(testWiki(), options), requests, lines };
}

const answers = (featureId: string) =>
  featureId === "signals" ? signalsDraft() : deliverablesDraft();

describe("writePages", () => {
  it("drops a claim that fails verification, logs it, and keeps the rest of the page", async () => {
    const broken = signalsDraft();
    const limitation = broken.sections[3]?.claims[0];
    if (limitation) limitation.cite = ["src/signals/ingest.py:10-14"];
    const { written, lines } = run((featureId) =>
      featureId === "signals" ? broken : deliverablesDraft(),
    );
    const { pages } = await written;
    expect(pages[1]?.dropped).toEqual([
      {
        section: "known-limitations",
        text: "A TODO notes that long chunks are truncated.",
        problems: [
          "limitation claims must cite evidence: lines with a TODO or FIXME, a skipped test, or a reverting commit",
        ],
      },
    ]);
    expect(pages[1]?.revision?.sections.map((s) => s.key)).toEqual(["lead", "overview", "history"]);
    expect(lines).toEqual([
      expect.stringMatching(/^signals: dropped a known-limitations claim: limitation claims/),
    ]);
  });

  it("does not write a page whose answer is unusable", async () => {
    const { written } = run((featureId) =>
      featureId === "signals"
        ? new LlmOutputError("model output is not JSON", "{oops")
        : answers(featureId),
    );
    const { pages } = await written;
    expect(pages[1]).toMatchObject({
      revision: null,
      failure: "the write call returned no usable page",
      calls: 1,
    });
  });

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
      ["deliverables", 1],
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
});
