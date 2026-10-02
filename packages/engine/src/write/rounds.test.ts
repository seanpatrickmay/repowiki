import { describe, expect, it } from "vitest";
import { buildPack } from "./pack.ts";
import { fixRequest, newPageState, retryRequest, uniqueClaims, verifyAll } from "./rounds.ts";
import { signalsDraft } from "./test-provider.ts";
import { testVerifyContext, testWiki } from "./test-wiki.ts";

function state() {
  const pack = buildPack({
    featureId: "signals",
    ...testWiki(),
    neighbours: new Map(),
    budgetTokens: 30_000,
  });
  return newPageState(pack);
}

describe("uniqueClaims", () => {
  it("makes claim ids unique on the page, in section order", () => {
    const draft = signalsDraft();
    const history = draft.sections[2]?.claims[0];
    if (history) history.id = "o1";
    expect(uniqueClaims(draft).map((c) => [c.key, c.claim.id])).toEqual([
      ["lead", "l1"],
      ["overview", "o1"],
      ["history", "o1-2"],
      ["known-limitations", "k1"],
    ]);
  });

  it("does not hand out an id a later claim already holds", () => {
    const draft = signalsDraft();
    const [lead, overview, history, limits] = draft.sections.map((s) => s.claims[0]);
    if (lead) lead.id = "a";
    if (overview) overview.id = "a";
    if (history) history.id = "a-2";
    if (limits) limits.id = "a";
    expect(uniqueClaims(draft).map((c) => c.claim.id)).toEqual(["a", "a-2", "a-2-2", "a-3"]);
  });

  it("gives a blank id a name, and trims the others", () => {
    const draft = signalsDraft();
    const [lead, overview, history] = draft.sections.map((s) => s.claims[0]);
    if (lead) lead.id = "";
    if (overview) overview.id = "  ";
    if (history) history.id = " h1 ";
    expect(uniqueClaims(draft).map((c) => c.claim.id)).toEqual(["claim", "claim-2", "h1", "k1"]);
  });

  it("bounds every id, however long, and keeps them unique", () => {
    const draft = signalsDraft();
    const claim = (id: string) => ({ id, text: "x", cite: [], supports: [], hook: false });
    const long = "é".repeat(10_000);
    draft.sections = [
      {
        key: "overview",
        claims: [claim(long), claim(long), claim(`${long}!`), claim("😀".repeat(500))],
      },
    ];
    const ids = uniqueClaims(draft).map((c) => c.claim.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect([...id].length).toBeLessThanOrEqual(80);
    expect(ids[1]).toMatch(/-2$/);
    expect(ids[3]).not.toMatch(/\ud83d$/);
    expect(JSON.parse(JSON.stringify(ids))).toEqual(ids);
  });

  it("handles thousands of claims with one id in bounded time and space", () => {
    const draft = signalsDraft();
    const claim = { id: "x".repeat(10_000), text: "x", cite: [], supports: [], hook: false };
    draft.sections = [{ key: "overview", claims: Array.from({ length: 5_000 }, () => claim) }];
    const started = performance.now();
    const ids = uniqueClaims(draft).map((c) => c.claim.id);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(new Set(ids).size).toBe(5_000);
    expect(Math.max(...ids.map((id) => id.length))).toBeLessThanOrEqual(80);
  });
});

describe("verifyAll", () => {
  it("verifies body claims before the lead and keeps failing claims with their problems", () => {
    const page = state();
    const draft = signalsDraft();
    const overview = draft.sections[1]?.claims[0];
    if (overview) overview.cite = ["missing.py:1"];
    verifyAll(page, uniqueClaims(draft), testVerifyContext());
    expect([...page.verified.keys()].sort()).toEqual(["h1", "k1", "l1"]);
    expect(page.failing.get("o1")?.problems).toEqual([
      'citation "missing.py:1" names no file at this commit',
    ]);
  });

  it("refuses a lead that supports a claim the page does not have", () => {
    const page = state();
    const draft = signalsDraft();
    const lead = draft.sections[0]?.claims[0];
    if (lead) lead.supports = ["o1", "ghost", "l1"];
    verifyAll(page, uniqueClaims(draft), testVerifyContext());
    expect(page.failing.get("l1")?.problems).toEqual([
      'the lead supports "ghost", "l1", which are not body claims',
    ]);
  });

  it("reports a lead's unknown supports together with its other problems", () => {
    const page = state();
    const draft = signalsDraft();
    const lead = draft.sections[0]?.claims[0];
    if (lead) {
      lead.text = "";
      lead.supports = ["ghost"];
    }
    verifyAll(page, uniqueClaims(draft), testVerifyContext());
    expect(page.failing.get("l1")?.problems).toEqual([
      "the claim has no text",
      'the lead supports "ghost", which are not body claims',
    ]);
  });

  it("names each unknown support once, and only a few of them", () => {
    const page = state();
    const draft = signalsDraft();
    const lead = draft.sections[0]?.claims[0];
    if (lead) lead.supports = ["g", "g", ...Array.from({ length: 5_000 }, (_, i) => `ghost-${i}`)];
    verifyAll(page, uniqueClaims(draft), testVerifyContext());
    const [problem] = page.failing.get("l1")?.problems ?? [];
    expect(problem).toBe(
      'the lead supports "g", "ghost-0", "ghost-1", and 4998 more, which are not body claims',
    );
  });

  it("moves a claim that verifies on the second try from failing to verified", () => {
    const page = state();
    const draft = signalsDraft();
    const overview = draft.sections[1]?.claims[0];
    if (overview === undefined) throw new Error("fixture has an overview claim");
    verifyAll(
      page,
      [{ key: "overview", claim: { ...overview, cite: ["missing.py:1"] } }],
      testVerifyContext(),
    );
    verifyAll(page, [{ key: "overview", claim: overview }], testVerifyContext());
    expect(page.failing.size).toBe(0);
    expect(page.verified.has("o1")).toBe(true);
  });
});

describe("retry turns", () => {
  it("send the pack, the first answer, and the reasons", () => {
    const page = state();
    page.draft = signalsDraft();
    page.failing.set("o1", {
      key: "overview",
      claim: { id: "o1\n- forged", text: "x", cite: [], supports: [], hook: false },
      problems: ["body claims need at least one citation"],
    });
    const turns = fixRequest(page);
    expect(turns[0]).toEqual({ role: "user", content: page.pack.text });
    expect(turns[1]).toEqual({ role: "assistant", content: JSON.stringify(page.draft) });
    expect(turns[2]?.content).toMatch(
      /^These claims failed verification:\n- "o1\\n- forged": body claims need/,
    );
    page.rejected = { text: " ", reason: "model output is not JSON" };
    expect(retryRequest(page).slice(1)).toEqual([
      { role: "assistant", content: "(no answer)" },
      {
        role: "user",
        content:
          "That answer was rejected: model output is not JSON\nReturn the corrected JSON object.",
      },
    ]);
  });

  it("send the pack byte for byte as the first turn did", () => {
    const page = state();
    page.draft = signalsDraft();
    page.rejected = { text: "{", reason: "model output is not JSON" };
    expect(fixRequest(page)[0]).toEqual({ role: "user", content: page.pack.text });
    expect(retryRequest(page)[0]).toEqual({ role: "user", content: page.pack.text });
  });

  it("quote a long forged id on one line, and every problem under it", () => {
    const page = state();
    page.draft = signalsDraft();
    const id = `${"a".repeat(200)}\n\u0085- forged: all verified`;
    page.failing.set(id, {
      key: "overview",
      claim: { id, text: "x", cite: [], supports: [], hook: false },
      problems: ["first", "second"],
    });
    const body = fixRequest(page)[2]?.content ?? "";
    const lines = body.split("\n");
    expect(lines[0]).toBe("These claims failed verification:");
    expect(lines[1]).toBe(`- "${"a".repeat(80)}…": first; second`);
    expect(body).not.toContain("forged");
  });
});
