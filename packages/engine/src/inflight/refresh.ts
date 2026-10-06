import {
  type GitHubPull,
  type GitHubSnapshot,
  InFlight,
  type InFlightPull,
  type InFlightSummary,
  inflightProblems,
  type Manifest,
  type Revision,
} from "@repowiki/core";
import { callCostUsd, type Provider } from "@repowiki/llm";
import { DEFAULT_DRIFT_THRESHOLD } from "../freshness/index.ts";
import { DEFAULT_MAX_FILE_BYTES, readSources } from "../index/index.ts";
import type { Store } from "../store/index.ts";
import { type PullImpact, pullImpact } from "./effects.ts";
import { type HeadState, INFLIGHT_GIT, isMissingObject } from "./heads.ts";
import { featuresFromPaths, type ImpactContext } from "./impact.ts";
import { mapIssues, type Suggest } from "./issues.ts";
import { type SummaryRequest, summarize, summaryRequest } from "./summary.ts";
import { INFLIGHT_MAX_OUTPUT_TOKENS } from "./summary-pack.ts";

/** Output tokens a typical summary takes, for the estimate (spec v2 #9 §7.3). */
export const TYPICAL_SUMMARY_OUTPUT_TOKENS = 700;

/** What a refresh derives from: the store, inflight.git and the stored GitHub snapshot. */
export interface DeriveInput {
  store: Store;
  /** inflight.git (it may not exist: every head is then missing). */
  dir: string;
  snapshot: GitHubSnapshot;
  /** Each pull request's head as fetchHeads or headStates reported it. */
  heads: ReadonlyMap<number, HeadState>;
  /** The inflight role's model, for the request keys and the estimate. */
  model: string;
  /** Page search for issue mapping's `search` evidence (scripts build it, C3). */
  suggest?: Suggest;
  driftThreshold?: number;
  log?: (line: string) => void;
}

/** One pull request as derived, before its summary is settled. */
export interface DerivedPull {
  /** Its snapshot entry, with `summary: null`. */
  pull: InFlightPull;
  /** Its summary request; null when its head is not fetched or it keeps no file. */
  request: SummaryRequest | null;
  /** The cached summary for that request, or null. */
  cached: InFlightSummary | null;
  updatedAt: string;
}

export interface Derived {
  snapshot: GitHubSnapshot;
  wikiHead: string;
  manifest: Manifest;
  pages: Revision[];
  pulls: DerivedPull[];
  issues: InFlight["issues"];
  /** True when some git read hit a missing or corrupt object: inflight.git may need rebuilding. */
  corrupt: boolean;
}

/** The current pages of the manifest's active features. */
function activePages(store: Store, manifest: Manifest): Revision[] {
  const active = new Set(
    manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id),
  );
  return store.listCurrentRevisions().filter((page) => active.has(page.featureId));
}

/** A pull request whose head inflight.git lacks: GitHub's file list only (spec v2 #9 §5.1). */
function bare(pull: GitHubPull, head: HeadState, manifest: Manifest): Omit<InFlightPull, "closes"> {
  return {
    ...common(pull),
    head,
    mergeBase: null,
    merge: "unknown",
    files: [],
    filesTruncated: 0,
    features: featuresFromPaths(manifest, pull.files),
    effects: [],
    summary: null,
  };
}

function common(pull: GitHubPull) {
  return {
    number: pull.number,
    title: pull.title,
    author: pull.author,
    draft: pull.draft,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    baseRef: pull.baseRef,
    labels: pull.labels,
    headSha: pull.headRefOid,
  };
}

/** The summary request of a fetched pull request: the texts its diff needs, then the pack. */
async function requestOf(
  dir: string,
  pull: GitHubPull,
  impact: PullImpact,
  manifest: Manifest,
  model: string,
): Promise<SummaryRequest | null> {
  const kept = impact.changes.flatMap((c) => (c.newPath === null ? [] : [c.newPath]));
  if (kept.length === 0 && impact.changes.length === 0) return null;
  const old = new Set(impact.changes.flatMap((c) => (c.oldPath === null ? [] : [c.oldPath])));
  const read = (sha: string | null, only: Set<string>) =>
    sha === null || only.size === 0
      ? Promise.resolve(new Map<string, string>())
      : readSources(dir, sha, DEFAULT_MAX_FILE_BYTES, { ...INFLIGHT_GIT, only });
  const [base, head] = await Promise.all([
    read(impact.mergeBase, old),
    read(pull.headRefOid, new Set(kept)),
  ]);
  return summaryRequest(
    {
      pull,
      manifest,
      features: impact.features,
      changes: impact.changes,
      files: impact.files,
      base,
      head,
    },
    model,
  );
}

/**
 * Steps 5-6 of a refresh (spec v2 #9 §4.1) with no network and no LLM call: each fetched pull
 * request's impact against the store's head and current pages (pullImpact), each other one from
 * GitHub's file list, each fetched one's summary request and its cached answer, and the issues
 * mapped to features. A git failure on one pull request makes it `missing` with a log line; a
 * missing or corrupt object also sets `corrupt`, so an online run can rebuild inflight.git once.
 */
export async function deriveInFlight(input: DeriveInput): Promise<Derived> {
  const { store, snapshot } = input;
  const log = input.log ?? (() => {});
  const wikiHead = store.getHead();
  const manifest = store.getLatestManifest();
  if (wikiHead === null || manifest === null)
    throw new Error("the store has no wiki yet; run pnpm wiki:build first");
  const pages = activePages(store, manifest);
  const ctx: ImpactContext = {
    dir: input.dir,
    wikiHead,
    manifest,
    baseline: store.getDriftBaseline() ?? manifest,
    driftThreshold: input.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD,
  };
  const open = new Set(snapshot.issues.map((i) => i.number));
  let corrupt = false;
  const pulls: DerivedPull[] = [];
  for (const pull of snapshot.pulls) {
    const closes = pull.closes.filter((n) => open.has(n));
    const state = input.heads.get(pull.number) ?? "missing";
    let derived: DerivedPull = {
      pull: { ...bare(pull, state, manifest), closes },
      request: null,
      cached: null,
      updatedAt: pull.updatedAt,
    };
    if (state === "fetched") {
      try {
        const impact = await pullImpact(ctx, pull.headRefOid, pages);
        const request = await requestOf(input.dir, pull, impact, manifest, input.model);
        derived = {
          pull: {
            ...common(pull),
            closes,
            head: "fetched",
            mergeBase: impact.mergeBase,
            merge: impact.merge,
            files: impact.files,
            filesTruncated: impact.filesTruncated,
            features: impact.features,
            effects: impact.effects,
            summary: null,
          },
          request,
          cached: request === null ? null : store.getInFlightSummary(request.key),
          updatedAt: pull.updatedAt,
        };
      } catch (error) {
        if (isMissingObject(error)) corrupt = true;
        const why = error instanceof Error ? error.message : String(error);
        log(`#${pull.number}: impact not computed: ${why}`);
        derived = { ...derived, pull: { ...bare(pull, "missing", manifest), closes } };
      }
    }
    pulls.push(derived);
  }
  const issues = mapIssues(
    snapshot.issues,
    pulls.map((p) => p.pull),
    manifest,
    input.suggest,
  );
  return { snapshot, wikiHead, manifest, pages, pulls, issues, corrupt };
}

/** What the summary round would cost, stated before any call (spec v2 #9 §7.3). */
export interface SummaryEstimate {
  /** Pull requests with a summary request, and how many of those are cached. */
  requests: number;
  cached: number;
  /** The misses' cost assuming TYPICAL_SUMMARY_OUTPUT_TOKENS each, and at the 1,500-token cap. */
  typicalUsd: number;
  ceilingUsd: number;
}

/** A request's cost at `out` output tokens; null for a model with no price. */
function costOf(
  request: SummaryRequest,
  model: string,
  out: number,
  batch: boolean,
): number | null {
  return callCostUsd(model, { in: request.tokens, out, cacheRead: 0, cacheWrite: 0 }, batch);
}

/** The requests a run would send: those with no cached answer, newest activity first. */
export function misses(derived: Derived): SummaryRequest[] {
  return derived.pulls
    .filter((p) => p.request !== null && p.cached === null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((p) => p.request as SummaryRequest);
}

/** The estimate of the summary round; null when the model has no price (a usage error). */
export function estimateSummaries(
  derived: Derived,
  model: string,
  batch: boolean,
): SummaryEstimate | null {
  let typicalUsd = 0;
  let ceilingUsd = 0;
  for (const request of misses(derived)) {
    const typical = costOf(request, model, TYPICAL_SUMMARY_OUTPUT_TOKENS, batch);
    const ceiling = costOf(request, model, INFLIGHT_MAX_OUTPUT_TOKENS, batch);
    if (typical === null || ceiling === null) return null;
    typicalUsd += typical;
    ceilingUsd += ceiling;
  }
  const requests = derived.pulls.filter((p) => p.request !== null).length;
  return { requests, cached: requests - misses(derived).length, typicalUsd, ceilingUsd };
}

/**
 * The misses taken under `maxUsd` (C12): newest activity first, each counted at its ceiling,
 * while the next still fits; the rest are over budget this run and stay due.
 */
export function withinBudget(
  derived: Derived,
  model: string,
  batch: boolean,
  maxUsd: number,
): { chosen: SummaryRequest[]; over: SummaryRequest[] } {
  const chosen: SummaryRequest[] = [];
  const over: SummaryRequest[] = [];
  let spent = 0;
  for (const request of misses(derived)) {
    const ceiling =
      costOf(request, model, INFLIGHT_MAX_OUTPUT_TOKENS, batch) ?? Number.POSITIVE_INFINITY;
    if (over.length === 0 && spent + ceiling <= maxUsd) {
      chosen.push(request);
      spent += ceiling;
    } else over.push(request);
  }
  return { chosen, over };
}

/** How a pull request's summary was settled this run, for the CLI's table. */
export type SummaryStatus =
  | "cached"
  | "new"
  | "kept"
  | "over budget"
  | "failed"
  | "not asked"
  | "none";

export interface CompleteOptions {
  /** The provider for the chosen requests; null makes no call (offline, --no-llm, after update). */
  provider: Provider | null;
  model: string;
  batch: boolean;
  maxUsd: number;
  /** When GitHub was read (the stored snapshot's fetchedAt). */
  fetchedAt: string;
  /** The previous derived snapshot: a pull request whose head did not move keeps its summary. */
  previous: InFlight | null;
  now?: () => Date;
}

export interface Completed {
  inflight: InFlight;
  status: Map<number, SummaryStatus>;
  failures: Map<number, string>;
}

/**
 * Settles every summary and assembles the snapshot (spec v2 #9 §4.1 steps 7-8): a cached answer
 * is used as it is; the misses within `maxUsd` are asked in one round when there is a provider,
 * and each verified answer is cached; a pull request with no answer this run keeps the previous
 * snapshot's summary when its head is the same (its features filtered to those it still touches),
 * else has none. The summary cache keeps only the keys this snapshot uses. Validated against the
 * store's head, manifest and pages before it is returned; the caller stores it.
 */
export async function completeInFlight(
  store: Store,
  derived: Derived,
  options: CompleteOptions,
): Promise<Completed> {
  const now = options.now ?? (() => new Date());
  const status = new Map<number, SummaryStatus>();
  const failures = new Map<number, string>();
  const answers = new Map<number, InFlightSummary>();
  const { chosen, over } =
    options.provider === null
      ? { chosen: [], over: [] }
      : withinBudget(derived, options.model, options.batch, options.maxUsd);
  for (const request of over) status.set(request.number, "over budget");
  if (options.provider !== null && chosen.length > 0) {
    const outcomes = await summarize(chosen, derived.manifest, options.provider, {
      batch: options.batch,
      now,
    });
    for (const request of chosen) {
      const outcome = outcomes.get(request.number);
      if (outcome?.summary != null) {
        store.putInFlightSummary(request.key, outcome.summary, now().toISOString());
        answers.set(request.number, outcome.summary);
        status.set(request.number, "new");
      } else {
        status.set(request.number, "failed");
        failures.set(request.number, outcome?.summary === null ? outcome.failure : "no answer");
      }
    }
  }
  const before = new Map(options.previous?.pulls.map((p) => [p.number, p]) ?? []);
  const pulls = derived.pulls.map(({ pull, request, cached }) => {
    let summary = cached ?? answers.get(pull.number) ?? null;
    if (cached !== null) status.set(pull.number, "cached");
    const old = before.get(pull.number);
    if (
      summary === null &&
      pull.head === "fetched" &&
      old?.summary != null &&
      old.headSha === pull.headSha
    ) {
      const touched = new Set(pull.features.map((f) => f.featureId));
      summary = {
        ...old.summary,
        claims: old.summary.claims.map((c) => ({
          ...c,
          features: c.features.filter((f) => touched.has(f)),
        })),
      };
      if (!status.has(pull.number)) status.set(pull.number, "kept");
    }
    if (!status.has(pull.number)) status.set(pull.number, request === null ? "none" : "not asked");
    return { ...pull, summary };
  });
  store.pruneInFlightSummaries(
    derived.pulls.flatMap((p) => (p.request === null ? [] : [p.request.key])),
  );
  const inflight = InFlight.parse({
    repo: derived.snapshot.repo,
    fetchedAt: options.fetchedAt,
    derivedAt: now().toISOString(),
    wikiHead: derived.wikiHead,
    pulls,
    issues: derived.issues,
    omitted: derived.snapshot.omitted,
  });
  const problems = inflightProblems(inflight, {
    head: derived.wikiHead,
    manifest: derived.manifest,
    pages: store.listCurrentRevisions(),
  });
  if (problems.length > 0)
    throw new Error(`the derived snapshot disagrees with the wiki: ${problems[0]?.message}`);
  return { inflight, status, failures };
}
