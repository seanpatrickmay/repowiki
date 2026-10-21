import { describe, expect, it } from "vitest";
import { isFrozen, jobCap, monthOf, PLANS, PLATFORM } from "./limits.ts";

describe("plan limits (Contract spec §10)", () => {
  it("are the owner's numbers", () => {
    expect(PLANS.free).toEqual({
      projects: 1,
      generationsLifetime: 1,
      generationsPerMonth: 1,
      refreshesPerMonth: 0,
      rebuildsBeforePublish: 1,
      maxIndexedFiles: 1000,
      monthlyUsdMicros: 1_000_000,
    });
    expect(PLANS.pro).toEqual({
      projects: 10,
      generationsLifetime: null,
      generationsPerMonth: 10,
      refreshesPerMonth: 30,
      rebuildsBeforePublish: 0,
      maxIndexedFiles: 3000,
      monthlyUsdMicros: 4_000_000,
    });
    expect(PLATFORM).toEqual({
      dailyUsdMicros: 25_000_000,
      freeAccountMinAgeDays: 30,
      jobMaxAttempts: 3,
      jobCapMultiplier: 1.5,
      liveCheckMaxAgeMs: 60_000,
      eligibilityMaxAgeMs: 3_600_000,
      repositoryGraceDays: 30,
    });
  });

  it("counts months in UTC, whatever offset a timestamp carries", () => {
    expect(monthOf("2026-10-14T12:00:00Z")).toBe("2026-10");
    expect(monthOf("2026-10-31T23:30:00-05:00")).toBe("2026-11");
    expect(monthOf("2026-11-01T00:30:00+01:00")).toBe("2026-10");
  });

  it("caps a job at 1.5 times its estimate, never past what the month has left", () => {
    expect(jobCap(1_000_000, 4_000_000)).toEqual({ ok: true, value: 1_500_000 });
    expect(jobCap(333_333, 4_000_000)).toEqual({ ok: true, value: 500_000 });
    expect(jobCap(3_000_000, 4_000_000)).toEqual({ ok: true, value: 4_000_000 });
    expect(jobCap(4_000_000, 4_000_000)).toEqual({ ok: true, value: 4_000_000 });
    expect(jobCap(0, 0)).toEqual({ ok: true, value: 0 });
  });

  it("refuses a job whose estimate is more than the month has left", () => {
    expect(jobCap(4_000_001, 4_000_000)).toEqual({ ok: false, code: "monthly-cost-ceiling" });
    expect(jobCap(1, -5)).toEqual({ ok: false, code: "monthly-cost-ceiling" });
  });

  it("freezes an account's projects only when it has more than its plan covers (C9)", () => {
    expect(isFrozen("free", 0)).toBe(false);
    expect(isFrozen("free", 1)).toBe(false);
    expect(isFrozen("free", 2)).toBe(true);
    expect(isFrozen("pro", 10)).toBe(false);
    expect(isFrozen("pro", 11)).toBe(true);
  });
});

it("keeps two concurrent jobs under the monthly ceiling when each reserves its cap (final review I6)", () => {
  const first = jobCap(2_000_000, PLANS.pro.monthlyUsdMicros);
  expect(first).toEqual({ ok: true, value: 3_000_000 });
  const reserved = first.ok ? first.value : 0;
  expect(jobCap(2_000_000, PLANS.pro.monthlyUsdMicros - reserved)).toEqual({
    ok: false,
    code: "monthly-cost-ceiling",
  });
});
