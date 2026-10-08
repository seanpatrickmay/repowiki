import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { GitError, openStore, readHistory } from "@repowiki/engine";
import { checkPeopleStored } from "./people-problems.ts";
import { peoplePrintingFor, problemLine } from "./wiki-cli.ts";
import { checkWiki } from "./wiki-problems.ts";

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

/**
 * The commits reachable from the wiki's sha, read-only, or null (with a one-line usage error and
 * exit code 2 set) when the repository is not a git repository or does not hold that sha.
 */
function historyAt(sha: string): ReturnType<typeof readHistory> | null {
  try {
    return readHistory(repo, sha);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    const why = problemLine(err.message.split("\n")[0] ?? "");
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
  // With People on, printed lines are scrubbed of addresses (the Task 28 ruling).
  peoplePrintingFor(store);
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
      const check = await checkWiki(store, repo, history);
      for (const problem of check.problems) console.error(problemLine(problem));
      const n = check.problems.length;
      console.log(
        `${check.pages} pages${check.article ? " and the About article" : ""}: ${check.code} code citations re-hashed and ${check.commits} commit citations resolved; ${n === 0 ? "no problems" : `${n} problems`}`,
      );
      // Informational only: the site shows a link to a feature without a page as plain text.
      console.log(
        `${check.pageless} links name an active feature with no stored page (the site shows them as plain text)`,
      );
      // People (spec v2 #6 §9): the narratives re-verified, the outputs scanned for an email.
      const people = checkPeopleStored(store, repo, dirname(db));
      for (const problem of people.problems) console.error(problemLine(problem));
      if (people.on)
        console.log(
          `${people.narratives} person narratives re-verified and ${people.scanned} files scanned for an author's email; ${people.problems.length === 0 ? "no problems" : `${people.problems.length} problems`}`,
        );
      if (n > 0 || people.problems.length > 0) process.exitCode = 1;
    }
  } finally {
    store.close();
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
