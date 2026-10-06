import { describe, expect, it } from "vitest";
import {
  ASK_HREF,
  AskProgress,
  AskRequest,
  AskResponse,
  AskStatus,
  claimAnchor,
  NOT_FOUND_SENTENCE,
} from "./ask.ts";
import { LedgerEntry, LlmConfigFile, LlmRole } from "./llm.ts";
import { makeAskResponse, makeLedgerEntry, SHA_A } from "./test-fixtures.ts";

describe("claimAnchor", () => {
  it.each(["c3", "s-1", "a_B9", "x".repeat(64)])("anchors %s", (id) => {
    expect(claimAnchor(id)).toBe(`claim-${id}`);
  });

  it.each(["", "c 3", "c.3", "c#3", "<b>", "x".repeat(65), "c\u00e9"])("refuses %j", (id) => {
    expect(claimAnchor(id)).toBeNull();
  });
});

describe("ASK_HREF", () => {
  it.each([
    "/wiki/signals/",
    "/wiki/signals/#claim-s-1",
    "/wiki/signals/#how-it-works",
    "/special/about/",
    "/special/about/#claim-c2",
  ])("accepts %s", (href) => {
    expect(ASK_HREF.test(href)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "//evil.example/wiki/x/",
    "https://evil.example/",
    "/wiki/Signals/",
    "/wiki/signals",
    "/wiki/signals/#claim-a b",
    "/wiki/signals/history/",
    "/special/all-pages/",
    "/wiki/signals/#Overview",
  ])("refuses %s", (href) => {
    expect(ASK_HREF.test(href)).toBe(false);
  });
});

describe("AskRequest", () => {
  it("trims the question and defaults the page hint and fresh", () => {
    expect(AskRequest.parse({ question: "  Where are signals made?\n" })).toEqual({
      question: "Where are signals made?",
      page: null,
      fresh: false,
    });
  });

  it("counts the question's length in code points", () => {
    expect(AskRequest.safeParse({ question: "\u{1F600}".repeat(500) }).success).toBe(true);
    expect(AskRequest.safeParse({ question: "x".repeat(501) }).success).toBe(false);
  });

  it.each([
    ["an empty question", { question: "" }],
    ["a blank question", { question: " \n\t " }],
    ["no question", { page: "signals" }],
    ["a page that is not a string", { question: "q", page: 3 }],
    ["fresh as a string", { question: "q", fresh: "yes" }],
    ["an unknown key", { question: "q", stream: true }],
  ])("refuses %s", (_name, body) => {
    expect(AskRequest.safeParse(body).success).toBe(false);
  });
});

describe("AskProgress", () => {
  it("accepts a search and a page read, and nothing else", () => {
    expect(AskProgress.parse({ step: "search", query: "signals" })).toEqual({
      step: "search",
      query: "signals",
    });
    expect(
      AskProgress.safeParse({ step: "read", pageId: "signals", title: "Signals" }).success,
    ).toBe(true);
    expect(AskProgress.safeParse({ step: "think" }).success).toBe(false);
  });
});

describe("AskResponse", () => {
  it("accepts an answered response", () => {
    expect(AskResponse.parse(makeAskResponse())).toEqual(makeAskResponse());
  });

  it("accepts a not-found answer as the one fixed sentence, and budget and error with none", () => {
    const notFound = makeAskResponse({
      status: "not-found",
      sentences: [{ text: NOT_FOUND_SENTENCE, sources: [] }],
      sources: [],
    });
    expect(AskResponse.safeParse(notFound).success).toBe(true);
    for (const status of ["budget", "error"] as const) {
      const empty = makeAskResponse({ status, sentences: [], sources: [] });
      expect(AskResponse.safeParse(empty).success).toBe(true);
    }
  });

  const answer = makeAskResponse();
  const [first, second] = answer.sources;
  it.each([
    ["a sentence citing no source", { sentences: [{ text: "Uncited.", sources: [] }] }],
    ["a sentence citing a missing source", { sentences: [{ text: "x", sources: [3] }] }],
    ["a sentence citing one source twice", { sentences: [{ text: "x", sources: [1, 1] }] }],
    [
      "a source no sentence cites",
      { sentences: [{ text: "x", sources: [1] }], sources: [first, second] },
    ],
    ["sources out of order", { sources: [second, first] }],
    ["an answered answer with no sentence", { sentences: [], sources: [] }],
    [
      "a not-found answer in the model's words",
      { status: "not-found", sentences: [{ text: "Nothing here.", sources: [] }], sources: [] },
    ],
    ["a budget answer with a sentence", { status: "budget" }],
    ["seven sentences", { sentences: Array(7).fill({ text: "x", sources: [1, 2] }) }],
    ["a sentence of 401 characters", { sentences: [{ text: "x".repeat(401), sources: [1, 2] }] }],
    ["five sources in a sentence", { sentences: [{ text: "x", sources: [1, 2, 3, 4, 5] }] }],
    ["a javascript: link", { sources: [{ ...first, href: "javascript:alert(1)" }, second] }],
    ["an excerpt of 161 characters", { sources: [{ ...first, excerpt: "x".repeat(161) }, second] }],
    ["a short head", { head: "abc1234" }],
    ["a negative cost", { cost: { turns: 1, usd: -1, model: null } }],
    ["an unknown status", { status: "maybe" }],
  ])("refuses %s", (_name, overrides) => {
    expect(AskResponse.safeParse({ ...answer, ...overrides }).success).toBe(false);
  });
});

describe("AskStatus", () => {
  it("is either answering or routing, with a reason", () => {
    const answering = {
      mode: "answer",
      head: SHA_A,
      model: "claude-haiku-4-5",
      questionUsd: 0.05,
      sessionLeftUsd: 1,
    };
    expect(AskStatus.parse(answering)).toEqual(answering);
    for (const reason of ["no-key", "disabled", "budget"]) {
      expect(AskStatus.safeParse({ mode: "routing", head: SHA_A, reason }).success).toBe(true);
    }
    expect(AskStatus.safeParse({ mode: "routing", head: SHA_A, reason: "busy" }).success).toBe(
      false,
    );
  });
});

describe("the ask role (spec v2 #4 R13)", () => {
  it("is an LLM role a ledger row and a config file may name", () => {
    expect(LlmRole.options).toContain("ask");
    const row = makeLedgerEntry({ purpose: "ask" });
    expect(LedgerEntry.parse(row)).toEqual(row);
    expect(LlmConfigFile.parse({ models: { ask: "claude-haiku-4-5" } })).toEqual({
      models: { ask: "claude-haiku-4-5" },
    });
  });

  it("leaves every row written before it readable", () => {
    for (const purpose of ["manifest", "write", "tieBreak", "evalAgent", "evalJudge"]) {
      expect(LedgerEntry.safeParse(makeLedgerEntry({ purpose } as never)).success).toBe(true);
    }
  });
});
