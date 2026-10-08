import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type Architecture,
  type Author,
  type InFlight,
  inflightProblems,
  LLMS_TXT_FILE,
  type PeopleExport,
  peopleProblems,
  type Revision,
  renderLlmsTxt,
  SCHEMA_VERSION,
  WikiExport,
  type WikipediaSummary,
} from "@repowiki/core";
import { runTotals } from "@repowiki/llm";
import { wikipediaTitlesIn } from "../link/index.ts";
import { EmptyStoreError } from "./errors.ts";
import { withoutCitedEmails } from "./people.ts";
import type { Store } from "./store.ts";

export interface ExportOptions {
  repo: string;
  exportedAt: string;
}

/**
 * The titles of every Wikipedia article the pages (and the current Architecture article) link,
 * normalized as the link module writes them.
 */
function linkedWikipediaTitles(pages: readonly (Revision | Architecture)[]): string[] {
  const titles = new Set<string>();
  for (const page of pages) {
    for (const section of page.sections) {
      for (const claim of section.claims) {
        for (const title of wikipediaTitlesIn(claim.text)) titles.add(title);
      }
    }
  }
  return [...titles].sort();
}

/**
 * The stored People (spec v2 #6 §5, R28): the snapshot and the current narrative of each human in
 * it, or null when there is no snapshot or it disagrees with the manifest (peopleProblems). A
 * narrative whose person left the snapshot (excluded or forgotten since) is left out.
 */
function storedPeople(store: Store, manifest: { features: readonly { id: string }[] }) {
  const snapshot = store.getPeopleSnapshot();
  if (snapshot === null) return null;
  const humans = new Set(snapshot.people.filter((p) => p.kind === "human").map((p) => p.id));
  const people: PeopleExport = {
    snapshot,
    // The group fingerprint is a hash of salted keys: it stays in the store (R10).
    pages: store
      .listCurrentPersonRevisions()
      .filter((page) => humans.has(page.personId))
      .map((page) => ({ ...withoutCitedEmails(page), groupFingerprint: null })),
  };
  return peopleProblems(people, { manifest }).length === 0 ? people : null;
}

/**
 * Work in flight's authors joined to People (spec v2 #6 C8), at export time, through the stored
 * registry (so a people-file change applies once a People refresh has stored it): a login the registry resolves to a person with a page gains
 * `person`; one resolving to an excluded person becomes null ("unknown author"), so their login
 * never appears; a bot keeps its badge; anyone else stays plain text. With no People in the
 * export (no snapshot, or a stale one), excluded logins are still dropped whenever the registry
 * holds an excluded row (the Task 29 ruling), and nobody is linked.
 */
function joinAuthors(store: Store, inflight: InFlight, people: PeopleExport | null): InFlight {
  if (people === null && !store.listPeopleRegistry().some((row) => row.status === "excluded"))
    return inflight;
  const pages = new Set(
    (people?.snapshot.people ?? []).filter((p) => p.kind === "human").map((p) => p.id),
  );
  const join = (author: Author): Author => {
    if (author === null) return null;
    const resolved = store.resolvePerson({ login: author.login });
    if (resolved?.kind === "excluded") return null;
    const id = resolved?.kind === "person" && pages.has(resolved.id) ? resolved.id : null;
    return { ...author, person: id };
  };
  return {
    ...inflight,
    pulls: inflight.pulls.map((p) => ({ ...p, author: join(p.author) })),
    issues: inflight.issues.map((i) => ({ ...i, author: join(i.author) })),
  };
}

/**
 * Assembles and validates the export consumed by the reader site and by agents. The stored
 * work-in-flight snapshot rides along only while it agrees with the export (inflightProblems): a
 * snapshot that names a claim the current pages no longer hold is left out (null) rather than
 * failing the export; wiki:inflight derives a new one. People follows the same rule
 * (storedPeople). A stored snapshot that no longer parses still throws, as every stored body
 * does: that is a schema change shipped without its migration.
 */
export function buildExport(store: Store, options: ExportOptions): WikiExport {
  const head = store.getHead();
  const manifest = store.getLatestManifest();
  if (head === null || manifest === null) throw new EmptyStoreError();

  const pages = store.listCurrentRevisions();
  const history = Object.fromEntries(
    pages.map((page) => [page.featureId, store.listHistory(page.featureId)]),
  );
  const architecture = store.listArchitectureHistory();
  const current = architecture.at(-1);
  const wikipedia: Record<string, WikipediaSummary> = {};
  for (const title of linkedWikipediaTitles(current === undefined ? pages : [...pages, current])) {
    const summary = store.getWikipediaSummary(title)?.summary;
    if (summary) wikipedia[title] = summary;
  }
  const stored = store.getInFlight();
  const people = storedPeople(store, manifest);
  const agreed =
    stored !== null && inflightProblems(stored, { head, manifest, pages }).length === 0
      ? stored
      : null;
  const inflight = agreed === null ? agreed : joinAuthors(store, agreed, people);
  return WikiExport.parse({
    schemaVersion: SCHEMA_VERSION,
    repo: options.repo,
    head,
    exportedAt: options.exportedAt,
    manifest,
    pages,
    history,
    wikipedia,
    architecture,
    runs: runTotals(store.listLedger()),
    inflight,
    people,
  });
}

/**
 * Writes `text` to `path` atomically: to a temporary file beside it, then renamed over it, so a
 * reader never sees half a file, and a failed write leaves the previous file in place.
 */
function writeAtomically(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Writes the export to `outPath` and the wiki's llms.txt beside it (spec §3 `export`), each
 * atomically, so a reader (or a site build) never sees half an export, and a failed write leaves
 * the previous files in place. Returns the export it wrote.
 */
export function writeExport(store: Store, outPath: string, options: ExportOptions): WikiExport {
  const wiki = buildExport(store, options);
  mkdirSync(dirname(outPath), { recursive: true });
  writeAtomically(outPath, `${JSON.stringify(wiki, null, 2)}\n`);
  writeAtomically(join(dirname(outPath), LLMS_TXT_FILE), renderLlmsTxt(wiki, basename(outPath)));
  return wiki;
}
