import { type BuildJournal, buildJournal } from "@repowiki/engine";
import { createLedger, type Provider, totalsOf } from "@repowiki/llm";
import type { HookContext } from "./inflight-hook.ts";
import {
  loadPeopleFile,
  ownerEmailOf,
  peopleFilePath,
  WIKI_PEOPLE_RUN_PREFIX,
} from "./people-cli.ts";
import { runPeopleStep } from "./people-run.ts";
import { lazyClaudeProvider, problemLine } from "./wiki-cli.ts";

export interface PeopleHookContext extends HookContext {
  command: "wiki:update" | "wiki:replay";
  batch: boolean;
  /** --people-max-usd (R26). */
  maxUsd: number;
  /** The out dir's build lock the update holds, or null for a test's in-memory store. */
  lock: string | null;
  /** A test seam: the round's provider and journal instead of Claude's. */
  connect?: () => { provider: Provider; journal: BuildJournal };
}

/**
 * The People step after wiki:update, or once at the end of wiki:replay (spec v2 #6 §9, R24): on a
 * wiki with People on, the refresh at the new head with no call, then the due narratives in one
 * round under --people-max-usd. With no API key the narratives stay due and the step says so
 * (planner ruling R22): the facts never wait on a key. Returns the update summary's "People"
 * section; empty when People is off. Any failure is a warning line, never a failed update. The
 * caller writes the export, once, afterwards (C14).
 */
export async function peopleAfterUpdate(ctx: PeopleHookContext): Promise<string[]> {
  const { store, log } = ctx;
  if (store.getPeopleSnapshot() === null) return [];
  try {
    const sha = store.getHead() ?? "";
    const runId = `${WIKI_PEOPLE_RUN_PREFIX}${sha}-${new Date().toISOString()}`;
    const ledger = createLedger((entry) => store.appendLedger(entry));
    const keyless = ctx.connect === undefined && !process.env.ANTHROPIC_API_KEY;
    const step = await runPeopleStep({
      repo: ctx.repo,
      repoName: ctx.repoName,
      store,
      config: loadPeopleFile(peopleFilePath(ctx.repo, ctx.out, null)),
      ownerEmail: ownerEmailOf(ctx.repo, log),
      lock: ctx.lock,
      narrative: true,
      only: null,
      rebuildBlame: false,
      models: ctx.models,
      batch: ctx.batch,
      maxUsd: ctx.maxUsd,
      // Without a key nothing is sent: the due narratives are listed, and stay due.
      dryRun: keyless,
      connect:
        ctx.connect ??
        (() => {
          const journal = buildJournal(store);
          const provider = lazyClaudeProvider({
            command: ctx.command,
            models: ctx.models,
            ledger,
            runId,
            run: { kind: "people", sha },
            journal,
            deadlineMinutes: null,
            log,
          });
          return { provider, journal };
        }),
      log,
    });
    const tally = (pick: (narrative: string) => boolean) =>
      step.rows.filter((r) => pick(r.narrative)).length;
    const totals = totalsOf(store.listLedger(runId));
    const unsent = keyless ? step.taken.length : 0;
    return [
      "## People",
      "",
      `Refreshed at ${sha.slice(0, 7)} with no call: ${step.rows.length} people.`,
      "",
      `Narratives: ${tally((n) => n === "written")} written, ${tally((n) => n === "appended")} appended, ${tally((n) => n === "carried")} carried, ${tally((n) => n.startsWith("failed"))} failed, ${step.over.length} over the $${ctx.maxUsd.toFixed(2)} ceiling${unsent === 0 ? "" : `, ${unsent} not written (ANTHROPIC_API_KEY is not set; they stay due)`}.`,
      "",
      `People cost: ${totals.calls} calls, $${totals.usd.toFixed(4)}.`,
      "",
      ...step.notes.flatMap((n) => [n, ""]),
    ];
  } catch (err) {
    const why = problemLine(err instanceof Error ? err.message : String(err));
    log(`warning: People not refreshed: ${why}`);
    return ["## People", "", `Not refreshed: ${why}`, ""];
  }
}
