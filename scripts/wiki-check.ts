import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Manifest } from "@repowiki/core";
import {
  architectureLinksWithoutPage,
  architectureProblems,
  commitCitationProblems,
  DEFAULT_MAX_FILE_BYTES,
  GitError,
  linksWithoutPage,
  openStore,
  readHistory,
  readSources,
  revisionProblems,
  storedArchitectureLinkViolations,
  storedLinkViolations,
} from "@repowiki/engine";

/**
 * pnpm wiki:check <repo> [--out dir]: spec §8's first two invariants on the stored wiki. Every
 * code citation of every current page resolves at its sha with a matching hash, every commit
 * citation names a commit in the history of the wiki's sha (read-only git), every diagram is
 * safe, and every link and See also entry was valid in the manifest at its page's own sha (a link
 * may name a disambiguation page) and still leads to a page today: an update carries pages
 * forward, and a later merge turns their links into redirects. The project's article (the About
 * page) is judged the same way, at its own sha, for its [[id]] links and the pages its claims
 * name. It also counts, for information only, the links and named pages that name an active
 * feature with no stored page. Read-only; exits 1 on any problem, and 2 for a usage error: bad
 * arguments, or a repository that is missing or does not hold the wiki's sha.
 *
 * openStore migrates and switches the file to WAL, so the check opens a throwaway copy of the
 * store (with its write-ahead log) and the wiki's own files are never opened for writing.
 */
const USAGE = "usage: pnpm wiki:check <repo-path> [--out dir]";
const argv = process.argv.slice(2);
const [repoArg, flag, outArg] = argv;
if (
  repoArg === undefined ||
  repoArg === "" ||
  (argv.length !== 1 && !(argv.length === 3 && flag === "--out" && outArg !== ""))
) {
  console.error(USAGE);
  process.exit(2);
}
const repo = resolve(repoArg);
if (!existsSync(repo) || !statSync(repo).isDirectory()) {
  console.error(`no such repository: ${repo}; ${USAGE}`);
  process.exit(2);
}
const db = join(outArg ?? join(homedir(), ".repowiki", basename(repo)), "wiki.db");
if (!existsSync(db)) {
  console.error(`no store at ${db}; run pnpm wiki:build first`);
  process.exit(1);
}

/** Problem lines quote ids and paths that came from a model: one printable line, cut short. */
const MAX_PROBLEM_LENGTH = 300;
const printable = (line: string): string =>
  line.slice(0, MAX_PROBLEM_LENGTH).replace(/[^\x20-\x7e]/g, "?");

/**
 * The commits reachable from the wiki's sha, read-only, or null (with a one-line usage error and
 * exit code 2 set) when the repository is not a git repository or does not hold that sha.
 */
function historyAt(sha: string): ReturnType<typeof readHistory> | null {
  try {
    return readHistory(repo, sha);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    const why = printable(err.message.split("\n")[0] ?? "");
    console.error(`${repo} does not hold ${sha}, the sha the wiki was built at (${why}); ${USAGE}`);
    process.exitCode = 2;
    return null;
  }
}

const scratch = mkdtempSync(join(tmpdir(), "repowiki-check-"));
try {
  const copy = join(scratch, "wiki.db");
  copyFileSync(db, copy);
  if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, `${copy}-wal`);
  const store = openStore(copy);
  try {
    const manifest = store.getLatestManifest();
    const pages = store.listCurrentRevisions();
    const head = store.getHead() ?? pages[0]?.sha;
    const history =
      manifest === null || pages.length === 0 || head === undefined ? null : historyAt(head);
    if (manifest === null || pages.length === 0) {
      console.error(`${db} has no pages yet; run pnpm wiki:build first`);
      process.exitCode = 1;
    } else if (history !== null) {
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
              ...storedArchitectureLinkViolations(
                article,
                manifestAt(article.sha),
                manifest,
                withPage,
              ),
            ]),
      ];
      const citations = [...pages, ...(article === null ? [] : [article])].flatMap((p) =>
        p.sections.flatMap((s) => s.claims.flatMap((c) => c.citations)),
      );
      const code = citations.filter((c) => c.kind === "code").length;
      for (const problem of problems) console.error(printable(problem));
      console.log(
        `${pages.length} pages${article === null ? "" : " and the About article"}: ${code} code citations re-hashed and ${citations.length - code} commit citations resolved; ${problems.length === 0 ? "no problems" : `${problems.length} problems`}`,
      );
      // Informational only: the site shows a link to a feature without a page as plain text.
      const pageless =
        linksWithoutPage(pages, manifest) +
        (article === null ? 0 : architectureLinksWithoutPage(article, manifest, withPage));
      console.log(
        `${pageless} links name an active feature with no stored page (the site shows them as plain text)`,
      );
      if (problems.length > 0) process.exitCode = 1;
    }
  } finally {
    store.close();
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
