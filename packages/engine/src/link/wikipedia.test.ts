import type { WikipediaSummary } from "@repowiki/core";
import { CassetteMissError, type FetchLike } from "@repowiki/llm";
import { describe, expect, it, vi } from "vitest";
import { memoryCache } from "./test-wikipedia.ts";
import { checkWikipediaTitles, WIKIPEDIA_TIMEOUT_MS, WIKIPEDIA_USER_AGENT } from "./wikipedia.ts";

const page = (title: string, extra: Record<string, unknown> = {}) => ({
  type: "standard",
  title,
  titles: { normalized: title },
  extract: `${title} is a thing.`,
  content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}` } },
  ...extra,
});

/** Answers by path; records each request's url, path and headers. */
function fakeWikipedia(
  answers: Record<string, { status: number; body?: unknown; raw?: string } | "throw">,
) {
  const requests: { url: string; path: string; userAgent: string | null }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const path = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
    requests.push({ url, path, userAgent: new Headers(init?.headers).get("user-agent") });
    const answer = answers[path];
    if (answer === "throw") throw new TypeError("fetch failed");
    if (answer === undefined) return new Response("{}", { status: 404 });
    return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), { status: answer.status });
  };
  return { fetch, requests };
}

const NOW = () => new Date("2026-10-01T12:00:00Z");
const summary = (title: string): WikipediaSummary => ({
  title,
  extract: `${title} is a thing.`,
  url: `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}`,
});

describe("checkWikipediaTitles", () => {
  it("links an article, makes a 404 and a disambiguation page plain, and caches all three", async () => {
    const api = fakeWikipedia({
      Message_queue: { status: 200, body: page("Message queue") },
      Mercury: { status: 200, body: page("Mercury", { type: "disambiguation" }) },
    });
    const { cache, entries } = memoryCache();
    const check = await checkWikipediaTitles(["message_queue", "Mercury", "Zzqx"], {
      cache,
      fetch: api.fetch,
      now: NOW,
    });
    expect([...check.links]).toEqual([
      ["Mercury", null],
      ["Message queue", "Message queue"],
      ["Zzqx", null],
    ]);
    expect(check).toMatchObject({ fetched: 3, failed: [] });
    expect(entries.get("Message queue")).toEqual({
      summary: summary("Message queue"),
      fetchedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(entries.get("Zzqx")?.summary).toBeNull();
    expect(api.requests.every((r) => r.userAgent === WIKIPEDIA_USER_AGENT)).toBe(true);
  });

  it("never fetches a cached title again", async () => {
    const api = fakeWikipedia({});
    const { cache } = memoryCache({
      Cron: { summary: summary("Cron"), fetchedAt: "2026-09-01T00:00:00Z" },
      Gone: { summary: null, fetchedAt: "2026-09-01T00:00:00Z" },
    });
    const check = await checkWikipediaTitles(["Cron", "Gone"], { cache, fetch: api.fetch });
    expect([...check.links]).toEqual([
      ["Cron", "Cron"],
      ["Gone", null],
    ]);
    expect(api.requests).toEqual([]);
  });

  it("caches a summary under its canonical title too", async () => {
    const api = fakeWikipedia({ Cron_job: { status: 200, body: page("Cron") } });
    const { cache, entries } = memoryCache();
    const check = await checkWikipediaTitles(["Cron job"], { cache, fetch: api.fetch, now: NOW });
    expect(check.links.get("Cron job")).toBe("Cron");
    expect(entries.get("Cron job")?.summary?.title).toBe("Cron");
    expect(entries.get("Cron")?.summary?.title).toBe("Cron");
  });

  it("makes an unreachable title plain for this run without caching it", async () => {
    const api = fakeWikipedia({ Down: "throw", Busy: { status: 503 } });
    const { cache, entries } = memoryCache();
    const check = await checkWikipediaTitles(["Down", "Busy"], { cache, fetch: api.fetch });
    expect(check.failed).toEqual(["Busy", "Down"]);
    expect([...check.links.values()]).toEqual([null, null]);
    expect(entries.size).toBe(0);
  });

  it("treats a 429 or 5xx as failed this run, uncached, and asks only once", async () => {
    const api = fakeWikipedia({
      Limited: { status: 429 },
      Broken: { status: 500 },
      Gateway: { status: 502 },
    });
    const { cache, entries } = memoryCache();
    const check = await checkWikipediaTitles(["Limited", "Broken", "Gateway"], {
      cache,
      fetch: api.fetch,
    });
    expect(check.failed).toEqual(["Broken", "Gateway", "Limited"]);
    expect(entries.size).toBe(0);
    expect(api.requests).toHaveLength(3);
  });

  it("refuses a summary whose URL is not an English Wikipedia article", async () => {
    const evil = page("Evil", { content_urls: { desktop: { page: "javascript:alert(1)" } } });
    const api = fakeWikipedia({ Evil: { status: 200, body: evil } });
    const { cache, entries } = memoryCache();
    const check = await checkWikipediaTitles(["Evil"], { cache, fetch: api.fetch });
    expect(check).toMatchObject({ failed: ["Evil"] });
    expect(check.links.get("Evil")).toBeNull();
    expect(entries.size).toBe(0);
  });

  it("cuts a long extract", async () => {
    const long = page("Long", { extract: "x".repeat(5000) });
    const api = fakeWikipedia({ Long: { status: 200, body: long } });
    const { cache, entries } = memoryCache();
    await checkWikipediaTitles(["Long"], { cache, fetch: api.fetch });
    expect([...(entries.get("Long")?.summary?.extract ?? "")]).toHaveLength(1200);
  });

  it("collapses whitespace and strips control and invisible characters before caching", async () => {
    const messy = page("Zero\u200bwidth\u202e", {
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Zerowidth" } },
      extract: "Line one.\nLine\ttwo\u202e hidden\u00ad soft\u200b zero\u2028end \u200d\u200c",
    });
    const api = fakeWikipedia({ Messy: { status: 200, body: messy } });
    const { cache, entries } = memoryCache();
    const check = await checkWikipediaTitles(["Messy"], { cache, fetch: api.fetch });
    expect(check.failed).toEqual([]);
    expect(check.links.get("Messy")).toBe("Zerowidth");
    // The joiner and non-joiner survive; every other refused character is gone.
    expect(entries.get("Messy")?.summary?.extract).toBe(
      "Line one. Line two hidden soft zero end \u200d\u200c",
    );
  });

  it("makes a summary plain, uncached, when nothing of its title is left after cleaning", async () => {
    const blank = page("\u200b\u200b", {
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Blank" } },
    });
    const api = fakeWikipedia({ Blank: { status: 200, body: blank } });
    const { cache, entries } = memoryCache();
    const check = await checkWikipediaTitles(["Blank"], { cache, fetch: api.fetch });
    expect(check.failed).toEqual(["Blank"]);
    expect(entries.size).toBe(0);
  });

  it("keeps a hostile title inside the summary path", async () => {
    const api = fakeWikipedia({});
    const check = await checkWikipediaTitles(
      ["../../w/api.php?x", "a/b#c", "..", ".", "bad\u0000\ud800name"],
      { cache: memoryCache().cache, fetch: api.fetch },
    );
    expect(api.requests.length).toBeGreaterThan(0);
    expect(check.failed).toEqual([]);
    for (const { url } of api.requests) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://en.wikipedia.org");
      expect(parsed.pathname.startsWith("/api/rest_v1/page/summary/")).toBe(true);
      expect(parsed.pathname.slice("/api/rest_v1/page/summary/".length)).not.toMatch(/\//);
      expect(parsed.search).toBe("");
      expect(parsed.hash).toBe("");
    }
    expect(api.requests.map((r) => r.path)).toContain("../../w/api.php?x");
    // Titles that cannot be put in a path safely are never requested; they are plain this run.
    expect(api.requests.map((r) => r.path)).not.toContain("..");
    expect(api.requests.map((r) => r.path)).not.toContain(".");
  });

  it("makes a title that can never be a path plain, without a request, a failure or a cache entry", async () => {
    const lone = `bad${String.fromCharCode(0xd800)}name`;
    const api = fakeWikipedia({});
    const { cache, entries } = memoryCache();
    const check = await checkWikipediaTitles(["..", ".", lone], { cache, fetch: api.fetch });
    expect([...check.links]).toEqual([
      [".", null],
      ["..", null],
      [`Bad${String.fromCharCode(0xd800)}name`, null],
    ]);
    expect(check).toMatchObject({ fetched: 0, failed: [] });
    expect(api.requests).toEqual([]);
    expect(entries.size).toBe(0);
  });

  it("keeps what is known about a redirect target instead of overwriting it", async () => {
    const api = fakeWikipedia({ Cron_job: { status: 200, body: page("Cron") } });
    const known = { summary: summary("Cron"), fetchedAt: "2026-09-01T00:00:00Z" };
    const { cache, entries } = memoryCache({ Cron: known });
    const check = await checkWikipediaTitles(["Cron job"], { cache, fetch: api.fetch, now: NOW });
    expect(check.links.get("Cron job")).toBe("Cron");
    expect(entries.get("Cron")).toBe(known);
  });

  it("links a redirect target requested in the same call the way its redirect does", async () => {
    const api = fakeWikipedia({
      Cron_job: { status: 200, body: page("Cron") },
      Cron: { status: 503 },
    });
    const { cache, entries } = memoryCache();
    const check = await checkWikipediaTitles(["Cron", "Cron job"], {
      cache,
      fetch: api.fetch,
      now: NOW,
    });
    expect([...check.links]).toEqual([
      ["Cron", "Cron"],
      ["Cron job", "Cron"],
    ]);
    expect(check.failed).toEqual([]);
    expect(entries.get("Cron")?.summary?.title).toBe("Cron");
  });

  it("asks for at most four titles at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const fetch: FetchLike = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response("{}", { status: 404 });
    };
    const titles = Array.from({ length: 10 }, (_, i) => `Title ${i}`);
    const check = await checkWikipediaTitles(titles, { cache: memoryCache().cache, fetch });
    expect(check.fetched).toBe(10);
    expect(most).toBe(4);
  });

  it("gives each request a timeout, and a timed-out title is failed and uncached", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const stop = new AbortController();
    timeout.mockReturnValue(stop.signal);
    const fetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        stop.abort(new DOMException("The operation timed out.", "TimeoutError"));
      });
    const { cache, entries } = memoryCache();
    try {
      const check = await checkWikipediaTitles(["Slow"], { cache, fetch });
      expect(check.failed).toEqual(["Slow"]);
      expect(entries.size).toBe(0);
      expect(timeout).toHaveBeenCalledWith(WIKIPEDIA_TIMEOUT_MS);
      expect(WIKIPEDIA_TIMEOUT_MS).toBe(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("lets a missing cassette recording through instead of calling the title unreachable", async () => {
    const fetch: FetchLike = async () => {
      throw new CassetteMissError("wikipedia.json", "GET", "/api/rest_v1/page/summary/Lost");
    };
    await expect(
      checkWikipediaTitles(["Lost"], { cache: memoryCache().cache, fetch }),
    ).rejects.toBeInstanceOf(CassetteMissError);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["null", "null"],
    ["a string", '"article"'],
    ["a number", "42"],
  ])("makes a 200 whose body is %s plain for this run, uncached", async (_name, raw) => {
    const api = fakeWikipedia({ Odd: { status: 200, raw } });
    const { cache, entries } = memoryCache();
    const check = await checkWikipediaTitles(["Odd"], { cache, fetch: api.fetch });
    expect(check.failed).toEqual(["Odd"]);
    expect(check.links.get("Odd")).toBeNull();
    expect(entries.size).toBe(0);
  });
});
