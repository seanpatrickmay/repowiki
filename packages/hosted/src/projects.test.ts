import { describe, expect, it } from "vitest";
import type { Project } from "./entities.ts";
import {
  accountDeleted,
  newProject,
  purge,
  repositoryUnavailable,
  restore,
  takedown,
  unpublish,
} from "./projects.ts";
import { aProject, ids, T0 } from "./test-fixtures.ts";

const T1 = "2026-10-20T00:00:00Z";
const DAY29 = "2026-11-12T12:00:00Z";
const DAY31 = "2026-11-14T12:00:00Z";
const published = aProject({ state: "published", currentVersion: 2, latestRevision: 3 });
const withdrawn = (reason: Project["withdrawReason"], patch: Partial<Project> = {}) =>
  aProject({ state: "withdrawn", withdrawReason: reason, withdrawnAt: T0, ...patch });

describe("projects (Contract spec §6.2)", () => {
  it("start as drafts", () => {
    const input = { id: ids.project, accountId: ids.account, githubRepoId: 202, slug: "repowiki" };
    expect(newProject({ ...input, now: T0 })).toEqual(aProject());
  });

  it("withdraw by the author only from published", () => {
    expect(unpublish(published, T1)).toEqual({
      ok: true,
      value: { ...published, state: "withdrawn", withdrawReason: "author", withdrawnAt: T1 },
    });
    expect(unpublish(aProject(), T1)).toMatchObject({ code: "invalid-transition" });
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
    expect(repositoryUnavailable(withdrawn("author"), T1)).toMatchObject({
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
    expect(restore(wasPublished, DAY29)).toMatchObject({
      value: { state: "published", withdrawReason: null, withdrawnAt: null },
    });
    expect(restore(withdrawn("repository"), DAY29)).toMatchObject({ value: { state: "draft" } });
    expect(restore(wasPublished, DAY31)).toEqual({ ok: false, code: "restore-expired" });
    expect(restore(withdrawn("author"), DAY29)).toMatchObject({ code: "invalid-transition" });
    expect(restore(withdrawn("operator"), DAY29)).toMatchObject({ code: "invalid-transition" });
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
