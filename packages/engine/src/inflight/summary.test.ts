import { contentHash, type InFlightFeature } from "@repowiki/core";
import { INGEST_PY, makeGitHubPull, makeManifest, SHA_C } from "@repowiki/core/test-fixtures";
import type { GenerateRequest, Provider } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import type { FileChange } from "../index/index.ts";
import { citedLines } from "../verify/index.ts";
import {
  type InFlightAnswer,
  type SummaryRequest,
  summarize,
  summaryRequest,
  verifySummary,
} from "./summary.ts";
import type { PackInput } from "./summary-pack.ts";

const HEAD = INGEST_PY.replace("    signals = []", "    signals = list()");
const change: FileChange = {
  status: "modified",
  oldPath: "src/signals/ingest.py",
  newPath: "src/signals/ingest.py",
  hunks: [{ oldStart: 12, oldCount: 1, newStart: 12, newCount: 1 }],
  binary: false,
};
const signals: InFlightFeature = {
  featureId: "signals",
  files: 1,
  changedLines: 2,
  added: 0,
  removed: 0,
  churn: 0,
  drifts: false,
};
const manifest = makeManifest();

function packInput(number = 12): PackInput {
  return {
    pull: makeGitHubPull({ number }),
    manifest,
    features: [signals],
    changes: [change],
    files: [
      {
        path: "src/signals/ingest.py",
        oldPath: "src/signals/ingest.py",
        status: "modified",
        additions: 1,
        deletions: 1,
        featureId: "signals",
        placement: "member",
      },
    ],
    base: new Map([["src/signals/ingest.py", INGEST_PY]]),
    // The deliverables file is unchanged: the pack never shows it, so it cannot be cited.
    head: new Map([
      ["src/signals/ingest.py", HEAD],
      ["src/deliverables/crud.py", "def complete(d):\n    return d\n"],
    ]),
  };
}
const request = (): SummaryRequest => summaryRequest(packInput(), "claude-haiku-4-5");
const call = {
  model: "claude-haiku-4-5-20251001",
  usage: { in: 4000, out: 300, cacheRead: 0, cacheWrite: 0 },
};
const AT = "2026-10-04T12:00:00.000Z";
const claim = (overrides: Partial<InFlightAnswer["claims"][number]> = {}) => ({
  text: "The pull request builds the [[Signal ingestion]] list with `list()`.",
  cite: ["src/signals/ingest.py:11-13"],
  features: ["signals"],
  ...overrides,
});

describe("summaryRequest", () => {
  it("shows the head lines around the change and can cite only changed files", () => {
    const r = request();
    expect(r.number).toBe(12);
    expect(r.headSha).toBe(SHA_C);
    expect(r.key).toMatch(/^[0-9a-f]{64}$/);
    expect([...(r.shown.get("src/signals/ingest.py") ?? [])].sort((a, b) => a - b)).toEqual([
      9, 10, 11, 12, 13, 14, 15,
    ]);
    expect([...r.sources.keys()]).toEqual(["src/signals/ingest.py"]);
    expect(r.touched).toEqual(["signals"]);
  });
});

describe("verifySummary (R10)", () => {
  it("keeps a claim citing shown head lines, hashes them at the head and links its text", () => {
    const { summary, dropped } = verifySummary(
      request(),
      { claims: [claim({ features: ["signals", "deliverables", "ghost"] })] },
      manifest,
      call,
      AT,
    );
    expect(dropped).toBe(0);
    expect(summary).toEqual({
      model: call.model,
      generatedAt: AT,
      tokens: call.usage,
      claims: [
        {
          id: "p12-c1",
          text: "The pull request builds the [[signals|Signal ingestion]] list with `list()`.",
          citations: [
            {
              kind: "code",
              path: "src/signals/ingest.py",
              startLine: 11,
              endLine: 13,
              sha: SHA_C,
              symbol: null,
              contentHash: contentHash(citedLines(HEAD, 11, 13)),
            },
          ],
          features: ["signals"],
        },
      ],
    });
  });

  it.each([
    ["a file the pull request does not change", { cite: ["src/deliverables/crud.py:1-2"] }],
    ["head lines the pack never showed", { cite: ["src/signals/ingest.py:1-3"] }],
    ["a range past the shown lines", { cite: ["src/signals/ingest.py:12-20"] }],
    ["a commit", { cite: ["commit:cccccccc"] }],
    ["no citation", { cite: [] }],
    ["four citations", { cite: Array(4).fill("src/signals/ingest.py:12-12") }],
    ["a citation in its text", { text: "It edits src/signals/ingest.py:12 to call list()." }],
    ["two paragraphs", { text: "One.\n\nTwo." }],
    ["a markdown link", { text: "See [the docs](https://example.com/x) for it." }],
    ["no text", { text: "   " }],
  ])("drops a claim citing %s", (_name, overrides) => {
    const verified = verifySummary(request(), { claims: [claim(overrides)] }, manifest, call, AT);
    expect(verified).toEqual({ summary: null, dropped: 1 });
  });

  it("keeps at most five claims, numbering the kept ones in order", () => {
    const claims = [claim({ cite: [] }), ...Array.from({ length: 6 }, () => claim())];
    const { summary, dropped } = verifySummary(request(), { claims }, manifest, call, AT);
    expect(summary?.claims.map((c) => c.id)).toEqual([
      "p12-c1",
      "p12-c2",
      "p12-c3",
      "p12-c4",
      "p12-c5",
    ]);
    expect(dropped).toBe(2);
  });
});

/** A provider answering each request with `answer(request)`, recording every request. */
function scripted(answer: (request: GenerateRequest<unknown>) => InFlightAnswer | Error) {
  const seen: GenerateRequest<unknown>[] = [];
  let pending = 0;
  let maxPending = 0;
  const provider: Provider = {
    async generate<T>(req: GenerateRequest<T>) {
      seen.push(req as GenerateRequest<unknown>);
      pending++;
      maxPending = Math.max(maxPending, pending);
      await Promise.resolve();
      pending--;
      const out = answer(req as GenerateRequest<unknown>);
      if (out instanceof Error) throw out;
      return { output: out as T, usage: call.usage, model: call.model };
    },
  };
  return { provider, seen, maxPending: () => maxPending };
}

describe("summarize", () => {
  it("sends every request in one tick, batched, with no cache key, and verifies each answer", async () => {
    const requests = [12, 13, 14].map((n) => summaryRequest(packInput(n), "claude-haiku-4-5"));
    const { provider, seen, maxPending } = scripted((req) => {
      const user = String(req.messages[0]?.content);
      if (user.includes("#13 ")) return new Error("batch item errored");
      if (user.includes("#14 ")) return { claims: [claim({ cite: [] })] };
      return { claims: [claim()] };
    });
    const outcomes = await summarize(requests, manifest, provider, {
      batch: true,
      now: () => new Date(AT),
    });
    expect(maxPending()).toBe(3);
    expect(seen.map((r) => [r.purpose, r.batch, r.cacheKey, r.maxTokens])).toEqual(
      Array(3).fill(["inflight", true, undefined, 1500]),
    );
    expect(outcomes.get(12)?.summary?.claims).toHaveLength(1);
    expect(outcomes.get(13)).toEqual({ summary: null, failure: "batch item errored" });
    expect(outcomes.get(14)).toEqual({ summary: null, failure: "no claim verified (1 dropped)" });
  });
});
