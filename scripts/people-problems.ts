import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizedText } from "@repowiki/core";
import { personRevisionProblems, readPeople, type Store } from "@repowiki/engine";
import { loadPeopleFile, ownerEmailOf, peopleFilePath } from "./people-cli.ts";

/** What wiki:check found about People. */
export interface PeopleCheck {
  /** Current narratives re-verified. */
  narratives: number;
  /** Files scanned for an author's email. */
  scanned: number;
  /** One line each, never holding a name's or an email's text beyond a person id. */
  problems: string[];
}

/** The site's text files, under `<out>/site` when it was built. */
const SITE_TEXT = /\.(?:html|svg|xml|txt|json|js|css)$/;

/** The files of the out dir People's privacy rule covers (spec v2 #6 §9, §13). */
function outputFiles(out: string): string[] {
  const top = ["export.json", "llms.txt"].map((f) => join(out, f));
  const summaries = existsSync(out)
    ? readdirSync(out)
        .filter((f) => /^people-[0-9a-f]{7}\.md$/.test(f))
        .map((f) => join(out, f))
    : [];
  const site = join(out, "site");
  const pages =
    existsSync(site) && statSync(site).isDirectory()
      ? (readdirSync(site, { recursive: true }) as string[])
          .filter((f) => SITE_TEXT.test(f))
          .map((f) => join(site, f))
      : [];
  return [...top, ...summaries, ...pages].filter((f) => existsSync(f) && statSync(f).isFile());
}

/**
 * wiki:check's People half (spec v2 #6 §9): every current narrative re-verified against the
 * stored snapshot's history and the identity map as it stands now (personRevisionProblems), then
 * the export, llms.txt, People summaries and the built site scanned for any author's email, read
 * from git at check time. A problem names the file, never the address.
 */
export function checkPeopleStored(store: Store, repo: string, out: string): PeopleCheck {
  const problems: string[] = [];
  const snapshot = store.getPeopleSnapshot();
  const sha = snapshot?.sha ?? store.getHead();
  if (sha === null) return { narratives: 0, scanned: 0, problems };
  let config: ReturnType<typeof loadPeopleFile>;
  try {
    config = loadPeopleFile(peopleFilePath(repo, out, null));
  } catch (err) {
    problems.push(`people file: ${err instanceof Error ? err.message : String(err)}`);
    config = loadPeopleFile(join(out, "no-such-people-file.json"));
  }
  const ownerEmail = ownerEmailOf(repo, (line) => console.error(line));
  const read = readPeople({ repo, sha, store, config, ownerEmail });
  const revisions = snapshot === null ? [] : store.listCurrentPersonRevisions();
  if (snapshot !== null) {
    const manifests = store.listManifests();
    const latest = manifests[0];
    if (latest !== undefined)
      problems.push(
        ...personRevisionProblems({
          read,
          snapshot,
          revisions,
          manifests,
          manifestAt: (at) => store.getManifest(at) ?? latest,
          latest,
          pages: new Set(store.listCurrentRevisions().map((page) => page.featureId)),
        }),
      );
  }
  // Both sides normalised (NFKC, invisible characters dropped), so a fullwidth or small at sign
  // or dot is the same address (the Task 28 ruling).
  const seen = (text: string) => normalizedText(text).toLowerCase();
  const emails = [
    ...new Set(read.commits.map((c) => seen(c.authorEmail)).filter((e) => e.includes("@"))),
  ];
  const files = outputFiles(out);
  for (const file of files) {
    const text = seen(readFileSync(file, "utf8"));
    if (emails.some((email) => text.includes(email)))
      problems.push(`${relative(out, file)} holds an author's email address`);
  }
  return { narratives: revisions.length, scanned: files.length, problems };
}
