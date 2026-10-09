import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAskResponse } from "@repowiki/core/test-fixtures";
import { extendedWiki, type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ANSWERS_FILE,
  type AskRecord,
  answerKey,
  COMPACT_BYTES,
  exportHash,
  MAX_CACHE_BYTES,
  normalizeQuestion,
  openAnswerCache,
} from "./cache.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "repowiki-ask-cache-")), "ask");
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const record = (key: string, exportHash = HASH): AskRecord => ({
  v: 1,
  key,
  exportHash,
  model: "claude-haiku-4-5",
  promptVersion: 1,
  response: makeAskResponse(),
  tokens: { in: 3000, out: 350, cacheRead: 0, cacheWrite: 0 },
  at: "2026-10-05T12:00:00.000Z",
});
const key = (n: number) => n.toString(16).padStart(64, "0");

describe("normalizeQuestion", () => {
  it("folds case, width and spacing and drops the closing punctuation", () => {
    expect(normalizeQuestion("  Where ARE\n signals   made?!. ")).toBe("where are signals made");
    expect(normalizeQuestion("\uFF37here are signals made\uFF1F")).toBe("where are signals made");
    expect(normalizeQuestion("What is v2.0?")).toBe("what is v2.0");
  });
});

describe("answerKey", () => {
  const parts = {
    exportHash: HASH,
    model: "claude-haiku-4-5",
    promptVersion: 1,
    page: null,
    question: "Where are signals made?",
  };

  it("is the same for the same question asked differently", () => {
    expect(answerKey({ ...parts, question: "where are  signals made" })).toBe(answerKey(parts));
    expect(answerKey(parts)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["export", { exportHash: OTHER }],
    ["model", { model: "claude-sonnet-5-5" }],
    ["prompt version", { promptVersion: 2 }],
    ["page hint", { page: "signals" }],
    ["question", { question: "Where are deliverables made?" }],
  ])("changes with the %s", (_name, change) => {
    expect(answerKey({ ...parts, ...change })).not.toBe(answerKey(parts));
  });
});

describe("exportHash", () => {
  it("hashes what the ask reads and ignores the rest of export.json", () => {
    const wiki = sample.wiki;
    const hash = exportHash(wiki);
    expect(exportHash(structuredClone(wiki))).toBe(hash);
    expect(exportHash({ ...wiki, exportedAt: "2027-01-01T00:00:00Z", history: {}, runs: [] })).toBe(
      hash,
    );
    const reordered = Object.fromEntries(Object.entries(wiki).reverse()) as typeof wiki;
    expect(exportHash(reordered)).toBe(hash);
    expect(exportHash({ ...wiki, pages: wiki.pages.slice(1) })).not.toBe(hash);
    expect(exportHash({ ...wiki, architecture: [] })).toBe(hash);
    expect(exportHash({ ...wiki, head: "f".repeat(40) })).not.toBe(hash);
  });

  it("changes with the About article and with the manifest alone", () => {
    const wiki = extendedWiki(sample);
    const hash = exportHash(wiki);
    expect(wiki.architecture.length).toBeGreaterThan(0);
    expect(exportHash({ ...wiki, architecture: [] })).not.toBe(hash);
    const changed = structuredClone(wiki);
    const claim = changed.architecture[0]?.sections[0]?.claims[0];
    if (claim === undefined) throw new Error("no About claim");
    claim.text = `${claim.text} Changed.`;
    expect(exportHash(changed)).not.toBe(hash);
    const manifest = { ...wiki.manifest, features: wiki.manifest.features.slice(1) };
    expect(exportHash({ ...wiki, manifest })).not.toBe(hash);
  });
});

describe("openAnswerCache", () => {
  it("appends and finds a record, across a reopen", () => {
    const cache = openAnswerCache(dir, HASH);
    expect(cache.get(key(1))).toBeUndefined();
    cache.append(record(key(1)));
    expect(cache.get(key(1))).toEqual(record(key(1)));
    expect(openAnswerCache(dir, HASH).get(key(1))).toEqual(record(key(1)));
    expect(cache.path).toBe(join(dir, ANSWERS_FILE));
  });

  it("keeps the latest record of a key, and ignores another export's", () => {
    const cache = openAnswerCache(dir, HASH);
    cache.append(record(key(1)));
    cache.append({ ...record(key(1)), at: "2026-10-06T00:00:00.000Z" });
    cache.append(record(key(2), OTHER));
    const reopened = openAnswerCache(dir, HASH);
    expect(reopened.get(key(1))?.at).toBe("2026-10-06T00:00:00.000Z");
    expect(reopened.get(key(2))).toBeUndefined();
    expect(reopened.skipped).toBe(0);
  });

  it("counts lines that are not records, and starts a line cut short on its own", () => {
    const cache = openAnswerCache(dir, HASH);
    cache.append(record(key(1)));
    const path = join(dir, ANSWERS_FILE);
    writeFileSync(path, `${readFileSync(path, "utf8")}not json\n{"v":2}\n{"v":1,"key":`);
    const reopened = openAnswerCache(dir, HASH);
    expect(reopened.skipped).toBe(3);
    reopened.append(record(key(2)));
    const again = openAnswerCache(dir, HASH);
    expect(again.get(key(1))).toBeDefined();
    expect(again.get(key(2))).toBeDefined();
    expect(again.skipped).toBe(3);
  });

  it("refuses to append a record that is not one", () => {
    const cache = openAnswerCache(dir, HASH);
    expect(() => cache.append({ ...record(key(1)), key: "short" })).toThrow();
    expect(existsSync(join(dir, ANSWERS_FILE))).toBe(false);
  });

  it("past 5 MB, rewrites the file by rename, keeping only this export's records", () => {
    const first = openAnswerCache(dir, HASH);
    first.append(record(key(1)));
    const line = `${JSON.stringify(record(key(2), OTHER))}\n`;
    const path = join(dir, ANSWERS_FILE);
    writeFileSync(
      path,
      readFileSync(path, "utf8") + line.repeat(Math.ceil(COMPACT_BYTES / line.length) + 1),
    );
    const cache = openAnswerCache(dir, HASH);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(record(key(1)))}\n`);
    expect(cache.get(key(1))).toEqual(record(key(1)));
    expect(readdirSync(dir)).toEqual([ANSWERS_FILE]);
  });

  it("past 5 MB, keeps only the latest record of each key", () => {
    const path = join(dir, ANSWERS_FILE);
    const copy = (n: number) =>
      `${JSON.stringify({ ...record(key(1)), at: `2026-10-05T12:00:${String(n % 60).padStart(2, "0")}.000Z` })}\n`;
    const count = Math.ceil(COMPACT_BYTES / copy(0).length) + 1;
    const last = { ...record(key(1)), at: "2026-10-06T00:00:00.000Z" };
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      `${Array.from({ length: count }, (_, n) => copy(n)).join("")}${JSON.stringify(last)}\n`,
    );
    const cache = openAnswerCache(dir, HASH);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(last)}\n`);
    expect(cache.get(key(1))).toEqual(last);
  });

  it("past 5 MB, leaves a file it would remove nothing from as it is", () => {
    const path = join(dir, ANSWERS_FILE);
    const line = (n: number) => `${JSON.stringify(record(key(n)))}\n`;
    const count = Math.ceil(COMPACT_BYTES / line(0).length) + 1;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, Array.from({ length: count }, (_, n) => line(n)).join(""));
    const before = statSync(path);
    const cache = openAnswerCache(dir, HASH);
    const after = statSync(path);
    expect([after.ino, after.mtimeMs, after.size]).toEqual([
      before.ino,
      before.mtimeMs,
      before.size,
    ]);
    expect(cache.get(key(count - 1))).toBeDefined();
  });

  it("drops a file past its size bound before reading it, logging one line", () => {
    const path = join(dir, ANSWERS_FILE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "");
    truncateSync(path, MAX_CACHE_BYTES + 1);
    const lines: string[] = [];
    const cache = openAnswerCache(dir, HASH, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/answers\.jsonl.*started again/);
    expect(existsSync(path)).toBe(false);
    expect(cache.skipped).toBe(0);
    cache.append(record(key(1)));
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(record(key(1)))}\n`);
  });
});
