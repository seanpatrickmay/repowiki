import { ASK_HREF, AskResponse, NOT_FOUND_SENTENCE } from "@repowiki/core";
import { makeAskResponse } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  type AskDocument,
  excerptParts,
  footerText,
  guardProgress,
  guardResponse,
  MAX_STREAM_CHARS,
  progressText,
  renderAnswer,
  renderRoutes,
  SAFE_HREF,
  safeHref,
  sseReader,
} from "./ask-render.ts";
import { FakeDocument, type FakeElement } from "./test-dom.ts";

const doc = () => new FakeDocument();
const render = (response: AskResponse) => {
  const d = doc();
  return renderAnswer(d as unknown as AskDocument, response) as unknown as FakeElement;
};

describe("SAFE_HREF", () => {
  it("is core's ASK_HREF itself, so the two cannot drift", () => {
    expect(SAFE_HREF).toBe(ASK_HREF);
  });

  it("admits every link an answer may carry, as core's ASK_HREF does", () => {
    for (const href of [
      "/wiki/signals/",
      "/wiki/signals/#claim-s-1",
      "/wiki/signals/#how-it-works",
      "/special/about/",
      "/special/about/#claim-c2",
    ]) {
      expect([href, SAFE_HREF.test(href), ASK_HREF.test(href)]).toEqual([href, true, true]);
    }
  });

  it.each([
    "javascript:alert(1)",
    "//evil.example/wiki/x/",
    "https://evil.example/",
    "/wiki/x/history/",
    "data:text/html,x",
    " /wiki/x/",
  ])("refuses %s", (href) => {
    expect(safeHref(href)).toBeNull();
  });
});

describe("guardResponse", () => {
  it("passes an answer of the server's shape", () => {
    expect(guardResponse(makeAskResponse())).toEqual(makeAskResponse());
  });

  const base = makeAskResponse();
  const [first, second] = base.sources;
  it.each([
    ["not an object", "answered"],
    ["an unknown status", { ...base, status: "maybe" }],
    ["a short head", { ...base, head: "abc" }],
    ["a 10 KB sentence", { ...base, sentences: [{ text: "x".repeat(10_000), sources: [1] }] }],
    ["a sentence citing a missing source", { ...base, sentences: [{ text: "x", sources: [3] }] }],
    [
      "a source number that is not an integer",
      { ...base, sentences: [{ text: "x", sources: [1.5] }] },
    ],
    ["sources out of order", { ...base, sources: [second, first] }],
    ["thirteen sources", { ...base, sources: Array(13).fill(first) }],
    ["seven sentences", { ...base, sentences: Array(7).fill({ text: "x", sources: [1] }) }],
    ["a long excerpt", { ...base, sources: [{ ...first, excerpt: "x".repeat(161) }, second] }],
    [
      "an object title",
      { ...base, readNext: [{ pageId: "a", title: {}, href: "/", summary: "" }] },
    ],
    ["a cost in words", { ...base, cost: { turns: 1, usd: "a cent", model: null } }],
    ["a missing cached flag", { ...base, cached: undefined }],
    ["a head in a list", { ...base, head: [base.head] }],
    ["an infinite cost", { ...base, cost: { turns: 1, usd: Infinity, model: null } }],
    ["a budget answer with a sentence", { ...base, status: "budget" }],
    [
      "a sentence citing one source twice",
      {
        ...base,
        sentences: [
          { text: "x", sources: [1, 1] },
          { text: "y", sources: [2] },
        ],
      },
    ],
    [
      "an answered sentence citing no source",
      { ...base, sentences: [{ text: "x", sources: [] }, ...base.sentences] },
    ],
    ["a source no sentence cites", { ...base, sentences: [{ text: "x", sources: [1] }] }],
    ["an empty section title", { ...base, sources: [{ ...first, sectionTitle: "" }, second] }],
    [
      "a not-found answer in the model's words",
      { ...base, status: "not-found", sentences: [{ text: "Nothing.", sources: [] }], sources: [] },
    ],
    ["an answered answer with no sentence", { ...base, sentences: [], sources: [] }],
    [
      "sources not numbered in order of first citation",
      {
        ...base,
        sentences: [
          { text: "x", sources: [2] },
          { text: "y", sources: [1] },
        ],
      },
    ],
    ["a blank sentence", { ...base, sentences: [{ text: " \t ", sources: [1, 2] }] }],
    [
      "a source linking another page",
      { ...base, sources: [{ ...first, href: "/wiki/x/" }, second] },
    ],
    [
      "a source anchored at another claim",
      { ...base, sources: [{ ...first, href: "/wiki/signals/#claim-zzz" }, second] },
    ],
    [
      "a Read next link to another page",
      { ...base, readNext: [{ ...base.readNext[0], href: "/wiki/x/" }] },
    ],
  ])("refuses %s, as core's AskResponse does", (_name, value) => {
    expect(guardResponse(value)).toBeNull();
    expect(AskResponse.safeParse(value).success).toBe(false);
  });

  it("passes a not-found answer and a budget answer as the server sends them", () => {
    const notFound = {
      ...base,
      status: "not-found",
      sentences: [{ text: NOT_FOUND_SENTENCE, sources: [] }],
      sources: [],
    };
    const budget = { ...base, status: "budget", sentences: [], sources: [] };
    for (const value of [notFound, budget]) {
      expect(AskResponse.safeParse(value).success).toBe(true);
      expect(guardResponse(value)).toEqual(value);
    }
  });
});

describe("guardProgress and progressText", () => {
  it("reads a search and a page read, and ignores anything else", () => {
    const search = guardProgress({ step: "search", query: "signals" });
    const read = guardProgress({ step: "read", pageId: "signals", title: "Signal ingestion" });
    expect(search === null ? null : progressText(search)).toBe(
      "Searching for \u201Csignals\u201D\u2026",
    );
    expect(read === null ? null : progressText(read)).toBe("Reading Signal ingestion\u2026");
    expect(guardProgress({ step: "think" })).toBeNull();
    expect(guardProgress({ step: "read", pageId: "", title: "x" })).toBeNull();
  });
});

describe("renderAnswer", () => {
  it("shows each sentence with code spans and marks linking to the claims it cites", () => {
    const root = render(makeAskResponse());
    const [p1, p2] = root.querySelectorAll("p");
    expect(p1?.textContent).toBe("Signals are made by ingest_chunk in src/signals/ingest.py.[1]");
    expect(p1?.querySelector("code")?.textContent).toBe("ingest_chunk");
    const marks = p2?.querySelectorAll("a") ?? [];
    expect(
      marks.map((m) => [m.textContent, m.getAttribute("href"), m.getAttribute("data-preview")]),
    ).toEqual([
      ["[1]", "/wiki/signals/#claim-s-1", "signals"],
      ["[2]", "/wiki/signals/#claim-s-2", "signals"],
    ]);
  });

  it("lists the sources, Read next and the footer", () => {
    const root = render(makeAskResponse());
    const sources = root.querySelector("ol")?.querySelectorAll("li") ?? [];
    expect(sources.map((li) => li.querySelector("a")?.textContent)).toEqual([
      "Signal ingestion \u203A Overview",
      "Signal ingestion \u203A How it works",
    ]);
    expect(sources[0]?.querySelector("div")?.textContent).toBe(
      "ingest_chunk makes one signal per non-blank sentence of a chunk.",
    );
    expect(root.querySelector("ul")?.textContent).toBe(
      "Deliverables \u2014 Deliverables are built from signals.",
    );
    expect(root.querySelector("p.ask-footer")?.textContent).toBe(
      `Answered from the wiki at aaaaaaa \u00B7 2 turns \u00B7 $0.0098`,
    );
    expect(footerText({ ...makeAskResponse(), cached: true })).toBe(
      "Answered from the wiki at aaaaaaa \u00B7 cached",
    );
  });

  it("shows hostile text as text and a link it cannot trust as plain text", () => {
    const hostile = makeAskResponse({
      sentences: [{ text: "<img src=x onerror=alert(1)> and `<script>`", sources: [1] }],
      sources: [
        {
          ...makeAskResponse().sources[0],
          href: "javascript:alert(1)",
          pageId: 'x" onmouseover="alert(1)',
          pageTitle: "<b>Title</b>",
        } as AskResponse["sources"][number],
      ],
      readNext: [{ pageId: "deliverables", title: "D", href: "//evil.example/", summary: "" }],
    });
    const root = render(hostile);
    expect(root.querySelectorAll("img")).toEqual([]);
    expect(root.querySelectorAll("b")).toEqual([]);
    expect(root.querySelector("p")?.textContent).toBe(
      "<img src=x onerror=alert(1)> and <script>[1]",
    );
    expect(root.querySelectorAll("a")).toEqual([]);
    expect(root.querySelectorAll("span").map((s) => s.textContent)).toEqual([
      "[1]",
      "<b>Title</b> \u203A Overview",
      "D",
    ]);
  });

  it("says why a budget or error answer has no sentence", () => {
    const budget = render(makeAskResponse({ status: "budget", sentences: [], sources: [] }));
    expect(budget.querySelector("p.ask-note")?.textContent).toContain("spending cap");
    const error = render(makeAskResponse({ status: "error", sentences: [], sources: [] }));
    expect(error.querySelector("p.ask-note")?.textContent).toBe(
      "The question could not be answered.",
    );
  });
});

describe("sseReader", () => {
  it("reads frames split anywhere, CRLF frames, comments and data on several lines", () => {
    const reader = sseReader();
    const stream =
      'event: status\ndata: {"step":"search","query":"a"}\n\n: comment\n\r\nevent: answer\r\ndata: {"x":\r\ndata: 1}\r\n\r\n';
    const events = [...stream].flatMap((ch) => reader.feed(ch));
    expect(events).toEqual([
      { event: "status", data: '{"step":"search","query":"a"}' },
      { event: "answer", data: '{"x":\n1}' },
    ]);
  });

  it("keeps an unfinished frame for the next chunk, and stops past 64 KiB", () => {
    const reader = sseReader();
    expect(reader.feed("event: answer\ndata: {")).toEqual([]);
    expect(reader.feed("}\n\n")).toEqual([{ event: "answer", data: "{}" }]);
    expect(() => reader.feed("x".repeat(MAX_STREAM_CHARS))).toThrow("too long");
  });
});

describe("excerptParts and renderRoutes", () => {
  it("keeps exact <mark> spans and makes everything else text", () => {
    expect(excerptParts("how <mark>signals</mark> are &lt;b&gt;made&lt;/b&gt;")).toEqual([
      { text: "how ", mark: false },
      { text: "signals", mark: true },
      { text: " are <b>made</b>", mark: false },
    ]);
    expect(excerptParts('<img src=x onerror="alert(1)"><mark><b>x</b></mark>')).toEqual([
      { text: "x", mark: false },
    ]);
  });

  it("lists pages and at most two sections each, linking only safe paths", () => {
    const d = doc();
    const list = renderRoutes(d as unknown as AskDocument, [
      {
        title: "Signal ingestion",
        url: "/wiki/signals/",
        excerpt: "<mark>signals</mark>",
        sections: [
          { title: "Overview", url: "/wiki/signals/#overview", excerpt: "a" },
          { title: "History", url: "/wiki/signals/#history", excerpt: "b" },
          { title: "Known limitations", url: "/wiki/signals/#known-limitations", excerpt: "c" },
        ],
      },
      { title: "Elsewhere", url: "https://evil.example/", excerpt: "", sections: [] },
    ]) as unknown as FakeElement;
    const [first, second] = list.querySelectorAll("li");
    expect(first?.querySelectorAll("a").map((a) => a.getAttribute("href"))).toEqual([
      "/wiki/signals/",
      "/wiki/signals/#overview",
      "/wiki/signals/#history",
    ]);
    expect(first?.querySelector("mark")?.textContent).toBe("signals");
    expect(second?.querySelectorAll("a")).toEqual([]);
    expect(second?.querySelector("span")?.textContent).toBe("Elsewhere");
  });
});
