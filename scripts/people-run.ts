import type { PeopleConfig } from "@repowiki/core";
import {
  type BuildJournal,
  estimateTokens,
  gitReadsAttributesAtSha,
  type PersonOutcome,
  type PersonRequest,
  type PreparedPeople,
  peopleSystemPrompt,
  personTurn,
  preparePeople,
  type Store,
  storeNarratives,
  WikiBuildError,
  wantsNarrative,
  writePeople,
} from "@repowiki/engine";
import type { ModelConfig, Provider } from "@repowiki/llm";
import {
  attributesNotes,
  exclusionNotes,
  narrativeCeilingUsd,
  type PeopleRow,
  withinBudget,
} from "./people-cli.ts";
import { cell, problemLine } from "./wiki-cli.ts";

export interface PeopleStepInput {
  repo: string;
  repoName: string;
  store: Store;
  config: PeopleConfig;
  /** The documented repository's configured user.email (planner ruling R3), or null. */
  ownerEmail: string | null;
  narrative: boolean;
  only: ReadonlySet<string> | null;
  rebuildBlame: boolean;
  models: ModelConfig;
  batch: boolean;
  /** The round's ceiling (R26): --max-usd, or --people-max-usd in wiki:update and wiki:replay. */
  maxUsd: number;
  /** True for --dry-run: the estimate and the table, no call. */
  dryRun: boolean;
  /** The round's provider and journal, built only when a narrative is sent. */
  connect: () => { provider: Provider; journal: BuildJournal };
  log: (line: string) => void;
}

export interface PeopleStep {
  prepared: PreparedPeople;
  /** The ceiling of the narratives the round sends (R26). */
  estimateUsd: number;
  taken: PersonRequest[];
  over: PersonRequest[];
  outcomes: PersonOutcome[];
  rows: PeopleRow[];
  notes: string[];
}

/**
 * The People step of wiki:people, wiki:update and wiki:replay (spec v2 #6 §9, §10): the refresh
 * at the store's head (no call), the due narratives' estimate printed before any call, the round
 * capped at `maxUsd` in rank order, the narratives stored with the journal flush, and each
 * person's summary row. The caller writes the export once, afterwards (C14). A WikiBuildError when
 * the store has no head or manifest.
 */
export async function runPeopleStep(input: PeopleStepInput): Promise<PeopleStep> {
  const { store, log } = input;
  const sha = store.getHead();
  const manifest = store.getLatestManifest();
  if (sha === null || manifest === null)
    throw new WikiBuildError("the wiki has no head or manifest; run pnpm wiki:build first");
  const prepared = await preparePeople({
    repo: input.repo,
    sha,
    store,
    config: input.config,
    ownerEmail: input.ownerEmail,
    rebuildBlame: input.rebuildBlame,
    manifest,
    narrative: input.narrative,
    only: input.only,
  });
  for (const warning of prepared.refreshed.warnings) log(problemLine(warning));
  const systemTokens = estimateTokens(peopleSystemPrompt(input.repoName, manifest));
  const ceiling = (r: PersonRequest) =>
    narrativeCeilingUsd(
      estimateTokens(personTurn(r.pack, r.append ? r.parent : null)),
      systemTokens,
      input.models.people,
      input.batch,
    );
  const { taken, over, usd } = withinBudget(prepared.requests, ceiling, input.maxUsd);
  log(
    `${prepared.requests.length} narratives due; ${taken.length} within the $${input.maxUsd.toFixed(2)} ceiling, estimated at most $${usd.toFixed(4)}${input.batch ? " (batched)" : ""}`,
  );
  let outcomes: PersonOutcome[] = [];
  if (!input.dryRun && taken.length > 0) {
    const { provider, journal } = input.connect();
    outcomes = await writePeople(
      { requests: taken, manifest, sha, commitDate: prepared.refreshed.snapshot.commitDate },
      { provider, repoName: input.repoName, batch: input.batch, log },
    );
    storeNarratives(store, outcomes, journal);
  }
  const step = { prepared, estimateUsd: usd, taken, over, outcomes };
  return { ...step, rows: peopleRows(step, input), notes: peopleNotes(prepared) };
}

/** Each person's summary row: what happened to their narrative this run. */
function peopleRows(
  step: Omit<PeopleStep, "rows" | "notes">,
  input: Pick<PeopleStepInput, "config" | "narrative" | "dryRun">,
): PeopleRow[] {
  const { refreshed, plan } = step.prepared;
  const outcome = new Map(step.outcomes.map((o) => [o.personId, o]));
  const taken = new Set(step.taken.map((r) => r.personId));
  const over = new Set(step.over.map((r) => r.personId));
  const due = new Map(plan.due.map((d) => [d.personId, d]));
  const groupOf = new Map(
    refreshed.assigned.ids.map((id, g) => [id, refreshed.identities.groups[g]]),
  );
  const status = (id: string, kind: "human" | "bot"): string => {
    if (kind === "bot") return "none (bot)";
    const o = outcome.get(id);
    if (o !== undefined)
      return o.revision === null
        ? `failed, computed lead kept: ${cell(o.failure ?? "")}`
        : o.revision.reason === "update"
          ? "appended"
          : "written";
    if (over.has(id)) return "over budget; due next run";
    const d = due.get(id);
    if (d !== undefined && !input.narrative) return "due; not written (--no-narrative)";
    if (d !== undefined && taken.has(id)) return `due (${d.reason})`;
    if (plan.carried.includes(id)) return "carried";
    if (plan.overCap.includes(id)) return `over the cap of ${input.config.maxNarratives}`;
    if (plan.skipped.includes(id)) return "skipped (--only)";
    const group = groupOf.get(id);
    if (group !== undefined && group.commits < input.config.minCommits)
      return `none (fewer than ${input.config.minCommits} commits)`;
    return group !== undefined && wantsNarrative(group, input.config)
      ? "none"
      : "none (no consent)";
  };
  return refreshed.snapshot.people.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    commits: p.commits,
    narrative: status(p.id, p.kind),
    dropped: outcome.get(p.id)?.dropped.length ?? 0,
  }));
}

/** The summary's notes: exclusion caveats and withdrawn narratives, naming no one. */
function peopleNotes(prepared: PreparedPeople): string[] {
  const { refreshed, revoked } = prepared;
  const excluded = refreshed.identities.groups.filter((g) => g.excluded).length;
  const contributing = refreshed.identities.groups.filter(
    (g) => g.excluded && g.commits > 0,
  ).length;
  const notes = [
    ...exclusionNotes(excluded, refreshed.snapshot.others.length > 0, contributing),
    ...attributesNotes(gitReadsAttributesAtSha()),
  ];
  if (revoked > 0)
    notes.push(
      `${revoked} narrative ${revoked === 1 ? "revision was" : "revisions were"} deleted: consent withdrawn in the people file.`,
    );
  return notes;
}
