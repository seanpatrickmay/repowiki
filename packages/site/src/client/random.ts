/// <reference lib="dom" />
// /random/ sends the reader to a uniformly random active article. The candidates are embedded
// at build time; nothing from the query string or the network is ever used.

import { pageBase } from "../base-path.ts";

/** The slice of `Document` this script uses, so a test can stand in for it. */
interface Host {
  getElementById(id: string): { textContent: string | null } | null;
  documentElement: { dataset: { base?: string | undefined } };
}
interface Destination {
  replace(url: string): void;
}

/** Same-site article paths only, as the build writes them under the page's base. */
const ARTICLE_PATH = /^wiki\/[a-z0-9-]+\/$/;

export function goToRandomArticle(
  doc: Host,
  location: Destination,
  random: () => number = Math.random,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.getElementById("random-targets")?.textContent ?? "[]");
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  const base = pageBase(doc.documentElement);
  const urls = parsed.filter(
    (url): url is string =>
      typeof url === "string" && url.startsWith(base) && ARTICLE_PATH.test(url.slice(base.length)),
  );
  const pick = urls[Math.floor(random() * urls.length)];
  if (pick !== undefined) location.replace(pick);
}

if (typeof document !== "undefined") goToRandomArticle(document, window.location);
