import { describe, expect, it } from "vitest";
import type { Project } from "./entities.ts";
import {
  accountDeleted,
  accountReturned,
  newProject,
  purge,
  repositoryUnavailable,
  restore,
  revive,
  takedown,
  unpublish,
} from "./projects.ts";
import { aProject, ids, T0 } from "./test-fixtures.ts";

const T1 = "2026-10-20T00:00:00Z";
const DAY29 = "2026-11-12T12:00:00Z";
const DAY31 = "2026-11-14T12:00:00Z";
const published = aProject({ state: "published", currentVersion: 2, latestRevision: 3 });
const withdrawn = (reason: Project["withdrawReason"], patch: Partial<Project> = {}) =>
  aProject({
    state: "withdrawn",
    withdrawReason: reason,
    withdrawnAt: T0,
    unavailableSince: reason === "repository" ? T0 : null,
    ...patch,
  });

describe("an account that comes back (ADR-0021)", () => {
  it("gets each project its deletion withdrew back as the author's own withdrawal, its purge clock stopped", () => {
    const gone = withdrawn("account-deleted", { currentVersion: 2, latestRevision: 3 });
    expect(accountReturned(gone)).toEqual({
      ok: true,
      value: { ...gone, withdrawReason: "author", unavailableSince: null },
    });
    const back = accountReturned(gone);
    if (!back.ok) throw new Error("not returned");
    expect(purge(back.value, DAY31).ok).toBe(false);
  });

  it("leaves every other project as it is", () => {
    for (const project of [published, aProject(), withdrawn("author"), withdrawn("operator")]) {
      expect(accountReturned(project).ok).toBe(false);
    }
  });

  it("starts a purged project again as a fresh draft at the same address", () => {
    const purged = aProject({
      state: "purged",
      withdrawReason: "account-deleted",
      withdrawnAt: T0,
      latestRevision: 3,
      currentVersion: 2,
    });
    expect(revive(purged)).toEqual({
      ok: true,
      value: { ...aProject(), id: purged.id, slug: purged.slug, createdAt: purged.createdAt },
    });
    expect(revive(published).ok).toBe(false);
  });
});

describe("projects (Contract spec §6.2)", () => {
  it("start as drafts", () => {
    const input = { id: ids.project, accountId: ids.account, githubRepoId: 202, slug: "repowiki" };
    expect(newProject({ ...input, now: T0 })).toEqual(aProject());
  });

  it("withdraw by the author from published or draft (final review I10a)", () => {
    expect(unpublish(published, T1)).toEqual({
      ok: true,
      value: { ...published, state: "withdrawn", withdrawReason: "author", withdrawnAt: T1 },
    });
    expect(unpublish(aProject(), T1)).toMatchObject({
      value: { state: "withdrawn", withdrawReason: "author", currentVersion: 0 },
    });
    expect(unpublish(withdrawn("author"), T1)).toMatchObject({ code: "invalid-transition" });
  });

  it("withdraw for the repository or an operator from draft or published", () => {
    for (const p of [aProject(), published]) {
      expect(repositoryUnavailable(p, T1)).toMatchObject({
        ok: true,
        value: { state: "withdrawn", withdrawReason: "repository", withdrawnAt: T1 },
      });
      expect(takedown(p, T1)).toMatchObject({ value: { withdrawReason: "operator" } });
    }
    expect(repositoryUnavailable(withdrawn("operator"), T1)).toMatchObject({
      code: "invalid-transition",
    });
  });

  it("withdraw everything but purged projects when the account is deleted", () => {
    expect(accountDeleted(withdrawn("author"), T1)).toMatchObject({
      value: { withdrawReason: "account-deleted", withdrawnAt: T1 },
    });
    const purged = withdrawn("repository", { state: "purged" });
    expect(accountDeleted(purged, T1)).toMatchObject({ code: "invalid-transition" });
  });

  it("restore a repository withdrawal within 30 days to where it was", () => {
    const wasPublished = withdrawn("repository", { currentVersion: 2 });
    const ok = { servable: true };
    expect(restore(wasPublished, DAY29, ok)).toMatchObject({
      value: { state: "published", withdrawReason: null, withdrawnAt: null },
    });
    expect(restore(withdrawn("repository"), DAY29, ok)).toMatchObject({
      value: { state: "draft" },
    });
    expect(restore(wasPublished, DAY31, ok)).toEqual({ ok: false, code: "restore-expired" });
    expect(restore(withdrawn("author"), DAY29, ok)).toMatchObject({ code: "invalid-transition" });
    expect(restore(withdrawn("operator"), DAY29, ok)).toMatchObject({
      code: "invalid-transition",
    });
  });

  it("restore to draft when the current version cannot be served (ADR-0013, review I3)", () => {
    const oldLayout = withdrawn("repository", { currentVersion: 2 });
    expect(restore(oldLayout, DAY29, { servable: false })).toMatchObject({
      value: { state: "draft", currentVersion: 2, withdrawReason: null, unavailableSince: null },
    });
  });

  it("purge repository and account withdrawals after 30 days, keeping the tombstone", () => {
    expect(purge(withdrawn("repository"), DAY29)).toMatchObject({ code: "invalid-transition" });
    expect(purge(withdrawn("repository"), DAY31)).toMatchObject({
      value: { state: "purged", withdrawReason: "repository", slug: "repowiki" },
    });
    expect(purge(withdrawn("account-deleted"), DAY31)).toMatchObject({ ok: true });
    expect(purge(withdrawn("author"), DAY31)).toMatchObject({ code: "invalid-transition" });
  });
});

describe("a repository going away under an author-withdrawn project (final review I10b)", () => {
  it("starts the purge clock without changing the page", () => {
    const mine = withdrawn("author");
    expect(repositoryUnavailable(mine, T1)).toEqual({
      ok: true,
      value: { ...mine, unavailableSince: T1 },
    });
    expect(repositoryUnavailable({ ...mine, unavailableSince: T1 }, T1)).toMatchObject({
      code: "invalid-transition",
    });
  });

  it("records when the repository went away on a live project too", () => {
    expect(repositoryUnavailable(published, T1)).toMatchObject({
      value: { unavailableSince: T1, withdrawnAt: T1 },
    });
  });

  it("purges it 30 days after the repository went away, not after the author withdrew it", () => {
    const gone = withdrawn("author", { withdrawnAt: "2026-01-01T00:00:00Z", unavailableSince: T1 });
    expect(purge(gone, DAY31)).toMatchObject({ code: "invalid-transition" });
    expect(purge(gone, "2026-11-20T00:00:00Z")).toMatchObject({ value: { state: "purged" } });
  });

  it("stops the clock when restored, leaving the page withdrawn", () => {
    const gone = withdrawn("author", { unavailableSince: T1 });
    expect(restore(gone, DAY29, { servable: true })).toEqual({
      ok: true,
      value: { ...gone, unavailableSince: null },
    });
    expect(restore(gone, "2026-11-20T00:00:00Z", { servable: true })).toEqual({
      ok: false,
      code: "restore-expired",
    });
  });

  it("clears the clock on a repository restore", () => {
    const gone = withdrawn("repository", { unavailableSince: T0 });
    expect(restore(gone, DAY29, { servable: true })).toMatchObject({
      value: { state: "draft", unavailableSince: null },
    });
  });
});
