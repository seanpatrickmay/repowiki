import type {
  GitHubPull,
  GitHubSnapshot,
  InFlight,
  InFlightPull,
  InFlightSummary,
  Manifest,
  Revision,
} from "@repowiki/core";
import { DEFAULT_DRIFT_THRESHOLD } from "../freshness/index.ts";
import { DEFAULT_MAX_FILE_BYTES, readSources } from "../index/index.ts";
import type { Store } from "../store/index.ts";
import { type PullImpact, pullImpact } from "./effects.ts";
import { type HeadState, INFLIGHT_GIT, isMissingObject } from "./heads.ts";
import { featuresFromPaths, type ImpactContext } from "./impact.ts";
import { mapIssues, type Suggest } from "./issues.ts";
import { type SummaryRequest, summaryRequest } from "./summary.ts";

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
