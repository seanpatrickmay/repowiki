import type { Manifest } from "@repowiki/core";
import {
  architectureLinksWithoutPage,
  architectureProblems,
  commitCitationProblems,
  DEFAULT_MAX_FILE_BYTES,
  linksWithoutPage,
  type readHistory,
  readSources,
  revisionProblems,
  type Store,
  storedArchitectureLinkViolations,
  storedLinkViolations,
} from "@repowiki/engine";

/** What wiki:check found, and what wiki:replay records after every step. */
export interface WikiCheck {
  pages: number;
  article: boolean;
  /** Code citations re-hashed, and commit citations resolved. */
  code: number;
  commits: number;
  /** One line each; empty when spec §8's first two invariants hold. */
  problems: string[];
  /** Links naming an active feature with no stored page (informational). */
  pageless: number;
}

/**
 * Spec §8's first two invariants on the stored wiki, read-only: every code citation of every
 * current page and of the About article resolves at its sha with a matching hash, every commit
 * citation is in `history` (the commits reachable from the wiki's head), every diagram is safe,
 * and every link and See also entry was valid in the manifest at its page's own sha (a link may
 * name a disambiguation page) and still leads to a page today, the About article included.
 */
export function checkWiki(
  store: Store,
  repo: string,
  history: ReturnType<typeof readHistory>,
): WikiCheck {
  const manifest = store.getLatestManifest();
  const pages = store.listCurrentRevisions();
  if (manifest === null) {
    return { pages: 0, article: false, code: 0, commits: 0, problems: [], pageless: 0 };
  }
  const bySha = new Map<string, ReadonlyMap<string, string>>();
  const sourcesAt = (sha: string) => {
    let sources = bySha.get(sha);
    if (sources === undefined) {
      sources = readSources(repo, sha, DEFAULT_MAX_FILE_BYTES);
      bySha.set(sha, sources);
    }
    return sources;
  };
  const article = store.getCurrentArchitecture();
  // The manifest a page or the article was written against, read and parsed once per sha.
  // Manifests are append-only, so a sha with none means a damaged or imported store; the
  // check then falls back to the current manifest, which judges the page as if it were
  // current (a link the linker wrote correctly then may read as a violation).
  const manifestBySha = new Map<string, Manifest>();
  const manifestAt = (sha: string): Manifest => {
    let at = manifestBySha.get(sha);
    if (at === undefined) {
      at = store.getManifest(sha) ?? manifest;
      manifestBySha.set(sha, at);
    }
    return at;
  };
  const withPage = new Set(pages.map((page) => page.featureId));
  const problems = [
    ...pages.flatMap((page) => [
      ...revisionProblems(page, sourcesAt),
      ...commitCitationProblems(page, history),
      ...storedLinkViolations(page, manifestAt(page.sha), manifest, withPage),
    ]),
    ...(article === null
      ? []
      : [
          ...architectureProblems(article, sourcesAt, history),
          ...storedArchitectureLinkViolations(article, manifestAt(article.sha), manifest, withPage),
        ]),
  ];
  const citations = [...pages, ...(article === null ? [] : [article])].flatMap((p) =>
    p.sections.flatMap((s) => s.claims.flatMap((c) => c.citations)),
  );
  const code = citations.filter((c) => c.kind === "code").length;
  return {
    pages: pages.length,
    article: article !== null,
    code,
    commits: citations.length - code,
    problems,
    pageless:
      linksWithoutPage(pages, manifest) +
      (article === null ? 0 : architectureLinksWithoutPage(article, manifest, withPage)),
  };
}
