import { fileURLToPath } from "node:url";
import { cassetteFetch, cassetteMode } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { memoryCache } from "./test-wikipedia.ts";
import { checkWikipediaTitles } from "./wikipedia.ts";

const mode = cassetteMode();
const CASSETTE = fileURLToPath(new URL("./__cassettes__/wikipedia.json", import.meta.url));

describe("checkWikipediaTitles against recorded Wikipedia REST answers", () => {
  it("links an article and makes a missing title and a disambiguation page plain", async () => {
    const { cache, entries } = memoryCache();
    const check = await checkWikipediaTitles(
      ["Message queue", "Mercury", "Zzqx repowiki no such article"],
      { cache, fetch: cassetteFetch(CASSETTE, mode), now: () => new Date("2026-10-01T12:00:00Z") },
    );
    expect([...check.links]).toEqual([
      ["Mercury", null],
      ["Message queue", "Message queue"],
      ["Zzqx repowiki no such article", null],
    ]);
    expect(check.failed).toEqual([]);
    const queue = entries.get("Message queue")?.summary;
    expect(queue?.url).toBe("https://en.wikipedia.org/wiki/Message_queue");
    expect(queue?.extract).toMatch(/message queue/i);
  });
});
