import { parseMemberId } from "@repowiki/core";
import { INGEST_PY } from "@repowiki/core/test-fixtures";
import { type GenerateRequest, LlmError, LlmOutputError, type Provider } from "@repowiki/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFileGraph, clusterFiles } from "../cluster/index.ts";
import type { TestRepo } from "../index/index.ts";
import { buildExport, type Store } from "../store/index.ts";
import { ArchitectureDraft, PageDraft, UpdateDraft, UpdateFixes } from "../verify/index.ts";
import { type BuildJournal, buildJournal } from "../write/index.ts";
import { type ManifestOperation, ManifestOperations } from "./ops.ts";
import { UpdateError } from "./plan.ts";
import { scriptedProvider } from "./test-provider.ts";
import { articleAnswer, builtWiki, inputAt } from "./test-wiki-repo.ts";
import { TieBreakAnswer } from "./tiebreak.ts";
import { UpdateArticleError, updateWiki } from "./update.ts";

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
    if (request.schema === ArchitectureDraft) return articleAnswer();
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

    // The signals lead changed, so the project's article is rewritten in a round of its own.
    expect(requests.map((r) => [r.purpose, r.featureId ?? null])).toEqual([
      ["write", "signals"],
      ["write", null],
    ]);
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
    expect(result.articleDue).toBe("a lead changed");
    expect(result.architecture?.failure).toBeNull();
    expect(store.getCurrentArchitecture()).toMatchObject({
      sha: merge,
      reason: "update",
      pr: 7,
      parentId: `architecture-${first.slice(0, 12)}-1`,
      basis: [`deliverables-${first.slice(0, 12)}`, signals?.id].sort(),
    });
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
    expect(result).toMatchObject({
      stored: [],
      carried: ["deliverables", "signals"],
      pr: null,
      architectureSkipped: "current",
    });
    expect(store.getHead()).toBe(empty);
  });

  it("records why a rewrite that stored nothing was refused, and still carries its page", async () => {
    ({ repo, store, first } = await builtWiki());
    // A new file the page does not cite: the page is rewritten, and the model has nothing to add.
    repo.write("src/signals/batch.py", "def drain(queue):\n    return list(queue)\n");
    const added = repo.commit("feat: drain signals");
    const { provider: p } = provider(() => ({ claims: [], diagram: { nodes: [], edges: [] } }));
    const result = await updateWiki(store, await inputAt(repo, added), { ...options, provider: p });
    expect(result.stored).toEqual([]);
    expect(result.carried).toEqual(["deliverables", "signals"]);
    expect(result.refused).toEqual([{ featureId: "signals", why: "nothing changed" }]);
    expect(result.architectureSkipped).toBe("current");
  });

  it("keeps the stored update when its article cannot be stored, and hands it over with the error", async () => {
    ({ repo, store, first } = await builtWiki());
    const { merge } = mergePaging();
    const { provider: p } = provider(() => ({
      claims: [claim("c1", "lead", "**Signal ingestion** turns chunks into signals.", [], ["c2"])],
      diagram: { nodes: [], edges: [] },
    }));
    const failing: Store = {
      ...store,
      putArchitecture: () => {
        throw new Error("disk I/O error");
      },
    };
    const error = await updateWiki(failing, await inputAt(repo, merge), {
      ...options,
      provider: p,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UpdateArticleError);
    expect((error as UpdateArticleError).message).toBe(
      `the update to ${merge} is stored, but its About article could not be: disk I/O error`,
    );
    const { update } = error as UpdateArticleError;
    expect(update.to).toBe(merge);
    expect(update.stored.map((r) => r.featureId)).toEqual(["signals"]);
    expect(update.architecture).toBeNull();
    expect(store.getHead()).toBe(merge);
    expect(store.getCurrentRevision("signals")?.sha).toBe(merge);
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

  describe("whole pages and failures", () => {
    const diagram = { nodes: [], edges: [] };
    /** A whole page for a feature whose one body claim cites `cite`. */
    const wholePage = (title: string, text: string, cite: string): PageDraft => ({
      sections: [
        {
          key: "lead",
          claims: [
            {
              id: "l1",
              text: `**${title}** is a feature.`,
              cite: [],
              supports: ["o1"],
              hook: false,
            },
          ],
        },
        { key: "overview", claims: [{ id: "o1", text, cite: [cite], supports: [], hook: false }] },
      ],
      diagram,
    });
    const storagePage = () =>
      wholePage(
        "Signal storage",
        "`save_signal()` returns its signal.",
        "src/signals/store.py:1-2",
      );
    const unusable = () => new LlmOutputError("model output is not JSON", "nope");

    /**
     * Answers by schema and records the event-loop turn of each request (one setImmediate round,
     * as in the write tests), so requests of one turn are one batch. With a journal it also does
     * what the batcher does: records a row per request, tagged with its page, and forgets the row
     * when the answer was read (an unusable answer was read; a failed call was not).
     */
    function turned(
      answer: (request: GenerateRequest<unknown>) => unknown,
      journal?: BuildJournal,
    ) {
      const requests: (GenerateRequest<unknown> & { turn: number })[] = [];
      const keys: string[] = [];
      let turn = 0;
      let ticking = false;
      const provider: Provider = {
        async generate<T>(request: GenerateRequest<T>) {
          if (!ticking) {
            ticking = true;
            setImmediate(() => {
              turn += 1;
              ticking = false;
            });
          }
          const at = turn;
          requests.push({ ...(request as GenerateRequest<unknown>), turn: at });
          const key = `request-${requests.length}`;
          keys.push(key);
          journal?.record(`batch-${at}`, new Date().toISOString(), [
            { requestKey: key, customId: key },
          ]);
          journal?.tag(key, request.featureId ?? null);
          await new Promise((resolve) => setImmediate(resolve));
          const output = answer(request as GenerateRequest<unknown>);
          if (output instanceof Error) {
            if (output instanceof LlmOutputError) journal?.forget(`batch-${at}`, [key]);
            throw output;
          }
          journal?.forget(`batch-${at}`, [key]);
          const usage = { in: 100, out: 10, cacheRead: 0, cacheWrite: 0 };
          return { output: request.schema.parse(output), usage, model: "claude-haiku-4-5" };
        },
      };
      return { provider, requests, keys };
    }
    const standard = (request: GenerateRequest<unknown>, page?: () => unknown): unknown => {
      if (request.schema === TieBreakAnswer) return { files: [] };
      if (request.schema === ManifestOperations) return { operations: [] };
      if (request.schema === ArchitectureDraft) return articleAnswer();
      if (request.schema === UpdateFixes) return { claims: [] };
      if (request.schema === UpdateDraft) return { claims: [], diagram };
      if (request.schema === PageDraft && page !== undefined) return page();
      throw new Error(`unexpected ${request.purpose} call for ${request.featureId}`);
    };

    /** The wiki, moved on to an empty commit whose manifest gives storage.py to a new feature. */
    async function withStorage(): Promise<void> {
      ({ repo, store, first } = await builtWiki());
      const base = store.getManifest(first);
      if (base === null) throw new Error("no manifest");
      const later = repo.commit("chore: nothing");
      store.putManifest(
        {
          ...base,
          sha: later,
          features: [
            ...base.features,
            {
              id: "storage",
              title: "Signal storage",
              aliases: ["signal store"],
              status: { kind: "active" },
              lineage: [{ kind: "create", sha: later }],
            },
          ],
          membership: Object.fromEntries(
            Object.entries(base.membership).map(([id, m]) => [
              id,
              parseMemberId(id)?.path === "src/signals/store.py"
                ? { ...m, featureId: "storage" }
                : m,
            ]),
          ),
        },
        { llmRevised: true },
      );
      store.setHead(later);
    }

    it("writes an active feature with no page whole, as a build, in the update's batch", async () => {
      await withStorage();
      const { merge } = mergePaging();
      const { provider: p, requests } = turned((r) => standard(r, storagePage));
      const result = await updateWiki(store, await inputAt(repo, merge), {
        ...options,
        provider: p,
      });
      const storage = result.stored.find((r) => r.featureId === "storage");
      expect(storage).toMatchObject({ reason: "build", parentId: null, pr: 7, sha: merge });
      expect(store.getCurrentRevision("storage")?.id).toBe(storage?.id);
      expect(result.failures).toEqual([]);
      // The whole page's call and the update call of signals (round 1) are one batch (one turn).
      const writes = requests.filter((r) => r.schema === PageDraft || r.schema === UpdateDraft);
      expect(
        writes.map((r) => [r.featureId, r.schema === PageDraft ? "page" : "update"]).sort(),
      ).toEqual([
        ["signals", "update"],
        ["storage", "page"],
      ]);
      expect(new Set(writes.map((r) => r.turn)).size).toBe(1);
    });

    it("writes a feature the operations changed whole, as a manifest change with its parent", async () => {
      ({ repo, store, first } = await builtWiki());
      const { merge } = mergePaging();
      const parent = store.getCurrentRevision("deliverables");
      const { provider: p } = turned((request) =>
        request.schema === ManifestOperations
          ? {
              operations: [
                {
                  kind: "rename",
                  feature: "deliverables",
                  title: "Work records",
                  aliases: [],
                  clusters: [],
                  into: "",
                  targets: [],
                },
              ],
            }
          : standard(request, () =>
              wholePage(
                "Work records",
                "`complete()` marks a deliverable done.",
                "src/deliverables/crud.py:4-7",
              ),
            ),
      );
      const result = await updateWiki(store, await inputAt(repo, merge), {
        ...options,
        driftThreshold: 0,
        provider: p,
      });
      const page = result.stored.find((r) => r.featureId === "deliverables");
      expect(page).toMatchObject({
        reason: "manifest-change",
        parentId: parent?.id,
        pr: 7,
        sha: merge,
      });
      expect(store.getCurrentRevision("deliverables")?.id).toBe(page?.id);
    });

    describe("keeps the History of the pages a whole write continues (spec §5 rule 4)", () => {
      /** wholePage with History claims, each citing the commits it names. */
      const withHistory = (page: PageDraft, ...history: [string, string[]][]): PageDraft => ({
        ...page,
        sections: [
          ...page.sections,
          {
            key: "history",
            claims: history.map(([text, shas], i) => ({
              id: `h${i + 1}`,
              text,
              cite: shas.map((sha) => `commit:${sha.slice(0, 7)}`),
              supports: [],
              hook: false,
            })),
          },
        ],
      });
      const op = (o: Partial<ManifestOperation> & Pick<ManifestOperation, "kind" | "feature">) => ({
        title: "",
        aliases: [],
        clusters: [],
        into: "",
        targets: [],
        ...o,
      });
      /** The History section of a stored page: each claim's text and the commits it cites. */
      const historyOf = (featureId: string) =>
        store
          .getCurrentRevision(featureId)
          ?.sections.find((s) => s.key === "history")
          ?.claims.map((c) => [
            c.text,
            c.citations.flatMap((x) => (x.kind === "commit" ? [x.sha] : [])),
          ]);
      const clusterOptions = { resolution: 5, minClusterSize: 1 };
      /** Runs the update to `to` with the drift call answering `operations`. */
      async function updateWith(
        to: string,
        operations: unknown[],
        page: (featureId: string) => PageDraft,
      ) {
        const { provider: p } = turned((request) =>
          request.schema === ManifestOperations
            ? { operations }
            : request.schema === PageDraft
              ? page(request.featureId ?? "")
              : standard(request),
        );
        return updateWiki(store, await inputAt(repo, to), {
          ...options,
          driftThreshold: 0,
          clusterOptions,
          provider: p,
        });
      }

      it("carries every History claim of a renamed page ahead of the new ones", async () => {
        ({ repo, store, first } = await builtWiki());
        const { branch, merge } = mergePaging();
        const result = await updateWith(
          merge,
          [op({ kind: "rename", feature: "deliverables", title: "Work records" })],
          () =>
            withHistory(
              wholePage(
                "Work records",
                "`complete()` marks a deliverable done.",
                "src/deliverables/crud.py:4-7",
              ),
              ["Paging arrived in PR 7.", [branch]],
            ),
        );
        expect(result.stored.find((r) => r.featureId === "deliverables")?.reason).toBe(
          "manifest-change",
        );
        expect(historyOf("deliverables")).toEqual([
          ["Deliverables was added first.", [first]],
          ["Paging arrived in PR 7.", [branch]],
        ]);
      });

      it("carries the History of both pages an operation that moves files writes whole", async () => {
        ({ repo, store, first } = await builtWiki());
        const { merge } = mergePaging();
        const index = (await inputAt(repo, merge)).index;
        const storeCluster = clusterFiles(buildFileGraph(index), clusterOptions).find((c) =>
          c.files.includes("src/signals/store.py"),
        );
        expect(storeCluster?.files).toEqual(["src/signals/store.py"]);
        const result = await updateWith(
          merge,
          [op({ kind: "move", feature: "deliverables", clusters: [storeCluster?.id ?? ""] })],
          (featureId) =>
            featureId === "signals"
              ? wholePage(
                  "Signal ingestion",
                  "`ingest_chunk()` skips blank sentences.",
                  "src/signals/ingest.py:10-24",
                )
              : wholePage(
                  "Deliverables",
                  "`save_signal()` returns its signal.",
                  "src/signals/store.py:1-2",
                ),
        );
        expect(result.drift?.affected).toEqual(["deliverables", "signals"]);
        expect(historyOf("signals")).toEqual([["Signal ingestion was added first.", [first]]]);
        expect(historyOf("deliverables")).toEqual([["Deliverables was added first.", [first]]]);
      });

      it("carries the History of every page a merge folds into its target", async () => {
        ({ repo, store, first } = await builtWiki());
        const { merge } = mergePaging();
        await updateWith(
          merge,
          [op({ kind: "merge", feature: "deliverables", into: "signals" })],
          () =>
            wholePage(
              "Signal ingestion",
              "`complete()` marks a deliverable done.",
              "src/deliverables/crud.py:4-7",
            ),
        );
        expect(store.getCurrentRevision("signals")?.reason).toBe("manifest-change");
        expect(historyOf("signals")).toEqual([
          ["Signal ingestion was added first.", [first]],
          ["Deliverables was added first.", [first]],
        ]);
      });

      it("drops a new History claim that cites exactly the commits a carried one cites", async () => {
        ({ repo, store, first } = await builtWiki());
        const { branch, merge } = mergePaging();
        await updateWith(
          merge,
          [op({ kind: "rename", feature: "deliverables", title: "Work records" })],
          () =>
            withHistory(
              wholePage(
                "Work records",
                "`complete()` marks a deliverable done.",
                "src/deliverables/crud.py:4-7",
              ),
              ["Work records began with the first commit.", [first]],
              ["Both commits shaped it.", [first, branch]],
            ),
        );
        expect(historyOf("deliverables")).toEqual([
          ["Deliverables was added first.", [first]],
          ["Both commits shaped it.", [first, branch]],
        ]);
      });

      it("writes a page whose manifest-change write failed whole again on the next update", async () => {
        ({ repo, store, first } = await builtWiki());
        const { merge } = mergePaging();
        const parent = store.getCurrentRevision("deliverables");
        const failed = await updateWith(
          merge,
          [op({ kind: "rename", feature: "deliverables", title: "Work records" })],
          () => {
            throw unusable();
          },
        );
        expect(failed.failures.map((f) => f.featureId)).toEqual(["deliverables"]);
        expect(store.getCurrentRevision("deliverables")?.id).toBe(parent?.id);

        // The next update changes nothing of deliverables, and no feature drifts: the page is
        // still written whole, as the manifest change it is, with its History carried.
        const later = repo.commit("chore: nothing");
        const work = () =>
          wholePage(
            "Work records",
            "`complete()` marks a deliverable done.",
            "src/deliverables/crud.py:4-7",
          );
        const { provider: p, requests } = turned((request) => standard(request, work));
        const retried = await updateWiki(store, await inputAt(repo, later), {
          ...options,
          provider: p,
        });
        expect(requests.filter((r) => r.schema === PageDraft).map((r) => r.featureId)).toEqual([
          "deliverables",
        ]);
        expect(retried.stored.find((r) => r.featureId === "deliverables")).toMatchObject({
          reason: "manifest-change",
          parentId: parent?.id,
        });
        expect(historyOf("deliverables")).toEqual([["Deliverables was added first.", [first]]]);

        // Written now, it is planned like any page again: an empty commit makes no call.
        const last = repo.commit("chore: nothing again");
        const { provider: none, requests: after } = turned(() => new Error("no call expected"));
        await updateWiki(store, await inputAt(repo, last), { ...options, provider: none });
        expect(after).toEqual([]);
      });
    });

    it("does not store a whole page that got two unusable answers, and settles its rows", async () => {
      await withStorage();
      const { merge } = mergePaging();
      const journal = buildJournal(store);
      const {
        provider: p,
        requests,
        keys,
      } = turned(
        (request) => (request.schema === PageDraft ? unusable() : standard(request)),
        journal,
      );
      const result = await updateWiki(store, await inputAt(repo, merge), {
        ...options,
        provider: p,
        journal,
      });
      // The page was asked for twice, and the update still moved on with the rest.
      expect(requests.filter((r) => r.schema === PageDraft)).toHaveLength(2);
      expect(store.getHead()).toBe(merge);
      expect(store.getCurrentRevision("storage")).toBeNull();
      expect(result.stored.map((r) => r.featureId)).not.toContain("storage");
      expect(result.failures).toEqual([
        { featureId: "storage", failure: expect.stringContaining("failed twice") },
      ]);
      // Its rows are forgotten with the update, so nothing replays the same unusable answers.
      expect(keys.map((k) => store.findBatchRequest(k))).toEqual(keys.map(() => null));
      // The wiki is at the target now: a rerun there makes no call at all.
      const before = requests.length;
      await expect(
        updateWiki(store, await inputAt(repo, merge), { ...options, provider: p, journal }),
      ).rejects.toThrow(`the wiki is already at ${merge}`);
      expect(requests).toHaveLength(before);
    });

    it("does not stop for an update call that got unusable answers", async () => {
      ({ repo, store, first } = await builtWiki());
      const { merge } = mergePaging();
      const { provider: p } = turned((request) =>
        request.schema === UpdateDraft || request.schema === UpdateFixes
          ? unusable()
          : standard(request),
      );
      const result = await updateWiki(store, await inputAt(repo, merge), {
        ...options,
        provider: p,
      });
      expect(store.getHead()).toBe(merge);
      expect(result.rewrites[0]?.keptStale).toEqual(["c1", "c2"]);
    });

    it("stops, and leaves the rows, when a whole page's call fails", async () => {
      await withStorage();
      const { merge } = mergePaging();
      const journal = buildJournal(store);
      const { provider: p, keys } = turned(
        (request) =>
          request.schema === PageDraft ? new LlmError("the batch expired") : standard(request),
        journal,
      );
      await expect(
        updateWiki(store, await inputAt(repo, merge), { ...options, provider: p, journal }),
      ).rejects.toThrow(UpdateError);
      expect(store.getHead()).not.toBe(merge);
      expect(keys.map((k) => store.findBatchRequest(k) !== null)).toContain(true);
      expect(store.getManifest(merge)).toBeNull();
    });

    it("stops with nothing stored and no flush when the tie-break call fails", async () => {
      ({ repo, store, first } = await builtWiki());
      repo.write("notes.py", "def note():\n    return 1\n");
      const added = repo.commit("feat: add notes");
      const { journal, flush } = spyJournal();
      const { provider: p } = turned((request) =>
        request.schema === TieBreakAnswer
          ? new LlmError("the batch was canceled")
          : standard(request),
      );
      await expect(
        updateWiki(store, await inputAt(repo, added), { ...options, provider: p, journal }),
      ).rejects.toThrow(LlmError);
      expect(flush).not.toHaveBeenCalled();
      expect(store.getHead()).toBe(first);
      expect(store.getManifest(added)).toBeNull();
    });
  });
});
