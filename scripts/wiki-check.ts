import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  DEFAULT_MAX_FILE_BYTES,
  GitError,
  linkViolations,
  openStore,
  readHistory,
  readSources,
  revisionProblems,
} from "@repowiki/engine";

/**
 * pnpm wiki:check <repo> [--out dir]: spec §8's first two invariants on the stored wiki. Every
 * code citation of every current page resolves at its sha with a matching hash, every diagram is
 * safe, and no link names an id without a page. Read-only; exits 1 on any problem, and 2 for a
 * usage error: bad arguments, or a repository that is missing or does not hold the wiki's sha.
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
      const problems = pages.flatMap((page) => [
        ...revisionProblems(page, sourcesAt),
        ...linkViolations(page, manifest),
      ]);
      const citations = pages.reduce(
        (n, p) =>
          n +
          p.sections.reduce((m, s) => m + s.claims.reduce((k, c) => k + c.citations.length, 0), 0),
        0,
      );
      for (const problem of problems) console.error(printable(problem));
      console.log(
        `${pages.length} pages, ${citations} citations: ${problems.length === 0 ? "every citation resolves with a matching hash and every link has a page" : `${problems.length} problems`}`,
      );
      if (problems.length > 0) process.exitCode = 1;
    }
  } finally {
    store.close();
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
