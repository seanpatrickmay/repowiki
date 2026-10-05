import { makeAskResponse } from "@repowiki/core/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  ANSWERS_KEY,
  type AskEnv,
  type AskFetchResponse,
  type AskPageDocument,
  installAsk,
  KEPT_ANSWERS,
  OPEN_KEY,
  type Pagefind,
  pageHint,
  type StorageLike,
} from "./ask.ts";
import { event, FakeDocument, type FakeElement } from "./test-dom.ts";

/** A page as the Layout renders it: the header button and the sidebar's panel. */
function page() {
  const doc = new FakeDocument();
  const b = doc.build.bind(doc);
  const button = b("button", { "data-ask-open": "", "aria-expanded": "false", hidden: "" });
  const input = b("textarea");
  const form = b("form", { "data-ask-form": "" }, input);
  const live = b("div", { "data-ask-live": "", "aria-live": "polite" });
  const result = b("div", { "data-ask-result": "", "aria-live": "polite" });
  const close = b("button", { "data-ask-close": "" });
  const panel = b("section", { "data-ask": "sidebar" }, close, form, live, result);
  const sidebar = b("aside", { id: "ask-panel", hidden: "" }, panel);
  doc.body.append(button, sidebar);
  return { doc, button, input, form, live, result, sidebar };
}

/** A sessionStorage, or one that throws on every call. */
function memoryStorage(throws = false): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => {
      if (throws) throw new Error("SecurityError");
      return data.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (throws) throw new Error("QuotaExceededError");
      data.set(key, value);
    },
  };
}

const json = (status: number, body: unknown): AskFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  body: null,
});

/** An event-stream response whose body arrives as `chunks`. */
const stream = (chunks: readonly string[]): AskFetchResponse => {
  const encoded = chunks.map((c) => new TextEncoder().encode(c));
  let i = 0;
  return {
    ok: true,
    status: 200,
    json: async () => null,
    body: {
      getReader: () => ({
        read: async () =>
          i < encoded.length ? { done: false, value: encoded[i++] } : { done: true },
      }),
    },
  };
};

const ANSWERING = {
  mode: "answer",
  head: "a".repeat(40),
  model: "claude-haiku-4-5",
  questionUsd: 0.05,
  sessionLeftUsd: 1,
};
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const PAGEFIND: Pagefind = {
  search: async () => ({
    results: [
      {
        data: async () => ({
          url: "/wiki/signals/",
          excerpt: "how <mark>signals</mark> are made",
          meta: { title: "Signal ingestion" },
          sub_results: [{ title: "Overview", url: "/wiki/signals/#overview", excerpt: "x" }],
        }),
      },
    ],
  }),
};

function setup(
  options: {
    pathname?: string;
    storage?: StorageLike;
    status?: () => Promise<AskFetchResponse>;
    ask?: (body: unknown) => Promise<AskFetchResponse>;
    pagefind?: () => Promise<Pagefind>;
    timeoutMs?: number;
  } = {},
) {
  const p = page();
  const posts: unknown[] = [];
  const storage = options.storage ?? memoryStorage();
  const fetch = vi.fn(async (url: string, init?: { body: string }) => {
    if (url === "/api/ask/status") return (options.status ?? (async () => json(200, ANSWERING)))();
    posts.push(JSON.parse(init?.body ?? "null"));
    return (options.ask ?? (async () => stream([frame("answer", makeAskResponse())])))(
      posts.at(-1),
    );
  });
  const env: AskEnv = {
    document: p.doc as unknown as AskPageDocument,
    location: { pathname: options.pathname ?? "/wiki/signals/" },
    storage: () => storage,
    fetch,
    pagefind: options.pagefind ?? (async () => PAGEFIND),
    ...(options.timeoutMs === undefined ? {} : { askTimeoutMs: options.timeoutMs }),
  };
  installAsk(env);
  const submit = async (question: string) => {
    p.input.value = question;
    p.form.dispatch(event("submit"));
    await vi.waitFor(() => expect(p.live.textContent).not.toBe("Asking\u2026"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { ...p, env, fetch, posts, storage, submit };
}

const text = (element: FakeElement | null) => element?.textContent ?? "";

describe("pageHint", () => {
  it("names the feature page or the About article the reader is on", () => {
    expect(pageHint("/wiki/signals/")).toBe("signals");
    expect(pageHint("/wiki/signals/history/2/")).toBe("signals");
    expect(pageHint("/special/about/")).toBe("special:about");
    expect(pageHint("/")).toBeNull();
    expect(pageHint("/special/all-pages/")).toBeNull();
  });
});

describe("the sidebar (spec v2 #4 R21)", () => {
  it("shows the button, and opens and closes the panel, moving focus as it goes", () => {
    const { button, sidebar, input, doc, storage } = setup();
    expect(button.hidden).toBe(false);
    button.dispatch(event("click"));
    expect(sidebar.hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(doc.activeElement).toBe(input);
    expect((storage as ReturnType<typeof memoryStorage>).data.get(OPEN_KEY)).toBe("1");
    button.dispatch(event("click"));
    expect(sidebar.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(doc.activeElement).toBe(button);
  });

  it("closes on Escape and returns focus to the button", () => {
    const { button, sidebar, doc } = setup();
    button.dispatch(event("click"));
    doc.dispatch(event("keydown", { key: "Escape" }));
    expect(sidebar.hidden).toBe(true);
    expect(doc.activeElement).toBe(button);
  });

  it("reopens on the next page when it was open, without taking focus", () => {
    const storage = memoryStorage();
    storage.setItem(OPEN_KEY, "1");
    const { sidebar, doc } = setup({ storage });
    expect(sidebar.hidden).toBe(false);
    expect(doc.activeElement).toBeNull();
  });

  it("works when storage throws", async () => {
    const { button, sidebar, submit, result } = setup({ storage: memoryStorage(true) });
    button.dispatch(event("click"));
    expect(sidebar.hidden).toBe(false);
    await submit("Where are signals made?");
    expect(text(result)).toContain("Signals are made by");
  });
});

describe("asking a served wiki", () => {
  it("posts the question with the page hint, shows progress, then the answer, and keeps it", async () => {
    const progress: string[] = [];
    const { submit, posts, result, live, storage } = setup({
      ask: async () => {
        const body = [
          frame("status", { step: "search", query: "signals" }),
          frame("status", { step: "read", pageId: "signals", title: "Signal ingestion" }),
          frame("answer", makeAskResponse()),
        ].join("");
        // The stream arrives in pieces that split frames, as a network does.
        return stream([body.slice(0, 30), body.slice(30, 200), body.slice(200)]);
      },
    });
    // Record every text the live region is given.
    Object.defineProperty(live, "textContent", {
      get: () => progress.at(-1) ?? "",
      set: (value: string) => void progress.push(value),
    });
    await submit("Where are signals made?");
    expect(progress).toEqual([
      "Asking\u2026",
      "Searching for \u201Csignals\u201D\u2026",
      "Reading Signal ingestion\u2026",
      "",
    ]);
    expect(posts).toEqual([{ question: "Where are signals made?", page: "signals", fresh: false }]);
    expect(text(result)).toContain("Signals are made by ingest_chunk");
    expect(text(result)).toContain("Answered from the wiki at aaaaaaa");
    expect(text(live)).toBe("");
    const kept = JSON.parse(
      (storage as ReturnType<typeof memoryStorage>).data.get(ANSWERS_KEY) ?? "[]",
    );
    expect(kept).toEqual([{ question: "Where are signals made?", response: makeAskResponse() }]);
  });

  it("asks again past the cache when the reader asks for it", async () => {
    const { submit, posts, result } = setup();
    await submit("Where are signals made?");
    const again = result.querySelector("button.ask-again");
    again?.dispatch(event("click"));
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ question: "Where are signals made?", page: "signals", fresh: true });
  });

  it("refuses to show an answer of the wrong shape, and routes instead", async () => {
    const { submit, live, result } = setup({
      ask: async () =>
        stream([
          frame("answer", {
            ...makeAskResponse(),
            sentences: [{ text: "x".repeat(10_000), sources: [1] }],
          }),
        ]),
    });
    await submit("Where are signals made?");
    expect(text(live)).toBe("The answer could not be shown; here are the pages that match.");
    expect(text(result)).toContain("Signal ingestion");
    expect(text(result)).not.toContain("xxxxxxxxxx");
  });

  it("says when another question is in flight", async () => {
    const { submit, live } = setup({ ask: async () => json(429, { code: "busy" }) });
    await submit("Where are signals made?");
    expect(text(live)).toBe("Another question is being answered; ask again in a moment.");
  });

  it("keeps at most ten answers for the tab, and shows the last one on the next page", async () => {
    const storage = memoryStorage();
    const entries = Array.from({ length: KEPT_ANSWERS }, (_, i) => ({
      question: `Question ${i}?`,
      response: makeAskResponse({ question: `Question ${i}?` }),
    }));
    storage.setItem(ANSWERS_KEY, JSON.stringify(entries));
    const first = setup({ storage });
    expect(first.input.value).toBe("Question 9?");
    await first.submit("Where are signals made?");
    const kept = JSON.parse(storage.getItem(ANSWERS_KEY) ?? "[]");
    expect(kept).toHaveLength(KEPT_ANSWERS);
    expect(kept.at(-1).question).toBe("Where are signals made?");
    const next = setup({ storage });
    expect(text(next.result)).toContain("Signals are made by");
  });

  it("ignores a stored answer that was tampered with", () => {
    const storage = memoryStorage();
    storage.setItem(
      ANSWERS_KEY,
      JSON.stringify([{ question: "x", response: { ...makeAskResponse(), head: "<img>" } }]),
    );
    const { result, input } = setup({ storage });
    expect(result.children).toEqual([]);
    expect(input.value).toBe("");
  });
});

/** A stream that sends `first`, then never sends again (or fails, when `fail` is given). */
function stalled(first: string, fail?: Error) {
  const cancel = vi.fn(async () => {});
  let sent = false;
  const response: AskFetchResponse = {
    ok: true,
    status: 200,
    json: async () => null,
    body: {
      getReader: () => ({
        read: () => {
          if (!sent) {
            sent = true;
            return Promise.resolve({ done: false, value: new TextEncoder().encode(first) });
          }
          return fail === undefined ? new Promise(() => {}) : Promise.reject(fail);
        },
        cancel,
      }),
    },
  };
  return { response, cancel };
}

describe("a served wiki that fails", () => {
  const ROUTED = ["/wiki/signals/", "/wiki/signals/#overview"];
  const links = (result: FakeElement) =>
    result.querySelectorAll("a").map((a) => a.getAttribute("href"));

  it("gives up on a stream that stops sending, cancels its reader, and routes", async () => {
    const hung = stalled(frame("status", { step: "search", query: "signals" }));
    const { submit, live, result } = setup({ ask: async () => hung.response, timeoutMs: 30 });
    await submit("Where are signals made?");
    await vi.waitFor(() =>
      expect(text(live)).toBe("The answer took too long; here are the pages that match."),
    );
    expect(hung.cancel).toHaveBeenCalled();
    await vi.waitFor(() => expect(links(result)).toEqual(ROUTED));
  });

  it("gives up on a POST that never answers, and asks again afterwards", async () => {
    let calls = 0;
    const { submit, live, result } = setup({
      ask: () =>
        ++calls === 1
          ? new Promise(() => {})
          : Promise.resolve(stream([frame("answer", makeAskResponse())])),
      timeoutMs: 30,
    });
    await submit("Where are signals made?");
    await vi.waitFor(() =>
      expect(text(live)).toBe("The answer took too long; here are the pages that match."),
    );
    await submit("Where are signals made?");
    await vi.waitFor(() => expect(text(result)).toContain("Signals are made by"));
  });

  it("routes when the stream fails midway, cancelling its reader", async () => {
    const broken = stalled(
      frame("status", { step: "search", query: "signals" }),
      new TypeError("network"),
    );
    const { submit, live, result } = setup({ ask: async () => broken.response });
    await submit("Where are signals made?");
    await vi.waitFor(() =>
      expect(text(live)).toBe("The answer could not be shown; here are the pages that match."),
    );
    expect(broken.cancel).toHaveBeenCalled();
    await vi.waitFor(() => expect(links(result)).toEqual(ROUTED));
  });

  it.each([
    [
      "rejects",
      () => Promise.reject(new TypeError("Failed to fetch")),
      "The server did not answer; here are the pages that match.",
    ],
    [
      "is a 500",
      async () => json(500, { code: "error" }),
      "The question could not be answered; here are the pages that match.",
    ],
  ])("routes when the POST %s", async (_name, ask, said) => {
    const { submit, live, result } = setup({ ask: ask as () => Promise<AskFetchResponse> });
    await submit("Where are signals made?");
    await vi.waitFor(() => expect(text(live)).toBe(said));
    await vi.waitFor(() => expect(links(result)).toEqual(ROUTED));
  });

  it("probes the status again on the next ask after a failed probe", async () => {
    let probes = 0;
    const { submit, live, result, posts } = setup({
      status: () =>
        ++probes === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(json(200, ANSWERING)),
    });
    await submit("Where are signals made?");
    expect(text(live)).toBe("Answers need pnpm wiki:serve; here are the pages that match.");
    expect(posts).toEqual([]);
    await submit("Where are signals made?");
    await vi.waitFor(() => expect(text(result)).toContain("Signals are made by"));
    expect(probes).toBe(2);
    expect(posts).toHaveLength(1);
  });
});

describe("routing without a server (spec v2 #4 §4.3)", () => {
  it.each([
    ["a static host's 404", async () => json(404, "<html>")],
    ["no network", async () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a page that is not a status", async () => json(200, { mode: "maybe" })],
  ])("routes through Pagefind after %s", async (_name, status) => {
    const { submit, live, result, posts } = setup({
      status: status as () => Promise<AskFetchResponse>,
    });
    await submit("Where are signals made?");
    expect(text(live)).toBe("Answers need pnpm wiki:serve; here are the pages that match.");
    const links = result.querySelectorAll("a").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/wiki/signals/", "/wiki/signals/#overview"]);
    expect(result.querySelector("mark")?.textContent).toBe("signals");
    expect(posts).toEqual([]);
  });

  it("routes when the server answers in routing mode, saying why", async () => {
    const { submit, live } = setup({
      status: async () => json(200, { mode: "routing", head: "a".repeat(40), reason: "budget" }),
    });
    await submit("Where are signals made?");
    expect(text(live)).toBe(
      "This session's spending cap is reached; here are the pages that match.",
    );
  });

  it("says so when the page search cannot load either", async () => {
    const { submit, live, result } = setup({
      status: async () => json(404, null),
      pagefind: async () => Promise.reject(new Error("no pagefind")),
    });
    await submit("Where are signals made?");
    expect(text(live)).toContain("The page search is not available here either.");
    expect(result.children).toEqual([]);
  });
});
