import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  Account,
  AuditEvent,
  DraftRevision,
  EligibilityFacts,
  Generation,
  Handle,
  Job,
  LedgerEntry,
  Preview,
  Project,
  PublishedVersion,
  Repository,
  Review,
} from "./entities.ts";
import {
  aGeneration,
  aJob,
  anAccount,
  aPreview,
  aProject,
  aPublishedVersion,
  aReview,
  aRevision,
  eligibleFacts,
  ids,
  T0,
} from "./test-fixtures.ts";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("entities (Contract spec §5)", () => {
  it("accept one valid example of each", () => {
    expect(ok(Account, anAccount())).toBe(true);
    expect(ok(Project, aProject())).toBe(true);
    expect(ok(Job, aJob())).toBe(true);
    expect(ok(Generation, aGeneration())).toBe(true);
    expect(ok(DraftRevision, aRevision())).toBe(true);
    expect(ok(Review, aReview())).toBe(true);
    // Reviews attest to version 2; version 1 attested to text the author wrote (ADR-0012).
    expect(ok(Review, aReview({ attestationVersion: 1 as 2 }))).toBe(false);
    expect(ok(Preview, aPreview())).toBe(true);
    expect(ok(EligibilityFacts, eligibleFacts())).toBe(true);
    expect(ok(PublishedVersion, aPublishedVersion())).toBe(true);
    const handle = { handle: "sean", accountId: ids.account, state: "active", redirectTo: null };
    expect(ok(Handle, { ...handle, createdAt: T0 })).toBe(true);
    const repo = {
      githubRepoId: 202,
      fullName: "seanpatrickmay/repowiki",
      visibility: "public",
      isFork: false,
      defaultBranch: "main",
      checkedAt: T0,
    };
    expect(ok(Repository, repo)).toBe(true);
  });

  it("refuse unknown fields, non-v4 ids and non-integer GitHub ids", () => {
    expect(ok(Account, { ...anAccount(), admin: true })).toBe(false);
    expect(ok(Account, anAccount({ id: "00000000-0000-1000-8000-000000000001" }))).toBe(false);
    expect(ok(Account, anAccount({ githubUserId: 1.5 }))).toBe(false);
    expect(ok(Account, anAccount({ githubUserId: 0 }))).toBe(false);
  });

  it("set a handle's redirect target exactly when it redirects", () => {
    const base = { handle: "old", accountId: ids.account, createdAt: T0 };
    expect(ok(Handle, { ...base, state: "redirect", redirectTo: "fresh" })).toBe(true);
    expect(ok(Handle, { ...base, state: "redirect", redirectTo: null })).toBe(false);
    expect(ok(Handle, { ...base, state: "active", redirectTo: "fresh" })).toBe(false);
  });

  it("give a withdrawn or purged project a reason and time, and nothing else one", () => {
    expect(ok(Project, aProject({ state: "withdrawn" }))).toBe(false);
    const withdrawn = aProject({ state: "withdrawn", withdrawReason: "author", withdrawnAt: T0 });
    expect(ok(Project, withdrawn)).toBe(true);
    expect(
      ok(Project, {
        ...withdrawn,
        state: "purged",
        withdrawReason: "repository",
        unavailableSince: T0,
      }),
    ).toBe(true);
    expect(ok(Project, aProject({ withdrawReason: "author", withdrawnAt: T0 }))).toBe(false);
  });

  it("refuse a published project with no published version", () => {
    expect(ok(Project, aProject({ state: "published", currentVersion: 0 }))).toBe(false);
    expect(ok(Project, aProject({ state: "published", currentVersion: 1 }))).toBe(true);
  });

  it("give a failed job its refusal code, and keep spend and estimate within the cap", () => {
    expect(ok(Job, aJob({ status: "failed" }))).toBe(false);
    expect(ok(Job, aJob({ status: "failed", refusal: "job-failed" }))).toBe(true);
    expect(ok(Job, aJob({ refusal: "job-failed" }))).toBe(false);
    expect(ok(Job, aJob({ spentUsdMicros: 600_001 }))).toBe(false);
    expect(ok(Job, aJob({ estimateUsdMicros: 600_001 }))).toBe(false);
    expect(ok(Job, aJob({ attempt: 4 }))).toBe(false);
  });

  it("only suggest highlights the generation's wiki has", () => {
    const g = aGeneration();
    const suggestions = { ...g.suggestions, highlightCandidates: ["nowhere"] };
    expect(ok(Generation, { ...g, suggestions })).toBe(false);
  });

  it("hold generated content, and no overrides or flags (ADR-0012)", () => {
    expect(ok(DraftRevision, { ...aRevision(), flags: [] })).toBe(false);
    expect(ok(DraftRevision, { ...aRevision(), overrides: {} })).toBe(false);
    const markup = aRevision({ content: { ...aRevision().content, tagline: "<b>x</b>" } });
    expect(ok(DraftRevision, markup)).toBe(false);
  });

  it("number revisions and versions from 1 and cap authored commits at 1000", () => {
    expect(ok(DraftRevision, aRevision({ number: 0 }))).toBe(false);
    expect(ok(PublishedVersion, aPublishedVersion({ version: 0 }))).toBe(false);
    expect(ok(EligibilityFacts, eligibleFacts({ authoredCommits: 1001 }))).toBe(false);
    expect(ok(EligibilityFacts, eligibleFacts({ indexedFiles: null }))).toBe(true);
  });

  it("name the quota exactly on quota ledger entries", () => {
    const entry = {
      id: ids.generation,
      accountId: ids.account,
      jobId: ids.job,
      kind: "quota",
      usdMicros: 0,
      quota: "generation",
      createdAt: T0,
    };
    expect(ok(LedgerEntry, entry)).toBe(true);
    expect(ok(LedgerEntry, { ...entry, quota: null })).toBe(false);
    expect(ok(LedgerEntry, { ...entry, kind: "spend", quota: "generation" })).toBe(false);
    expect(ok(LedgerEntry, { ...entry, kind: "spend", quota: null, usdMicros: -1 })).toBe(false);
  });

  it("audit an action with its actor, target and outcome", () => {
    expect(ACTIONS).toHaveLength(17);
    expect(ACTIONS).not.toContain("draft.save");
    const event = {
      id: ids.generation,
      actor: "author",
      action: "project.publish",
      target: { entity: "project", id: ids.project },
      outcome: "allowed",
      createdAt: T0,
    };
    expect(ok(AuditEvent, event)).toBe(true);
    expect(ok(AuditEvent, { ...event, outcome: "frozen" })).toBe(true);
    expect(ok(AuditEvent, { ...event, outcome: "maybe" })).toBe(false);
    expect(ok(AuditEvent, { ...event, action: "job.lease" })).toBe(true);
  });
});

describe("when a project's repository went away (final review I10b)", () => {
  it("is set exactly for repository withdrawals, optionally for withdrawn or purged projects", () => {
    const at = { withdrawnAt: T0, unavailableSince: T0 };
    expect(ok(Project, aProject({ state: "withdrawn", withdrawReason: "repository", ...at }))).toBe(
      true,
    );
    expect(ok(Project, aProject({ state: "withdrawn", withdrawReason: "author", ...at }))).toBe(
      true,
    );
    expect(
      ok(Project, aProject({ state: "withdrawn", withdrawReason: "repository", withdrawnAt: T0 })),
    ).toBe(false);
    expect(ok(Project, aProject({ unavailableSince: T0 }))).toBe(false);
  });
});
