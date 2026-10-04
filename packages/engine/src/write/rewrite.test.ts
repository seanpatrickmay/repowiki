import { LlmError, LlmOutputError, MAX_TOKENS_STOP_REASON } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import type { UpdateClaim, UpdateDraft } from "../verify/index.ts";
import { MAX_UPDATE_OUTPUT_TOKENS, rewritePages, updateCacheKey } from "./rewrite.ts";
import { type Answer, pageProvider } from "./test-provider.ts";
import { signalsRewrite } from "./test-update.ts";
import { testWiki } from "./test-wiki.ts";

const claim = (o: Partial<UpdateClaim> & Pick<UpdateClaim, "id" | "section">): UpdateClaim => ({
  text: "`ingest_chunk()` stops at 50 signals.",
  cite: ["src/signals/ingest.py:10-24"],
  supports: [],
  hook: false,
  ...o,
});
const lead = claim({
  id: "c1",
  section: "lead",
  text: "**Signal ingestion** turns chunks into signals.",
  cite: [],
  supports: ["c2", "c3"],
});
const overview = claim({ id: "c2", section: "overview" });
const history = claim({
  id: "n1",
  section: "history",
  text: "A revert undid paging through long chunks.",
  cite: ["commit:b111111"],
});
const answer = (...claims: UpdateClaim[]): UpdateDraft => ({
  claims,
  diagram: { nodes: [], edges: [] },
});

async function run(
  respond: (featureId: string, call: number) => Answer,
  rewrites = [signalsRewrite()],
) {
  const { provider, requests } = pageProvider(respond);
  const lines: string[] = [];
  const { outcomes, cacheKey } = await rewritePages(
    { rewrites, ...testWiki() },
    { provider, repoName: "sample", log: (l) => lines.push(l) },
  );
  return { outcome: outcomes[0], outcomes, requests, lines, cacheKey };
}

describe("rewritePages", () => {
  it("replaces the stale claims and adds a history claim from one batched call", async () => {
    const { outcome, requests, cacheKey } = await run(() => answer(lead, overview, history));
    expect([...(outcome?.replaced.keys() ?? [])].sort()).toEqual(["c1", "c2"]);
    expect(outcome?.replaced.get("c2")?.citations[0]).toMatchObject({
      path: "src/signals/ingest.py",
      startLine: 10,
    });
    expect(outcome?.added.map((a) => [a.key, a.claim.text])).toEqual([["history", history.text]]);
    expect(outcome).toMatchObject({
      keptStale: [],
      dropped: [],
      calls: 1,
      failure: null,
      diagram: null,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      purpose: "write",
      featureId: "signals",
      batch: true,
      maxTokens: MAX_UPDATE_OUTPUT_TOKENS,
    });
    // One page: a single call can only write a cache, never read it.
    expect(requests[0]?.cacheKey).toBeUndefined();
    expect(cacheKey).toBeNull();
  });

  it("sends every page's call in one turn, sharing a cached prefix", async () => {
    const deliverables = signalsRewrite({
      featureId: "deliverables",
      claims: [],
      changed: [],
      commits: [],
    });
    const { requests, cacheKey } = await run(
      (featureId) => (featureId === "signals" ? answer(lead, overview) : answer()),
      [signalsRewrite(), deliverables],
    );
    expect(requests.map((r) => r.turn)).toEqual([0, 0]);
    expect(cacheKey).toBe(updateCacheKey(testWiki().index.sha, requests[0]?.system ?? ""));
    expect(requests.every((r) => r.cacheKey === cacheKey)).toBe(true);
  });

  it("retries a failing rewrite once with its problems, and keeps it stale if it fails again", async () => {
    const bad = claim({ id: "c2", section: "overview", cite: ["src/signals/ingest.py:90-99"] });
    const { outcome, requests } = await run((_f, call) =>
      call === 1 ? answer(lead, bad) : { claims: [bad] },
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.turn).toBeGreaterThan(requests[0]?.turn ?? 0);
    expect(requests[1]?.cacheKey).toBeUndefined();
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      '"c2": citation "src/signals/ingest.py:90-99" is outside',
    );
    expect(outcome).toMatchObject({ keptStale: ["c2"], calls: 2 });
    expect([...(outcome?.replaced.keys() ?? [])]).toEqual(["c1"]);
  });

  it("takes a fixed rewrite from the retry", async () => {
    const bad = claim({ id: "c2", section: "overview", cite: ["src/signals/ingest.py:90-99"] });
    const { outcome } = await run((_f, call) =>
      call === 1 ? answer(lead, bad) : { claims: [overview] },
    );
    expect(outcome?.keptStale).toEqual([]);
    expect(outcome?.replaced.has("c2")).toBe(true);
  });

  it("asks again for a stale claim the answer left out", async () => {
    const { requests, outcome } = await run((_f, call) =>
      call === 1 ? answer(lead) : { claims: [overview] },
    );
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      '"c2": no corrected version was returned',
    );
    expect(outcome?.keptStale).toEqual([]);
  });

  it("keeps a claim the model gives up stale, without a retry", async () => {
    const { outcome, requests } = await run(() =>
      answer(lead, claim({ id: "c2", section: "overview", cite: [] })),
    );
    expect(requests).toHaveLength(1);
    expect(outcome?.keptStale).toEqual(["c2"]);
  });

  it("refuses a new claim outside the open sections, or history citing an older commit, and drops it", async () => {
    const stray = claim({ id: "n2", section: "overview" });
    const oldHistory = claim({
      id: "n3",
      section: "history",
      text: "Signals came first.",
      cite: ["commit:a111111"],
    });
    const { outcome, requests } = await run(() => answer(lead, overview, stray, oldHistory));
    const problems = requests[1]?.messages.at(-1)?.content ?? "";
    expect(problems).toContain('"n2": new claims go only in history on this update');
    expect(problems).toContain(
      '"n3": a new history claim cites one of the commits since the last revision',
    );
    expect(outcome?.dropped.map((d) => d.section)).toEqual(["overview", "history"]);
    expect(outcome?.added).toEqual([]);
  });

  it("ignores a rewrite of a claim that is not stale", async () => {
    const { outcome, lines } = await run(() =>
      answer(lead, overview, claim({ id: "c3", section: "history", cite: ["commit:b111111"] })),
    );
    expect(outcome?.replaced.has("c3")).toBe(false);
    expect(lines).toContain('signals: ignored a rewrite of "c3", which is not stale');
  });

  it("asks again whole after an unusable answer", async () => {
    const { outcome, requests } = await run((_f, call) =>
      call === 1 ? new LlmOutputError("model output is not JSON", "{oops") : answer(lead, overview),
    );
    expect(requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(requests[1]?.messages[1]?.content).toBe("{oops");
    expect(outcome?.replaced.size).toBe(2);
  });

  it("asks for a shorter answer, with the same cap, when the first one stopped at max_tokens", async () => {
    const { outcome, requests } = await run((_f, call) =>
      call === 1
        ? new LlmOutputError(
            "model stopped with max_tokens",
            '{"claims":[',
            undefined,
            MAX_TOKENS_STOP_REASON,
          )
        : answer(lead, overview),
    );
    expect(requests.map((r) => r.maxTokens)).toEqual([
      MAX_UPDATE_OUTPUT_TOKENS,
      MAX_UPDATE_OUTPUT_TOKENS,
    ]);
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      "model stopped with max_tokens; it was too long, so answer shorter, with fewer and shorter claims",
    );
    expect(outcome?.replaced.size).toBe(2);
  });

  it("reports a call that failed, so the update can stop", async () => {
    const { outcome } = await run(() => new LlmError("the batch expired"));
    expect(outcome?.failure).toBe("the update call failed: LlmError: the batch expired");
  });

  it("takes the diagram only when the pack offered candidates", async () => {
    const drawn = {
      claims: [lead, overview],
      diagram: { nodes: ["n1", "n2"], edges: [{ from: "n1", to: "n2", label: "saves" }] },
    };
    const { outcome } = await run(() => drawn, [signalsRewrite({ membershipChanged: true })]);
    expect(outcome?.diagram).toEqual(drawn.diagram);
    const { outcome: kept } = await run(() => drawn);
    expect(kept?.diagram).toBeNull();
  });
});
