import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAskResponse } from "@repowiki/core/test-fixtures";
import { type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ANSWERS_FILE,
  type AskRecord,
  answerKey,
  COMPACT_BYTES,
  exportHash,
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
});
