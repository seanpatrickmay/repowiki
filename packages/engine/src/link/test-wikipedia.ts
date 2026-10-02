import type { WikipediaCacheEntry } from "@repowiki/core";
import type { WikipediaCache } from "./wikipedia.ts";

/** A WikipediaCache in a Map, for tests. */
export function memoryCache(initial: Record<string, WikipediaCacheEntry> = {}) {
  const entries = new Map(Object.entries(initial));
  const cache: WikipediaCache = {
    get: (title) => entries.get(title) ?? null,
    put: (title, summary, fetchedAt) => {
      entries.set(title, { summary, fetchedAt });
    },
  };
  return { cache, entries };
}
