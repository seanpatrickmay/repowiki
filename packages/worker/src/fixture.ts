import { setTimeout as sleep } from "node:timers/promises";
import { WikiExport } from "@repowiki/core";
import { Facts, type JobStep } from "@repowiki/hosted";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { leaseGone, type WorkerApi } from "./api.ts";
import { buildFacts, pageFeatureIds } from "./facts.ts";

/** The steps an engine run reports, in order (phase 1 and phase 2). */
const STEPS: readonly JobStep[] = [
  "fetch",
  "index",
  "manifest",
  "write",
  "people",
  "facts",
  "render",
];

/**
 * The demo's worker (spec 2 S18): no clone, no engine and no model. It walks the engine run's
 * steps and uploads the site package's fixture export with made-up but valid facts and
 * suggestions.
 */
export async function runFixture(
  api: WorkerApi,
  options: { stepMs?: number } = {},
): Promise<boolean> {
  try {
    return await walk(api, options.stepMs ?? 400);
  } catch (error) {
    // Failed as a job, never a crash; a refused token or a lost lease cannot report it.
    if (!leaseGone(error)) await api.fail("job-failed").catch(() => {});
    return false;
  }
}

async function walk(api: WorkerApi, stepMs: number): Promise<boolean> {
  await api.lease();
  const exp = WikiExport.parse(fixtureExport());
  const featureIds = pageFeatureIds(exp);
  const files = [
    { language: "python", loc: 420, skipped: null },
    { language: "typescript", loc: 180, skipped: null },
    { language: null, loc: 60, skipped: null },
  ];
  for (const step of STEPS) {
    await api.heartbeat(step);
    if (step === "index" && (await api.indexed(files.length)) === "too-large") return false;
    if (stepMs > 0) await sleep(stepMs);
  }
  const mine = featureIds.slice(0, 2);
  const facts = Facts.parse({
    ...buildFacts(files, exp),
    author: {
      commits: 14,
      totalCommits: 20,
      currentLines: 410,
      totalLines: 660,
      features: mine.map((featureId, i) => ({
        featureId,
        commits: 9 - i * 4,
        currentLines: 260 - i * 110,
      })),
    },
  });
  await api.putExport(new TextEncoder().encode(JSON.stringify(exp)));
  await api.succeed({
    suggestions: {
      tagline: "A small demo project RepoWiki documented",
      summary:
        "This demo stands in for a real repository. RepoWiki indexed it, grouped its code into features, and wrote a cited wiki page for each one.",
      contributionDraft:
        "The author wrote most of the ingest and search code and set up the project's tests.",
      highlightCandidates: mine,
    },
    facts,
    engineVersion: "fixture",
    models: ["fixture"],
  });
  return true;
}
