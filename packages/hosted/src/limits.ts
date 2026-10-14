import { z } from "zod";
import { ok, type Result, refused } from "./result.ts";

export const Plan = z.enum(["free", "pro"]);
export type Plan = z.infer<typeof Plan>;

export interface PlanLimits {
  /** Active (draft or published) projects the plan covers; more than this freezes them (C9). */
  projects: number;
  /** Generations an account may ever run, or null when only the monthly limit applies. */
  generationsLifetime: number | null;
  generationsPerMonth: number;
  refreshesPerMonth: number;
  maxIndexedFiles: number;
  /** The hard monthly model-cost ceiling. */
  monthlyUsdMicros: number;
}

/** Contract spec §10, from the owner's D3. */
export const PLANS: Readonly<Record<Plan, PlanLimits>> = {
  free: {
    projects: 1,
    generationsLifetime: 1,
    generationsPerMonth: 1,
    refreshesPerMonth: 0,
    maxIndexedFiles: 1000,
    monthlyUsdMicros: 1_000_000,
  },
  pro: {
    projects: 10,
    generationsLifetime: null,
    generationsPerMonth: 10,
    refreshesPerMonth: 30,
    maxIndexedFiles: 3000,
    monthlyUsdMicros: 4_000_000,
  },
};

export const PLATFORM = {
  /** Platform-wide model spend per UTC day past which new Free jobs pause. */
  dailyUsdMicros: 25_000_000,
  freeAccountMinAgeDays: 30,
  jobMaxAttempts: 3,
  jobCapMultiplier: 1.5,
  /** How old an eligibility check may be for an action that spends money or publishes (C7). */
  liveCheckMaxAgeMs: 60_000,
  /** How old it may be for an action that changes only private state (C7). */
  eligibilityMaxAgeMs: 3_600_000,
  repositoryGraceDays: 30,
} as const;

export const DAY_MS = 86_400_000;

/** The UTC calendar month of a timestamp, as "YYYY-MM": the period plan quotas count in. */
export function monthOf(at: string): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** A job's cost cap: its estimate times the multiplier, never past what the month has left. */
export function jobCap(estimateUsdMicros: number, remainingUsdMicros: number): Result<number> {
  if (estimateUsdMicros > remainingUsdMicros) return refused("monthly-cost-ceiling");
  const cap = Math.ceil(estimateUsdMicros * PLATFORM.jobCapMultiplier);
  return ok(Math.min(cap, remainingUsdMicros));
}

/** C9: an account with more active projects than its plan covers has every project frozen. */
export function isFrozen(plan: Plan, activeProjects: number): boolean {
  return activeProjects > PLANS[plan].projects;
}
