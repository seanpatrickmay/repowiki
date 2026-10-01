/// <reference lib="dom" />
// /random/ sends the reader to a uniformly random active article. The candidates are embedded
// at build time; nothing from the query string or the network is ever used.

/** The slice of `Document` this script uses, so a test can stand in for it. */
interface Host {
  getElementById(id: string): { textContent: string | null } | null;
}
interface Destination {
  replace(url: string): void;
}

/** Same-site article paths only, as the build writes them. */
const ARTICLE_URL = /^\/wiki\/[a-z0-9-]+\/$/;

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
  const urls = parsed.filter(
    (url): url is string => typeof url === "string" && ARTICLE_URL.test(url),
  );
  const pick = urls[Math.floor(random() * urls.length)];
  if (pick !== undefined) location.replace(pick);
}

if (typeof document !== "undefined") goToRandomArticle(document, window.location);
