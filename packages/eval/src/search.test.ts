import { describe, expect, it } from "vitest";
import { type SearchDoc, searchIndex, terms } from "./search.ts";

const doc = (id: string, fields: Partial<SearchDoc["fields"]>): SearchDoc => ({
  id,
  fields: { title: "", aliases: "", lead: "", body: "", ...fields },
});

describe("terms", () => {
  it("splits identifiers, folds case and accents, drops stop words and cuts plurals", () => {
    expect(terms("How does ingestChunk save_signals in Café Policies?")).toEqual([
      "ingest",
      "chunk",
      "save",
      "signal",
      "cafe",
      "policy",
    ]);
    expect(terms("a I to classes")).toEqual(["classe"]);
  });
});

describe("searchIndex", () => {
  const docs = [
    doc("signals", { title: "Signal ingestion", body: "ingest_chunk saves signals" }),
    doc("deliverables", { title: "Deliverables", body: "built from signals and signals" }),
    doc("scheduler", { title: "Scheduler", aliases: "cron jobs" }),
  ];

  it("ranks a title match over body mentions, and ties by id", () => {
    const index = searchIndex(docs);
    expect(index.search("signals", 8)).toEqual(["signals", "deliverables"]);
    expect(index.search("cron", 8)).toEqual(["scheduler"]);
    const twins = searchIndex([
      doc("b", { body: "queue worker" }),
      doc("a", { body: "queue worker" }),
    ]);
    expect(twins.search("queue", 8)).toEqual(["a", "b"]);
  });

  it("returns at most `limit` ids and nothing for a query of stop words or unknown words", () => {
    const index = searchIndex(docs);
    expect(index.search("signals scheduler deliverables", 2)).toHaveLength(2);
    expect(index.search("how is the", 8)).toEqual([]);
    expect(index.search("kubernetes", 8)).toEqual([]);
    expect(searchIndex([]).search("signals", 8)).toEqual([]);
  });
});
