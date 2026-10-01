import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type HistoryEntry, type Revision, SCHEMA_VERSION, WikiExport } from "@repowiki/core";
import { EmptyStoreError } from "./errors.ts";
import type { Store } from "./store.ts";

export interface ExportOptions {
  repo: string;
  exportedAt: string;
}

function toHistoryEntry(revision: Revision): HistoryEntry {
  const { id, sha, commitDate, reason, pr } = revision;
  return { id, sha, commitDate, reason, pr };
}

/** Assembles and validates the export consumed by the reader site and by agents. */
export function buildExport(store: Store, options: ExportOptions): WikiExport {
  const head = store.getHead();
  const manifest = store.getLatestManifest();
  if (head === null || manifest === null) throw new EmptyStoreError();

  const pages = store.listCurrentRevisions();
  const history = Object.fromEntries(
    pages.map((page) => [page.featureId, store.listHistory(page.featureId).map(toHistoryEntry)]),
  );
  return WikiExport.parse({
    schemaVersion: SCHEMA_VERSION,
    repo: options.repo,
    head,
    exportedAt: options.exportedAt,
    manifest,
    pages,
    history,
  });
}

export function writeExport(store: Store, outPath: string, options: ExportOptions): void {
  const wiki = buildExport(store, options);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(wiki, null, 2)}\n`, "utf8");
}
