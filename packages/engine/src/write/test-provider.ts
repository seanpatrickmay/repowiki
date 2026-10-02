import type { GenerateRequest, Provider } from "@repowiki/llm";
import type { ClaimFixes, PageDraft } from "../verify/index.ts";

/** A page draft for testWiki()'s signals feature that verifies cleanly. Test-only. */
export function signalsDraft(): PageDraft {
  return {
    sections: [
      {
        key: "lead",
        claims: [
          {
            id: "l1",
            text: "**Signal ingestion** turns chunks into signals for [[deliverable records]].",
            cite: [],
            supports: ["o1", "h1"],
            hook: false,
          },
        ],
      },
      {
        key: "overview",
        claims: [
          {
            id: "o1",
            text: "`ingest_chunk()` keeps at most 50 signals, like a [[wp:Message queue]] would.",
            cite: ["src/signals/ingest.py:10-24"],
            supports: [],
            hook: true,
          },
        ],
      },
      {
        key: "history",
        claims: [
          {
            id: "h1",
            text: "Signal ingestion was added in January 2026.",
            cite: ["commit:a111111"],
            supports: [],
            hook: false,
          },
        ],
      },
      {
        key: "known-limitations",
        claims: [
          {
            id: "k1",
            text: "A TODO notes that long chunks are truncated.",
            cite: ["src/signals/ingest.py:18-21"],
            supports: [],
            hook: false,
          },
        ],
      },
    ],
    diagram: { nodes: ["n1", "n2"], edges: [{ from: "n1", to: "n2", label: "saves signals" }] },
  };
}

/** A page draft for testWiki()'s deliverables feature. Test-only. */
export function deliverablesDraft(): PageDraft {
  return {
    sections: [
      {
        key: "lead",
        claims: [
          {
            id: "l1",
            text: "**Deliverables** are tracked records.",
            cite: [],
            supports: ["o1"],
            hook: false,
          },
        ],
      },
      {
        key: "overview",
        claims: [
          {
            id: "o1",
            text: "`complete()` marks a deliverable done and ingests its notes as [[signals]].",
            cite: ["src/deliverables/crud.py:4-7"],
            supports: [],
            hook: false,
          },
        ],
      },
    ],
    diagram: { nodes: [], edges: [] },
  };
}

export type Answer = PageDraft | ClaimFixes | Error;

/**
 * Answers write calls from `answer(featureId, call)`, where call counts that feature's calls from
 * 1, and remembers every request with the event-loop turn it was made in. A turn is one pass of
 * the event loop (one setImmediate round), never a clock, so the turns are the same on every run.
 * Test-only.
 */
export function pageProvider(answer: (featureId: string, call: number) => Answer) {
  const requests: (GenerateRequest<unknown> & { turn: number })[] = [];
  let turn = 0;
  let ticking = false;
  const counts = new Map<string, number>();
  const provider: Provider = {
    async generate<T>(request: GenerateRequest<T>) {
      if (!ticking) {
        ticking = true;
        setImmediate(() => {
          turn += 1;
          ticking = false;
        });
      }
      requests.push({ ...(request as GenerateRequest<unknown>), turn });
      const featureId = request.featureId ?? "";
      const call = (counts.get(featureId) ?? 0) + 1;
      counts.set(featureId, call);
      // Answer a turn later, as a batch would, so a later round starts in a later turn.
      await new Promise((resolve) => setImmediate(resolve));
      const output = answer(featureId, call);
      if (output instanceof Error) throw output;
      const usage = { in: 100, out: 10, cacheRead: 0, cacheWrite: 0 };
      return { output: request.schema.parse(output), usage, model: "claude-haiku-4-5-20251001" };
    },
  };
  return { provider, requests };
}

/** A Wikipedia that knows "Message queue" only. Test-only. */
export const fakeWikipedia = async (input: string | URL | Request) => {
  const title = decodeURIComponent(new URL(String(input)).pathname.split("/").at(-1) ?? "");
  if (title !== "Message_queue") return new Response("{}", { status: 404 });
  const body = {
    type: "standard",
    title: "Message queue",
    titles: { normalized: "Message queue" },
    extract: "A message queue is a form of asynchronous communication.",
    content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Message_queue" } },
  };
  return new Response(JSON.stringify(body), { status: 200 });
};
