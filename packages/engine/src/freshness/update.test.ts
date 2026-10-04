import { INGEST_PY } from "@repowiki/core/test-fixtures";
import { type GenerateRequest, LlmError } from "@repowiki/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestRepo } from "../index/index.ts";
import { buildExport, type Store } from "../store/index.ts";
import { UpdateDraft, UpdateFixes } from "../verify/index.ts";
import type { BuildJournal } from "../write/index.ts";
import { ManifestOperations } from "./ops.ts";
import { UpdateError } from "./plan.ts";
import { scriptedProvider } from "./test-provider.ts";
import { builtWiki, inputAt } from "./test-wiki-repo.ts";
import { TieBreakAnswer } from "./tiebreak.ts";
import { updateWiki } from "./update.ts";

let repo: TestRepo;
let store: Store;
let first: string;
afterEach(() => {
  store.close();
  repo.remove();
});

/** Answers each kind of call: write calls by `pages`, everything else with nothing to do. */
function provider(pages: (featureId: string, request: GenerateRequest<unknown>) => unknown) {
  return scriptedProvider((request) => {
    if (request.schema === TieBreakAnswer) return { files: [] };
    if (request.schema === ManifestOperations) return { operations: [] };
    if (request.schema === UpdateFixes) return { claims: [] };
    if (request.schema === UpdateDraft) return pages(request.featureId ?? "", request);
    throw new Error(`unexpected call for ${request.featureId}`);
  });
}
const claim = (
  id: string,
  section: string,
  text: string,
  cite: string[],
  supports: string[] = [],
) => ({
  id,
  section,
  text,
  cite,
  supports,
  hook: false,
});
const options = { repoName: "sample", driftThreshold: Number.POSITIVE_INFINITY };

/** A journal whose flush is observable; it holds no rows. */
function spyJournal() {
  const flush = vi.fn();
  const journal: BuildJournal = {
    lookup: () => null,
    record: () => {},
    forget: () => {},
    tag: () => {},
    flush,
  };
  return { journal, flush };
}

/** A pull request that edits ingest_chunk and adds src/signals/batch.py, merged as #7. */
function mergePaging(): { branch: string; merge: string } {
  repo.git("switch", "-q", "-c", "paging");
  repo.write(
    "src/signals/ingest.py",
    INGEST_PY.replace(
      "    # Blank sentences make no signal.",
      "    # Blank sentences are skipped.",
    ),
  );
  repo.write("src/signals/batch.py", "def drain(queue):\n    return list(queue)\n");
  const branch = repo.commit("feat: drain signals in batches");
  repo.git("switch", "-q", "main");
  return { branch, merge: repo.merge("paging", "Merge pull request #7 from me/paging") };
}

describe("updateWiki", () => {
  it("rewrites the stale page, fills its gap, appends history and carries the other forward", async () => {
    ({ repo, store, first } = await builtWiki());
    const { branch, merge } = mergePaging();
    const { provider: p, requests } = provider(() => ({
      claims: [
        claim(
          "c1",
          "lead",
          "**Signal ingestion** turns chunks into signals in batches.",
          [],
          ["c2", "c3", "n1"],
        ),
        claim("c2", "overview", "`ingest_chunk()` skips blank sentences.", [
          "src/signals/ingest.py:10-24",
        ]),
        claim("n1", "how-it-works", "`drain()` empties a queue into a list.", [
          "src/signals/batch.py:1-2",
        ]),
        claim("n2", "history", "Batch draining arrived in PR 7.", [`commit:${branch.slice(0, 7)}`]),
      ],
      diagram: { nodes: [], edges: [] },
    }));
    const result = await updateWiki(store, await inputAt(repo, merge), { ...options, provider: p });

    expect(requests.map((r) => [r.purpose, r.featureId ?? null])).toEqual([["write", "signals"]]);
    expect(requests[0]?.messages[0]?.content).toContain("src/signals/batch.py:1-2 (drain)");
    expect(result).toMatchObject({
      from: first,
      to: merge,
      pr: 7,
      commits: 2,
      revised: false,
      drift: null,
      carried: ["deliverables"],
      staleClaims: 0,
    });
    const [signals] = result.stored;
    expect(signals).toMatchObject({
      featureId: "signals",
      reason: "update",
      pr: 7,
      parentId: `signals-${first.slice(0, 12)}`,
      sha: merge,
    });
    expect(signals?.sections.map((s) => [s.key, s.claims.map((c) => c.text)])).toEqual([
      ["lead", ["**Signal ingestion** turns chunks into signals in batches."]],
      ["overview", ["`ingest_chunk()` skips blank sentences."]],
      ["how-it-works", ["`drain()` empties a queue into a list."]],
      ["history", ["Signal ingestion was added first.", "Batch draining arrived in PR 7."]],
    ]);
    expect(store.getHead()).toBe(merge);
    expect(store.getCurrentRevision("signals")?.id).toBe(signals?.id);
    expect(store.getCurrentRevision("deliverables")?.sha).toBe(first);
    expect(store.getManifest(merge)?.membership["src/signals/batch.py"]?.featureId).toBe("signals");
    expect(store.getDriftBaseline()?.sha).toBe(first);
    expect(
      buildExport(store, { repo: "sample", exportedAt: "2026-10-03T12:00:00Z" }).history.signals,
    ).toHaveLength(2);
  });

  it("keeps a claim the model cannot fix, marked stale since the new commit", async () => {
    ({ repo, store, first } = await builtWiki());
    const { merge } = mergePaging();
    const { provider: p } = provider(() => ({
      claims: [
        claim("c2", "overview", "Gone.", []),
        claim("c1", "lead", "**Signal ingestion** x.", [], []),
      ],
      diagram: { nodes: [], edges: [] },
    }));
    const result = await updateWiki(store, await inputAt(repo, merge), { ...options, provider: p });
    expect(result.staleClaims).toBe(2);
    const page = store.getCurrentRevision("signals");
    expect(page?.sections.flatMap((s) => s.claims.map((c) => [c.id, c.staleSince]))).toEqual([
      ["c1", merge],
      ["c2", merge],
      ["c3", null],
    ]);
  });

  it("asks for manifest operations when a feature drifts, and makes the result the new baseline", async () => {
    ({ repo, store, first } = await builtWiki());
    const { merge } = mergePaging();
    const { provider: p, requests } = provider(() => ({
      claims: [],
      diagram: { nodes: [], edges: [] },
    }));
    const result = await updateWiki(store, await inputAt(repo, merge), {
      ...options,
      driftThreshold: 0,
      provider: p,
    });
    expect(requests.map((r) => r.purpose)).toContain("manifest");
    expect(result.revised).toBe(true);
    expect(store.getDriftBaseline()?.sha).toBe(merge);
  });

  it("retires a feature whose every file was deleted, when the drift call says so", async () => {
    ({ repo, store, first } = await builtWiki());
    repo.git("rm", "-q", "src/deliverables/crud.py");
    const removed = repo.commit("chore: remove deliverables");
    const { provider: p, requests } = scriptedProvider((request) =>
      request.schema === ManifestOperations
        ? {
            operations: [
              {
                kind: "retire",
                feature: "deliverables",
                title: "",
                aliases: [],
                clusters: [],
                into: "",
                targets: [],
              },
            ],
          }
        : new Error(`unexpected ${request.purpose} call`),
    );
    const result = await updateWiki(store, await inputAt(repo, removed), {
      repoName: "sample",
      provider: p,
    });
    expect(requests.map((r) => r.purpose)).toEqual(["manifest"]);
    expect(result.manifest.features.find((f) => f.id === "deliverables")?.status).toEqual({
      kind: "retired",
    });
    expect(result.stored).toEqual([]);
    expect(store.getCurrentRevision("deliverables")?.sha).toBe(first);
    expect(() =>
      buildExport(store, { repo: "sample", exportedAt: "2026-10-03T12:00:00Z" }),
    ).not.toThrow();
  });

  it("makes no call and stores no page for a commit that changes nothing", async () => {
    ({ repo, store, first } = await builtWiki());
    const empty = repo.commit("chore: nothing");
    const { provider: p, requests } = provider(() => new Error("no call expected"));
    const result = await updateWiki(store, await inputAt(repo, empty), { ...options, provider: p });
    expect(requests).toEqual([]);
    expect(result).toMatchObject({ stored: [], carried: ["deliverables", "signals"], pr: null });
    expect(store.getHead()).toBe(empty);
  });

  it("stops before storing anything when a call fails", async () => {
    ({ repo, store, first } = await builtWiki());
    const { merge } = mergePaging();
    const { provider: p } = provider(() => new LlmError("the batch expired"));
    await expect(
      updateWiki(store, await inputAt(repo, merge), { ...options, provider: p }),
    ).rejects.toThrow(UpdateError);
    expect(store.getHead()).toBe(first);
    expect(store.getManifest(merge)).toBeNull();
    expect(store.getCurrentRevision("signals")?.sha).toBe(first);
  });

  it("refuses a commit the wiki is at, or one that is not after it", async () => {
    ({ repo, store, first } = await builtWiki());
    repo.git("switch", "-q", "--orphan", "other");
    repo.write("x.py", "x = 1\n");
    const unrelated = repo.commit("other root");
    const { provider: p } = provider(() => ({}));
    await expect(
      updateWiki(store, await inputAt(repo, first), { ...options, provider: p }),
    ).rejects.toThrow(`the wiki is already at ${first}`);
    await expect(
      updateWiki(store, await inputAt(repo, unrelated), { ...options, provider: p }),
    ).rejects.toThrow("is not an ancestor of");
  });

  describe("rules earlier reviews pinned", () => {
    it("keeps the Wikipedia link of a claim it did not rewrite, on a page it did", async () => {
      ({ repo, store, first } = await builtWiki());
      // The stored page's history claim carries a link that was checked when it was written.
      const stored = store.getCurrentRevision("signals");
      if (stored === null) throw new Error("no page");
      store.putRevision({
        ...stored,
        id: "signals-linked",
        parentId: stored.id,
        reason: "update",
        sections: stored.sections.map((s) => ({
          ...s,
          claims: s.claims.map((c) =>
            c.id === "c3" ? { ...c, text: "It reads a [[wp:Message queue]] first." } : c,
          ),
        })),
      });
      store.putWikipediaSummary(
        "Message queue",
        {
          title: "Message queue",
          extract: "A message queue is a form of communication.",
          url: "https://en.wikipedia.org/wiki/Message_queue",
        },
        "2026-10-01T00:00:00Z",
      );
      const { merge } = mergePaging();
      const { provider: p } = provider(() => ({
        claims: [
          claim("c2", "overview", "`ingest_chunk()` skips blank sentences.", [
            "src/signals/ingest.py:10-24",
          ]),
        ],
        diagram: { nodes: [], edges: [] },
      }));
      const unreachable = async (): Promise<Response> => {
        throw new TypeError("no network in tests");
      };
      const result = await updateWiki(store, await inputAt(repo, merge), {
        ...options,
        provider: p,
        wikipediaFetch: unreachable,
      });
      const texts = result.stored[0]?.sections.flatMap((s) => s.claims.map((c) => c.text));
      expect(texts).toContain("It reads a [[wp:Message queue]] first.");
      expect(texts).toContain("`ingest_chunk()` skips blank sentences.");
      expect(store.getCurrentRevision("signals")?.sections.flatMap((s) => s.claims)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "c3", text: "It reads a [[wp:Message queue]] first." }),
        ]),
      );
    });

    it("flushes the journal in the transaction that stores the update", async () => {
      ({ repo, store, first } = await builtWiki());
      const { merge } = mergePaging();
      const { journal, flush } = spyJournal();
      const { provider: p } = provider(() => ({ claims: [], diagram: { nodes: [], edges: [] } }));
      await updateWiki(store, await inputAt(repo, merge), { ...options, provider: p, journal });
      expect(flush).toHaveBeenCalledTimes(1);
      expect(store.getHead()).toBe(merge);
    });

    it("leaves the journal's rows when an update call fails", async () => {
      ({ repo, store, first } = await builtWiki());
      const { merge } = mergePaging();
      const { journal, flush } = spyJournal();
      const { provider: p } = provider(() => new LlmError("the batch expired"));
      await expect(
        updateWiki(store, await inputAt(repo, merge), { ...options, provider: p, journal }),
      ).rejects.toThrow(UpdateError);
      expect(flush).not.toHaveBeenCalled();
    });

    it("leaves the journal's rows when the drift call fails", async () => {
      ({ repo, store, first } = await builtWiki());
      const { merge } = mergePaging();
      const { journal, flush } = spyJournal();
      const { provider: p } = scriptedProvider((request) =>
        request.schema === ManifestOperations
          ? new LlmError("the batch was canceled")
          : new Error(`unexpected ${request.purpose} call`),
      );
      await expect(
        updateWiki(store, await inputAt(repo, merge), {
          ...options,
          driftThreshold: 0,
          provider: p,
          journal,
        }),
      ).rejects.toThrow(LlmError);
      expect(flush).not.toHaveBeenCalled();
      expect(store.getHead()).toBe(first);
    });

    it("does not move the drift baseline when the drift call's answers were refused", async () => {
      ({ repo, store, first } = await builtWiki());
      const { merge } = mergePaging();
      const { provider: p, requests } = scriptedProvider((request) => {
        if (request.schema === ManifestOperations) {
          // Retiring a feature that still owns files does not apply, twice.
          return {
            operations: [
              {
                kind: "retire",
                feature: "deliverables",
                title: "",
                aliases: [],
                clusters: [],
                into: "",
                targets: [],
              },
            ],
          };
        }
        return { claims: [], diagram: { nodes: [], edges: [] } };
      });
      const result = await updateWiki(store, await inputAt(repo, merge), {
        ...options,
        driftThreshold: 0,
        provider: p,
      });
      expect(requests.filter((r) => r.purpose === "manifest")).toHaveLength(2);
      expect(result).toMatchObject({ revised: false, drift: { revised: false } });
      expect(store.getManifest(merge)).not.toBeNull();
      expect(store.getDriftBaseline()?.sha).toBe(first);
    });

    it("places a disputed new file by the tie-break before it measures drift", async () => {
      ({ repo, store, first } = await builtWiki());
      // A root-level file no import, co-change or directory signal places: it is disputed.
      repo.write("notes.py", "def note():\n    return 1\n");
      const added = repo.commit("feat: add notes");
      const { provider: p, requests } = scriptedProvider((request) => {
        if (request.schema === TieBreakAnswer)
          return { files: [{ path: "notes.py", feature: "deliverables" }] };
        if (request.schema === ManifestOperations) return { operations: [] };
        return { claims: [], diagram: { nodes: [], edges: [] } };
      });
      const result = await updateWiki(store, await inputAt(repo, added), {
        ...options,
        driftThreshold: 0,
        provider: p,
      });
      const purposes = requests.map((r) => r.purpose);
      expect(purposes[0]).toBe("tieBreak");
      expect(purposes.indexOf("tieBreak")).toBeLessThan(purposes.indexOf("manifest"));
      expect(result.tieBreak.placed.get("notes.py")).toBe("deliverables");
      expect(store.getManifest(added)?.membership["notes.py"]?.featureId).toBe("deliverables");
    });
  });
});
