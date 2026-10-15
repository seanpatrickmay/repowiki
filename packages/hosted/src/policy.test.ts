import { describe, expect, it } from "vitest";
import { ACTIONS, type Action } from "./entities.ts";
import {
  authorize,
  type Caller,
  checkEligibility,
  type PolicyContext,
  type Usage,
} from "./policy.ts";
import { anAccount, aProject, eligibleFacts, ids, T0 } from "./test-fixtures.ts";

const NOW = "2026-10-14T12:00:30Z";
const free = anAccount();
const pro = anAccount({ plan: "pro" });
const usage = (patch: Partial<Usage> = {}): Usage => ({
  activeProjects: 0,
  generationsLifetime: 0,
  generationsThisMonth: 0,
  refreshesThisMonth: 0,
  monthUsdMicros: 0,
  platformDayUsdMicros: 0,
  ...patch,
});
const signedIn = (account = free): Caller => ({ kind: "account", account });
const ctx = (patch: Partial<PolicyContext> = {}): PolicyContext => ({
  now: NOW,
  caller: signedIn(),
  ownerId: ids.account,
  facts: eligibleFacts(),
  usage: usage({ activeProjects: 1 }),
  estimateUsdMicros: 400_000,
  ...patch,
});

describe("eligibility (Contract spec §7.2)", () => {
  it("accepts a fresh check of a public, unforked repository the user pushes and committed to", () => {
    expect(checkEligibility(eligibleFacts(), NOW, 60_000)).toEqual({
      ok: true,
      value: eligibleFacts(),
    });
    for (const permission of ["admin", "maintain", "push"] as const) {
      expect(checkEligibility(eligibleFacts({ permission }), NOW, 60_000).ok).toBe(true);
    }
  });

  it("refuses with the first failing condition, in the spec's order", () => {
    const all = eligibleFacts({
      tokenValid: false,
      visibility: "private",
      isFork: true,
      permission: "pull",
      authoredCommits: 0,
    });
    expect(checkEligibility(all, NOW, 60_000)).toMatchObject({ code: "github-token-revoked" });
    expect(checkEligibility({ ...all, tokenValid: true }, NOW, 60_000)).toMatchObject({
      code: "repo-private",
    });
    const pub = { ...all, tokenValid: true, visibility: "public" as const };
    expect(checkEligibility(pub, NOW, 60_000)).toMatchObject({ code: "repo-fork" });
    expect(checkEligibility({ ...pub, isFork: false }, NOW, 60_000)).toMatchObject({
      code: "repo-no-push",
    });
    for (const permission of ["triage", "pull", "none"] as const) {
      expect(checkEligibility(eligibleFacts({ permission }), NOW, 60_000)).toMatchObject({
        code: "repo-no-push",
      });
    }
    expect(checkEligibility(eligibleFacts({ authoredCommits: 0 }), NOW, 60_000)).toMatchObject({
      code: "repo-no-commits",
    });
  });

  it("refuses a missing or stale check", () => {
    expect(checkEligibility(null, NOW, 60_000)).toMatchObject({ code: "invalid-input" });
    expect(checkEligibility(eligibleFacts(), "2026-10-14T12:01:01Z", 60_000)).toMatchObject({
      code: "invalid-input",
      detail: "eligibility check is stale",
    });
  });
});

describe("who may do what (Contract spec §7.1)", () => {
  const OWNER_ACTIONS: Action[] = [
    "job.refresh",
    "job.read",
    "job.cancel",
    "job.retry",
    "draft.read",
    "preview.read",
    "draft.save",
    "draft.review",
    "project.publish",
    "project.unpublish",
    "project.export",
    "project.restore",
  ];

  it("lets an anonymous reader only read public pages", () => {
    for (const action of ACTIONS.filter((a) => a !== "public.read")) {
      const operatorOnly = action === "project.takedown" || action === "project.reinstate";
      const expected = operatorOnly ? "not-found" : "not-signed-in";
      expect(authorize(action, ctx({ caller: { kind: "anonymous" } })), action).toMatchObject({
        code: expected,
      });
    }
  });

  it("answers not-found for another account's resources", () => {
    for (const action of OWNER_ACTIONS) {
      expect(authorize(action, ctx({ ownerId: ids.other })), action).toEqual({
        ok: false,
        code: "not-found",
      });
    }
  });

  it("lets the system and the operator do only their own things", () => {
    for (const action of ACTIONS.filter((a) => a !== "public.read")) {
      expect(authorize(action, ctx({ caller: { kind: "system" } })), action).toMatchObject({
        code: "not-found",
      });
    }
    expect(authorize("project.takedown", ctx({ caller: { kind: "operator" } })).ok).toBe(true);
    expect(authorize("project.reinstate", ctx({ caller: { kind: "operator" } })).ok).toBe(true);
    expect(authorize("project.takedown", ctx())).toMatchObject({ code: "not-found" });
  });

  it("refuses everything but public reads for an account being deleted", () => {
    const deleting = signedIn(anAccount({ status: "deleting" }));
    for (const action of ["repos.list", "job.read", "project.export"] as const) {
      expect(authorize(action, ctx({ caller: deleting })), action).toMatchObject({
        code: "account-deleting",
      });
    }
  });

  it("always lets the owner read, cancel, unpublish and export, even when frozen", () => {
    const frozen = ctx({ usage: usage({ activeProjects: 2 }), facts: null });
    for (const action of ["job.read", "job.cancel", "draft.read", "preview.read"] as const) {
      expect(authorize(action, frozen), action).toEqual({ ok: true, value: true });
    }
    expect(authorize("project.unpublish", frozen).ok).toBe(true);
    expect(authorize("project.export", frozen).ok).toBe(true);
    expect(authorize("account.delete", frozen).ok).toBe(true);
    expect(authorize("repos.list", frozen).ok).toBe(true);
  });
});

describe("public pages (Contract spec §7.1, C10)", () => {
  const read = (patch: Partial<PolicyContext>) =>
    authorize(
      "public.read",
      ctx({ caller: { kind: "anonymous" }, ownerStatus: "active", ...patch }),
    );

  it("show a published project of an active account", () => {
    expect(read({ project: aProject({ state: "published", currentVersion: 1 }) }).ok).toBe(true);
  });

  it("answer 404 for a draft and 410 once withdrawn, purged or deleting", () => {
    expect(read({ project: aProject() })).toMatchObject({ code: "not-found" });
    const gone = aProject({ state: "withdrawn", withdrawReason: "author", withdrawnAt: T0 });
    expect(read({ project: gone })).toMatchObject({ code: "withdrawn" });
    expect(read({ project: { ...gone, state: "purged" } })).toMatchObject({ code: "withdrawn" });
    const live = aProject({ state: "published", currentVersion: 1 });
    expect(read({ project: live, ownerStatus: "deleting" })).toMatchObject({ code: "withdrawn" });
  });
});

describe("starting a generation (Contract spec §7.1, §10)", () => {
  const create = (patch: Partial<PolicyContext>) =>
    authorize("job.create", ctx({ usage: usage(), ...patch }));

  it("allows a first project on Free", () => {
    expect(create({})).toEqual({ ok: true, value: true });
  });

  it("refuses a stale check, ineligibility, a new GitHub account and a full plan", () => {
    expect(create({ now: "2026-10-14T12:01:01Z" })).toMatchObject({ code: "invalid-input" });
    expect(create({ facts: eligibleFacts({ isFork: true }) })).toMatchObject({ code: "repo-fork" });
    const young = signedIn(anAccount({ githubCreatedAt: "2026-09-20T00:00:00Z" }));
    expect(create({ caller: young })).toMatchObject({ code: "account-too-new" });
    expect(create({ caller: signedIn(anAccount({ plan: "pro", githubCreatedAt: T0 })) }).ok).toBe(
      true,
    );
    expect(create({ usage: usage({ activeProjects: 1 }) })).toMatchObject({
      code: "plan-project-limit",
    });
    expect(create({ usage: usage({ generationsLifetime: 1 }) })).toMatchObject({
      code: "plan-generation-limit",
    });
    const proMonth = usage({ activeProjects: 3, generationsThisMonth: 10 });
    expect(create({ caller: signedIn(pro), usage: proMonth })).toMatchObject({
      code: "plan-generation-limit",
    });
    expect(create({ caller: signedIn(pro), usage: usage({ generationsLifetime: 50 }) }).ok).toBe(
      true,
    );
  });

  it("refuses an oversized repository, a paused platform and a busted monthly ceiling", () => {
    expect(create({ facts: eligibleFacts({ indexedFiles: 1001 }) })).toMatchObject({
      code: "repo-too-large",
    });
    expect(create({ facts: eligibleFacts({ indexedFiles: null }) }).ok).toBe(true);
    expect(create({ caller: signedIn(pro), facts: eligibleFacts({ indexedFiles: 3000 }) }).ok).toBe(
      true,
    );
    expect(create({ usage: usage({ platformDayUsdMicros: 25_000_000 }) })).toMatchObject({
      code: "platform-paused",
    });
    const proPaused = usage({ platformDayUsdMicros: 25_000_000 });
    expect(create({ caller: signedIn(pro), usage: proPaused }).ok).toBe(true);
    expect(create({ estimateUsdMicros: 1_000_001 })).toMatchObject({
      code: "monthly-cost-ceiling",
    });
    const spent = usage({ monthUsdMicros: 3_800_000 });
    expect(
      create({ caller: signedIn(pro), usage: spent, estimateUsdMicros: 300_000 }),
    ).toMatchObject({
      code: "monthly-cost-ceiling",
    });
  });
});

describe("refreshing, editing, publishing and restoring (Contract spec §7.1, C7, C9)", () => {
  it("refreshes only on a plan with refreshes left", () => {
    expect(authorize("job.refresh", ctx())).toMatchObject({ code: "plan-refresh-limit" });
    expect(authorize("job.refresh", ctx({ caller: signedIn(pro) }))).toEqual({
      ok: true,
      value: true,
    });
    const used = usage({ activeProjects: 1, refreshesThisMonth: 30 });
    expect(authorize("job.refresh", ctx({ caller: signedIn(pro), usage: used }))).toMatchObject({
      code: "plan-refresh-limit",
    });
    const big = eligibleFacts({ indexedFiles: 3001 });
    expect(authorize("job.refresh", ctx({ caller: signedIn(pro), facts: big }))).toMatchObject({
      code: "repo-too-large",
    });
  });

  it("freezes refresh, save, review and publish when the plan is over its project count", () => {
    const over = ctx({ caller: signedIn(pro), usage: usage({ activeProjects: 11 }) });
    for (const action of [
      "job.refresh",
      "draft.save",
      "draft.review",
      "project.publish",
    ] as const) {
      expect(authorize(action, over), action).toMatchObject({ code: "frozen" });
    }
  });

  it("accepts an hour-old check for saving and reviewing but not for publishing", () => {
    const later = ctx({ now: "2026-10-14T12:59:00Z" });
    expect(authorize("draft.save", later).ok).toBe(true);
    expect(authorize("draft.review", later).ok).toBe(true);
    expect(authorize("project.publish", later)).toMatchObject({ code: "invalid-input" });
    expect(authorize("draft.save", ctx({ now: "2026-10-14T13:00:01Z" }))).toMatchObject({
      code: "invalid-input",
    });
    expect(
      authorize("draft.save", ctx({ facts: eligibleFacts({ permission: "pull" }) })),
    ).toMatchObject({
      code: "repo-no-push",
    });
  });

  it("refuses a republish or restore that would push the plan over its project count", () => {
    const withdrawn = aProject({ state: "withdrawn", withdrawReason: "author", withdrawnAt: T0 });
    expect(authorize("project.publish", ctx({ project: withdrawn }))).toMatchObject({
      code: "plan-project-limit",
    });
    expect(
      authorize("project.publish", ctx({ project: withdrawn, usage: usage({ activeProjects: 0 }) }))
        .ok,
    ).toBe(true);
    expect(authorize("project.publish", ctx({ project: aProject() })).ok).toBe(true);
    const unavailable = { ...withdrawn, withdrawReason: "repository" as const };
    expect(authorize("project.restore", ctx({ project: unavailable }))).toMatchObject({
      code: "plan-project-limit",
    });
    expect(
      authorize(
        "project.restore",
        ctx({ project: unavailable, usage: usage({ activeProjects: 0 }) }),
      ).ok,
    ).toBe(true);
  });
});
