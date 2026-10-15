import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../app.ts";
import { generatedProject, testDeps } from "../routes/test-app.ts";
import { latestRevision, previewOf, reviewOf } from "../store/drafts.ts";
import type { Db } from "./db.ts";
import { migrate } from "./migrate.ts";

let deps: Deps & { db: Db };
let projectId: string;
const AT = "2026-10-14T12:00:00.000Z";

/** Revision 1 as M14g stored it, with its review and preview, then the later migrations again. */
async function storedBefore(sql: string, from: number): Promise<void> {
  await deps.db.query(sql, [projectId]);
  await deps.db.query(
    "INSERT INTO reviews (project_id, revision, body) VALUES ($1, 1, $2::jsonb)",
    [projectId, JSON.stringify({ projectId, revision: 1, attestationVersion: 1, createdAt: AT })],
  );
  const preview = { projectId, revision: 1, siteKey: "previews/x/", siteHash: "a".repeat(64) };
  await deps.db.query(
    "INSERT INTO previews (project_id, revision, body) VALUES ($1, 1, $2::jsonb)",
    [projectId, JSON.stringify({ ...preview, createdAt: AT })],
  );
  await deps.db.query("DELETE FROM schema_migrations WHERE version >= $1", [from]);
  await migrate(deps.db);
}

beforeEach(async () => {
  deps = await testDeps();
  ({ projectId } = await generatedProject(deps));
});
afterEach(async () => deps.db.close());

describe("rows stored before ADR-0012 (migration 0005)", () => {
  it("lose hidden features, and the review and preview made with them", async () => {
    await storedBefore(
      `UPDATE revisions SET body = jsonb_set(jsonb_set(body, '{overrides,hiddenFeatureIds}',
         '["deliverables"]'), '{flags}', '["hidden-missing:gone", "highlight-missing:old"]')
       WHERE project_id = $1`,
      5,
    );
    const latest = await latestRevision(deps.db, projectId);
    expect(latest?.flags).toEqual(["highlight-missing:old"]);
    expect(latest?.overrides).not.toHaveProperty("hiddenFeatureIds");
    expect(await reviewOf(deps.db, projectId, 1)).toBeNull();
    expect(await previewOf(deps.db, projectId, 1)).toBeNull();
  });

  it("keep the review and preview of a revision that hid nothing", async () => {
    await storedBefore(
      `UPDATE revisions SET body = jsonb_set(body, '{overrides,hiddenFeatureIds}', '[]')
       WHERE project_id = $1`,
      5,
    );
    expect(await latestRevision(deps.db, projectId)).not.toBeNull();
    expect(await reviewOf(deps.db, projectId, 1)).not.toBeNull();
    expect(await previewOf(deps.db, projectId, 1)).not.toBeNull();
  });
});
