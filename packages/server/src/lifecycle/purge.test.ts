import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { publicRoutes } from "../routes/public.ts";
import {
  auditOutcomes,
  call,
  generatedProject,
  publishedStub,
  TEST_NOW,
  testDeps,
} from "../routes/test-app.ts";
import { deleteAccount } from "../store/account-deletion.ts";
import { accountById } from "../store/accounts.ts";
import { projectById, saveProject } from "../store/projects.ts";
import { purgeDue } from "./purge.ts";

const days = (n: number) => new Date(Date.parse(TEST_NOW) + n * 86_400_000).toISOString();

let deps: Deps;
beforeEach(async () => {
  deps = await testDeps();
});
afterEach(async () => deps.db.close());

const count = async (table: string, projectId: string) =>
  (
    await deps.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE project_id = $1`,
      [projectId],
    )
  )[0]?.n;

describe("the purge (Contract §6.2, ADR-0018)", () => {
  it("purges a deleted account's projects after 30 days, then removes what identified the person", async () => {
    const p = await generatedProject(deps);
    await deps.objects.put(`previews/${p.projectId}/r1/h/index.html`, "x", "text/html");
    await deps.objects.put(`sites/${p.projectId}/v1/index.html`, "x", "text/html");
    const exports = await deps.objects.list("exports/");
    expect(exports.length).toBe(1);
    await deps.db.transaction((tx) => deleteAccount(tx, { accountId: p.accountId, now: TEST_NOW }));

    const early = { db: deps.db, objects: deps.objects, now: () => days(29) };
    expect(await purgeDue(early)).toEqual({ projects: 0, accounts: 0 });
    expect((await projectById(deps.db, p.projectId))?.state).toBe("withdrawn");

    const due = { ...early, now: () => days(31) };
    expect(await purgeDue(due)).toEqual({ projects: 1, accounts: 1 });
    expect((await projectById(deps.db, p.projectId))?.state).toBe("purged");
    for (const table of ["generations", "revisions", "reviews", "previews", "published_versions"]) {
      expect(await count(table, p.projectId), table).toBe(0);
    }
    expect(await deps.objects.list(`previews/${p.projectId}/`)).toEqual([]);
    expect(await deps.objects.list(`sites/${p.projectId}/`)).toEqual([]);
    expect(await deps.objects.list("exports/")).toEqual([]);
    expect(await deps.db.query("SELECT * FROM job_specs")).toEqual([]);
    const account = await accountById(deps.db, p.accountId);
    expect(account?.displayName).toBe(account?.login);
    expect(account?.avatar).toBeUndefined();
    expect(await auditOutcomes(deps.db, "project.purge", p.projectId)).toEqual(["allowed"]);
    const pages = createApp(deps, publicRoutes(deps), { host: "pages" });
    expect((await call(pages, { path: "/demo-dev/demo-repo/" })).status).toBe(410);
    // Running again finds nothing left to do.
    expect(await purgeDue(due)).toEqual({ projects: 0, accounts: 0 });
  });

  it("purges a repository withdrawal 30 days after the repository went away, and leaves the account", async () => {
    const p = await generatedProject(deps);
    const id = await publishedStub(deps, p.accountId, "gone", 4343);
    const stub = await projectById(deps.db, id);
    if (stub === null) throw new Error("setup");
    await saveProject(deps.db, {
      ...stub,
      state: "withdrawn",
      withdrawReason: "repository",
      withdrawnAt: TEST_NOW,
      unavailableSince: TEST_NOW,
    });
    expect(await purgeDue({ db: deps.db, objects: deps.objects, now: () => days(31) })).toEqual({
      projects: 1,
      accounts: 0,
    });
    expect((await projectById(deps.db, id))?.state).toBe("purged");
    expect((await projectById(deps.db, p.projectId))?.state).toBe("draft");
    expect((await accountById(deps.db, p.accountId))?.displayName).toBe("Demo Developer");
  });
});
