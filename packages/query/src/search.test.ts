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

  it("takes the page search's boost only for the page search's own fields", () => {
    const custom: SearchDoc<"text">[] = [{ id: "a", fields: { text: "queue" } }];
    // @ts-expect-error: documents of other fields must name their boost
    const unboosted = () => searchIndex(custom);
    expect(typeof unboosted).toBe("function");
    expect(searchIndex(custom, { text: 1 }).search("queue", 8)).toEqual(["a"]);
  });

  it("returns at most `limit` ids and nothing for a query of stop words or unknown words", () => {
    const index = searchIndex(docs);
    expect(index.search("signals scheduler deliverables", 2)).toHaveLength(2);
    expect(index.search("how is the", 8)).toEqual([]);
    expect(index.search("kubernetes", 8)).toEqual([]);
    expect(searchIndex([]).search("signals", 8)).toEqual([]);
    expect(index.search("signals", 0)).toEqual([]);
    expect(index.search("signals", -1)).toEqual([]);
    expect(index.search("signals", 1.5)).toEqual(["signals"]);
  });

  it("ranks with scores in search's order, cut the same way", () => {
    const index = searchIndex(docs);
    const ranked = index.ranked("signals cron", 8);
    expect(ranked.map((m) => m.id)).toEqual(index.search("signals cron", 8));
    expect(ranked.map((m) => m.id)).toEqual(["scheduler", "signals", "deliverables"]);
    for (const [i, match] of ranked.entries()) {
      expect(match.score).toBeGreaterThan(0);
      if (i > 0) expect(match.score).toBeLessThanOrEqual(ranked[i - 1]?.score ?? 0);
    }
    expect(index.ranked("signals", 1.5)).toEqual([ranked.find((m) => m.id === "signals")]);
    expect(index.ranked("kubernetes", 8)).toEqual([]);
    expect(index.ranked("signals", 0)).toEqual([]);
  });

  it("takes other fields and boosts, the default staying the page search's", () => {
    const fields = [
      { id: "a", fields: { name: "queue", text: "worker" } },
      { id: "b", fields: { name: "worker", text: "queue" } },
    ];
    expect(searchIndex(fields, { name: 1, text: 5 }).search("queue", 8)).toEqual(["b", "a"]);
    expect(searchIndex(fields, { name: 5, text: 1 }).search("queue", 8)).toEqual(["a", "b"]);
  });
});
