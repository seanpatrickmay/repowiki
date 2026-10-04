import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Architecture,
  type Revision,
  SCHEMA_VERSION,
  WikiExport,
  type WikipediaSummary,
} from "@repowiki/core";
import { runTotals } from "@repowiki/llm";
import { wikipediaTitlesIn } from "../link/index.ts";
import { EmptyStoreError } from "./errors.ts";
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

/** Assembles and validates the export consumed by the reader site and by agents. */
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
  });
}

/**
 * Writes the export to `outPath` atomically: to a temporary file beside it, then renamed over it,
 * so a reader (or a site build) never sees half an export, and a failed write leaves the previous
 * export in place.
 */
export function writeExport(store: Store, outPath: string, options: ExportOptions): void {
  const wiki = buildExport(store, options);
  mkdirSync(dirname(outPath), { recursive: true });
  const temporary = `${outPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(wiki, null, 2)}\n`, "utf8");
    renameSync(temporary, outPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
