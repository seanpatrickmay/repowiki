import { AskResponse, NOT_FOUND_SENTENCE } from "@repowiki/core";
import { bodyClaim } from "@repowiki/core/test-fixtures";
import { handleClaim, WikiView } from "@repowiki/query";
import { extendedWiki, type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildResponse,
  checkAnswer,
  codeTokens,
  type ResponseInput,
  readNextOf,
  ungroundedToken,
} from "./answer.ts";
import { askIndexes } from "./pack.ts";

let sample: SampleWiki;
let view: WikiView;
beforeAll(() => {
  sample = sampleWiki();
  view = new WikiView(extendedWiki(sample));
});
afterAll(() => sample.repo.remove());

const SHOWN = new Set(["signals#s-1", "signals#s-2", "signals#s-l", "deliverables#d-1"]);
const sentence = (text: string, claims: string[]) => ({ text, claims });
const answer = (sentences: { text: string; claims: string[] }[], status = "answered") => ({
  status,
  sentences,
  readNext: [],
});
const claimsOf = (...handles: string[]) => handles.flatMap((h) => handleClaim(view, h) ?? []);

describe("codeTokens", () => {
  it("finds backtick spans, paths, snake_case, calls and source files", () => {
    expect(
      codeTokens(
        "Use `ingest_chunk` in src/signals/ingest.py, call save_signal() (see README.md).",
      ),
    ).toEqual(["ingest_chunk", "src/signals/ingest.py", "save_signal()", "README.md"]);
  });

  it("leaves plain words alone, GitHub and a sentence's last word included", () => {
    expect(codeTokens("GitHub sends events to the API, then Slack does too.")).toEqual([]);
    expect(codeTokens("It is fast (really).")).toEqual([]);
  });

  it("strips the punctuation around a word but keeps a call's parentheses", () => {
    expect(codeTokens('("src/a.ts"), run()! and `x` .')).toEqual(["x", "src/a.ts", "run()"]);
  });
});

describe("ungroundedToken", () => {
  it("accepts tokens the cited claims write, by text, path, symbol or page title", () => {
    const claims = claimsOf("signals#s-1");
    expect(ungroundedToken(view, "`ingest_chunk` saves with `save_signal`.", claims)).toBeNull();
    expect(ungroundedToken(view, "It is in src/signals/ingest.py.", claims)).toBeNull();
    expect(ungroundedToken(view, "Call ingest_chunk() for a chunk.", claims)).toBeNull();
  });

  it("refuses a file, function or setting the cited claims do not write", () => {
    const claims = claimsOf("signals#s-1");
    expect(ungroundedToken(view, "It lives in src/signals/parse.py.", claims)).toBe(
      "src/signals/parse.py",
    );
    expect(ungroundedToken(view, "Call `split_sentences` first.", claims)).toBe("split_sentences");
    expect(ungroundedToken(view, "Edit config.yaml to change it.", claims)).toBe("config.yaml");
    expect(ungroundedToken(view, "The key is in secrets.txt.", claims)).toBe("secrets.txt");
    expect(ungroundedToken(view, "Its server is main.go.", claims)).toBe("main.go");
    expect(ungroundedToken(view, "MAX_SIGNALS caps it.", claims)).toBe("MAX_SIGNALS");
    expect(ungroundedToken(view, "MAX_SIGNALS caps it.", claimsOf("signals#s-2"))).toBeNull();
  });
});

describe("checkAnswer", () => {
  it("keeps cited sentences, reading handles with or without braces, at most four each", () => {
    const checked = checkAnswer(
      view,
      answer([
        sentence("Signals are made by `ingest_chunk`.", ["{signals#s-1}", "signals#s-1"]),
        sentence("Ingestion stops at `MAX_SIGNALS`.", ["signals#s-2", " {signals#s-l} "]),
      ]),
      SHOWN,
    );
    expect(checked).toEqual({
      status: "answered",
      sentences: [
        { text: "Signals are made by `ingest_chunk`.", handles: ["signals#s-1"] },
        { text: "Ingestion stops at `MAX_SIGNALS`.", handles: ["signals#s-2", "signals#s-l"] },
      ],
      readNext: [],
      refusals: [],
    });
  });

  it("drops handles it did not show and refuses a sentence left with none", () => {
    const checked = checkAnswer(
      view,
      answer([
        sentence("Signals are saved.", ["signals#s-h", "signals#s-1"]),
        sentence("Deliverables are records.", ["deliverables#d-lead", "nowhere#c1", "x"]),
        sentence("No citation at all.", []),
      ]),
      SHOWN,
    );
    expect(checked.sentences).toEqual([{ text: "Signals are saved.", handles: ["signals#s-1"] }]);
    expect(checked.refusals).toEqual([
      { n: 2, reason: "it cites no handle of a claim you were shown" },
      { n: 3, reason: "it cites no handle of a claim you were shown" },
    ]);
  });

  it("refuses a sentence naming an identifier its cited claims do not write", () => {
    const checked = checkAnswer(
      view,
      answer([sentence("It is in src/signals/parse.py.", ["signals#s-1"])]),
      SHOWN,
    );
    expect(checked.sentences).toEqual([]);
    expect(checked.refusals).toEqual([
      { n: 1, reason: "it names a file, function or setting that its cited claims do not write" },
    ]);
  });

  it("stops at six sentences and 120 words", () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      sentence(`Signals are saved, point ${i + 1}.`, ["signals#s-1"]),
    );
    const capped = checkAnswer(view, answer(seven), SHOWN);
    expect(capped.sentences).toHaveLength(6);
    expect(capped.refusals).toEqual([{ n: 7, reason: "it is past the 6-sentence limit" }]);
    const long = checkAnswer(
      view,
      answer([
        sentence("w ".repeat(100).trim(), ["signals#s-1"]),
        sentence("w ".repeat(21).trim(), ["signals#s-1"]),
        sentence("w ".repeat(20).trim(), ["signals#s-1"]),
      ]),
      SHOWN,
    );
    expect(long.sentences.map((s) => s.text.split(" ").length)).toEqual([100, 20]);
    expect(long.refusals).toEqual([{ n: 2, reason: "it is past the 120-word limit" }]);
  });

  it("puts each sentence on one neutralised line of at most 400 characters", () => {
    const checked = checkAnswer(
      view,
      answer([
        sentence("Line one\nline two\u202E <img src=x>", ["signals#s-1"]),
        sentence("x".repeat(10_000), ["signals#s-1"]),
        sentence(" \n ", ["signals#s-1"]),
      ]),
      SHOWN,
    );
    expect(checked.sentences[0]?.text).toBe("Line one line two\uFFFD <img src=x>");
    expect([...(checked.sentences[1]?.text ?? "")]).toHaveLength(400);
    expect(checked.refusals).toEqual([{ n: 3, reason: "it is empty" }]);
  });

  it("finds no answer in input that is not one", () => {
    for (const input of [null, "text", { status: "maybe" }, { status: "answered", sentences: 3 }]) {
      expect(checkAnswer(view, input, SHOWN).status).toBeNull();
    }
  });
});

describe("buildResponse", () => {
  const base = (): ResponseInput => ({
    view,
    indexes: askIndexes(view),
    question: "Where are signals made?",
    status: "answered",
    sentences: [],
    readNext: [],
    refused: 0,
    cost: { turns: 1, usd: 0.0048, model: "claude-haiku-4-5-20251001" },
    answeredAt: new Date("2026-10-05T12:00:00Z"),
  });

  it("numbers sources by first citation and links each claim", () => {
    const response = buildResponse({
      ...base(),
      sentences: [
        { text: "First.", handles: ["signals#s-2", "signals#s-1"] },
        { text: "Second.", handles: ["signals#s-1", "deliverables#d-1"] },
      ],
    });
    expect(AskResponse.parse(response)).toEqual(response);
    expect(response.sentences).toEqual([
      { text: "First.", sources: [1, 2] },
      { text: "Second.", sources: [2, 3] },
    ]);
    expect(response.sources.map((s) => [s.n, s.href, s.sectionTitle])).toEqual([
      [1, "/wiki/signals/#claim-s-2", "How it works"],
      [2, "/wiki/signals/#claim-s-1", "Overview"],
      [3, "/wiki/deliverables/#claim-d-1", "Overview"],
    ]);
    expect(response.sources[1]?.excerpt).toBe(
      "`ingest_chunk` makes one signal per non-blank sentence of a chunk and saves each one with `save_signal`.",
    );
    expect(response).toMatchObject({ status: "answered", head: sample.sha, cached: false });
  });

  it("makes an answer with no sentence left not-found, with the fixed sentence", () => {
    const response = buildResponse({ ...base(), refused: 2 });
    expect(response.status).toBe("not-found");
    expect(response.sentences).toEqual([{ text: NOT_FOUND_SENTENCE, sources: [] }]);
    expect(response.refused).toBe(2);
    const model = buildResponse({
      ...base(),
      status: "not-found",
      sentences: [{ text: "Ignored.", handles: ["signals#s-1"] }],
    });
    expect(model.sentences).toEqual([{ text: NOT_FOUND_SENTENCE, sources: [] }]);
    expect(model.sources).toEqual([]);
  });

  it("gives a budget or error answer no sentence but Read next", () => {
    for (const status of ["budget", "error"] as const) {
      const response = buildResponse({ ...base(), status });
      expect(response.sentences).toEqual([]);
      expect(response.readNext.length).toBeGreaterThan(0);
    }
  });

  it("lists at most twelve sources, refusing a sentence left with none", () => {
    const wiki = structuredClone(extendedWiki(sample));
    const more = Array.from({ length: 8 }, (_, i) =>
      bodyClaim({ id: `x-${i}`, text: `Extra claim ${i}.` }),
    );
    wiki.pages[0]?.sections.find((s) => s.key === "overview")?.claims.push(...more);
    const wide = new WikiView(wiki);
    const handles = [...askIndexes(wide).claims.entries.keys()];
    expect(handles.length).toBeGreaterThan(12);
    const response = buildResponse({
      ...base(),
      view: wide,
      sentences: [0, 4, 8, 12].map((i) => ({ text: `S${i}.`, handles: handles.slice(i, i + 4) })),
    });
    expect(response.sources).toHaveLength(12);
    expect(response.sentences).toHaveLength(3);
    expect(response.refused).toBe(1);
  });
});

describe("readNextOf", () => {
  it("takes the model's pages that resolve, then the page search, each once, at most three", () => {
    const indexes = askIndexes(view);
    expect(
      readNextOf(view, indexes, "signals", [
        "deliverables",
        "legacy-signals",
        "nowhere",
        "records",
      ]),
    ).toEqual([
      {
        pageId: "deliverables",
        title: "Deliverables",
        href: "/wiki/deliverables/",
        summary: view.summary("deliverables"),
      },
      {
        pageId: "signals",
        title: "Signal ingestion",
        href: "/wiki/signals/",
        summary: view.summary("signals"),
      },
      expect.objectContaining({ href: expect.stringMatching(/^\/(wiki|special)\//) }),
    ]);
    expect(readNextOf(view, indexes, "kubernetes", [])).toEqual([]);
  });
});
