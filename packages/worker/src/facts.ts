import type { WikiExport } from "@repowiki/core";
import { type AuthorFacts, Facts, type TechnologyUse } from "@repowiki/hosted";
import { AUTHOR_ID } from "./people-file.ts";

/** What facts need of an engine `IndexedFile`. */
export interface FileFacts {
  language: string | null;
  loc: number;
  skipped: string | null;
}

const NAMES: Record<string, string> = {
  python: "Python",
  typescript: "TypeScript",
  tsx: "TypeScript",
  rust: "Rust",
};

/** The files the engine indexed: every listed file it did not skip (Contract §7.2). */
export function indexedCount(files: readonly FileFacts[]): number {
  return files.filter((f) => f.skipped === null).length;
}

/** Languages by share of indexed lines, floored to 3 decimals so shares never sum past 1. */
export function languageShares(files: readonly FileFacts[]): { name: string; share: number }[] {
  const counted = files.filter((f) => f.skipped === null);
  const total = counted.reduce((sum, f) => sum + f.loc, 0);
  if (total === 0) return [];
  const lines = new Map<string, number>();
  for (const f of counted) {
    if (f.language === null) continue;
    const name = NAMES[f.language] ?? f.language;
    lines.set(name, (lines.get(name) ?? 0) + f.loc);
  }
  return [...lines]
    .map(([name, loc]) => ({ name, share: Math.floor((loc / total) * 1000) / 1000 }))
    .filter((l) => l.share > 0)
    .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name))
    .slice(0, 20);
}

/** What facts need of a People snapshot. */
export interface SnapshotFacts {
  commits: number;
  totalLines: number;
  people: readonly {
    id: string;
    commits: number;
    currentLines: number;
    features: readonly { featureId: string; commits: number; currentLines: number }[];
  }[];
}

/** The author's share of the snapshot; zeros when People found nothing (Contract §8). */
export function authorFacts(
  snapshot: SnapshotFacts | null,
  featureIds: readonly string[],
): AuthorFacts {
  if (snapshot === null) {
    return { commits: 0, totalCommits: 0, currentLines: 0, totalLines: 0, features: [] };
  }
  const person = snapshot.people.find((p) => p.id === AUTHOR_ID);
  const known = new Set(featureIds);
  return {
    commits: person?.commits ?? 0,
    totalCommits: snapshot.commits,
    currentLines: person?.currentLines ?? 0,
    totalLines: snapshot.totalLines,
    features: (person?.features ?? [])
      .filter((f) => known.has(f.featureId))
      .map((f) => ({ featureId: f.featureId, commits: f.commits, currentLines: f.currentLines })),
  };
}

/** The features that have a page: what highlights may name and hiding may remove. */
export function pageFeatureIds(exp: WikiExport): string[] {
  return [...new Set(exp.pages.map((p) => p.featureId))];
}

/**
 * A generation's facts (spec 2 §8) from the indexed files, the built export and the technologies
 * the index child detected (ADR-0014).
 */
export function buildFacts(
  files: readonly FileFacts[],
  exp: WikiExport,
  technologies: readonly TechnologyUse[] = [],
): Facts {
  const featureIds = pageFeatureIds(exp);
  return Facts.parse({
    languages: languageShares(files),
    indexedFiles: indexedCount(files),
    featureIds,
    author: authorFacts(exp.people?.snapshot ?? null, featureIds),
    technologies,
  });
}
