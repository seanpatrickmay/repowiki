import type { WikipediaCacheEntry } from "@repowiki/core";
import type { WikipediaCache } from "../link/index.ts";

/** A WikipediaCache in a Map. Test-only. */
export function memoryWikipediaCache(): WikipediaCache {
  const entries = new Map<string, WikipediaCacheEntry>();
  return {
    get: (title) => entries.get(title) ?? null,
    put: (title, summary, fetchedAt) => {
      entries.set(title, { summary, fetchedAt });
    },
  };
}
