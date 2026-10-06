import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AskResponse, IsoDateTime, Sha256Hex, TokenUsage, type WikiExport } from "@repowiki/core";
import { z } from "zod";

/** The answer cache's file under `<out>/ask/` (spec v2 #4 R12, C11). */
export const ANSWERS_FILE = "answers.jsonl";

/**
 * Past this size at start, the cache is rewritten with only the current export's latest record
 * of each key, when that removes anything.
 */
export const COMPACT_BYTES = 5 * 1024 * 1024;

/** Past this size at start, the cache is not read: it is deleted and started again, empty. */
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;

/** One line of answers.jsonl: a cached answer and what it cost (spec v2 #4 §5.2). */
export const AskRecord = z.strictObject({
  v: z.literal(1),
  key: Sha256Hex,
  exportHash: Sha256Hex,
  model: z.string().min(1),
  promptVersion: z.number().int().min(1),
  response: AskResponse,
  tokens: TokenUsage,
  at: IsoDateTime,
});
export type AskRecord = z.infer<typeof AskRecord>;

/** JSON with object keys sorted at every depth, so key order never changes a hash. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The export as the ask reads it (spec v2 #4 R12): the SHA-256 of the canonical JSON of its
 * head, manifest, pages and About article. A refresh that rewrites other parts of export.json
 * (work in flight, People, the export time) leaves it, and so the cache, unchanged.
 */
export function exportHash(wiki: WikiExport): string {
  const { head, manifest, pages, architecture } = wiki;
  return sha256(canonical({ head, manifest, pages, architecture }));
}

/** A question as the cache compares it: NFKC, lower case, spaces collapsed, no closing ?.! */
export function normalizeQuestion(question: string): string {
  return question
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?.!]+$/, "");
}

/** What an answer's cache key is made of. */
export interface AnswerKeyParts {
  exportHash: string;
  model: string;
  promptVersion: number;
  /** The page hint as it resolved (a page id), or null. */
  page: string | null;
  question: string;
}

/** The cache key of a question: SHA-256 of its parts, the question normalized. */
export function answerKey(parts: AnswerKeyParts): string {
  return sha256(
    JSON.stringify([
      parts.exportHash,
      parts.model,
      parts.promptVersion,
      parts.page,
      normalizeQuestion(parts.question),
    ]),
  );
}

export interface AnswerCache {
  readonly path: string;
  /** Lines that were not an AskRecord, counted at open. */
  readonly skipped: number;
  /** The current export's record of a key, the latest when there are several. */
  get(key: string): AskRecord | undefined;
  /** Appends a record of the current export (one line) and remembers it. */
  append(record: AskRecord): void;
}

/** The lines of `text` that are AskRecords, and how many were not. */
function readRecords(text: string): { records: AskRecord[]; skipped: number } {
  const records: AskRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const parsed = AskRecord.safeParse(json);
    if (parsed.success) records.push(parsed.data);
    else skipped++;
  }
  return { records, skipped };
}

/**
 * Opens `<dir>/answers.jsonl` for one export (spec v2 #4 §5.2), creating `dir`. The file's size is
 * read first: past MAX_CACHE_BYTES it is deleted unread and started again, logged on one line.
 * Lines that fail AskRecord are counted, not fatal; another export's records are ignored, and
 * past COMPACT_BYTES the file is rewritten to a temporary file, then renamed, keeping only this
 * export's latest record of each key, unless that would remove nothing. `dir` must be the
 * resolved out dir's `ask/` (never inside the documented repository).
 */
export function openAnswerCache(
  dir: string,
  hash: string,
  log: (line: string) => void = () => {},
): AnswerCache {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ANSWERS_FILE);
  let size = existsSync(path) ? statSync(path).size : 0;
  if (size > MAX_CACHE_BYTES) {
    rmSync(path, { force: true });
    log(
      `ask cache: ${path} was over ${MAX_CACHE_BYTES / 1024 / 1024} MB, so it was deleted unread and started again`,
    );
    size = 0;
  }
  const text = size > 0 ? readFileSync(path, "utf8") : "";
  const { records, skipped } = readRecords(text);
  const byKey = new Map<string, AskRecord>();
  for (const r of records) if (r.exportHash === hash) byKey.set(r.key, r);
  let endsInNewline = text === "" || text.endsWith("\n");
  if (size > COMPACT_BYTES && (byKey.size < records.length || skipped > 0)) {
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, [...byKey.values()].map((r) => `${JSON.stringify(r)}\n`).join(""), {
        flag: "wx",
      });
      renameSync(temporary, path);
      endsInNewline = true;
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
  return {
    path,
    skipped,
    get: (key) => byKey.get(key),
    append(record) {
      const parsed = AskRecord.parse(record);
      // A line cut short by a crash stays its own (skipped) line, never the start of this one.
      appendFileSync(path, `${endsInNewline ? "" : "\n"}${JSON.stringify(parsed)}\n`);
      endsInNewline = true;
      if (parsed.exportHash === hash) byKey.set(parsed.key, parsed);
    },
  };
}
