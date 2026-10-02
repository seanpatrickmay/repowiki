import type { WikipediaSummary } from "@repowiki/core";
import type { FetchLike } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { memoryCache } from "./test-wikipedia.ts";
import { checkWikipediaTitles, WIKIPEDIA_USER_AGENT } from "./wikipedia.ts";

const page = (title: string, extra: Record<string, unknown> = {}) => ({
  type: "standard",
  title,
  titles: { normalized: title },
  extract: `${title} is a thing.`,
  content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}` } },
  ...extra,
});

/** Answers by path; records each request's url, path and headers. */
function fakeWikipedia(answers: Record<string, { status: number; body?: unknown } | "throw">) {
  const requests: { url: string; path: string; userAgent: string | null }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const path = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
    requests.push({ url, path, userAgent: new Headers(init?.headers).get("user-agent") });
    const answer = answers[path];
    if (answer === "throw") throw new TypeError("fetch failed");
    if (answer === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
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
    expect(check.failed).toEqual(expect.arrayContaining(["..", "."]));
  });
});
