import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../app.ts";
import { generatedProject, testDeps } from "../routes/test-app.ts";
import { latestRevision, previewOf, reviewOf } from "../store/drafts.ts";
import type { Db } from "./db.ts";
import { migrate } from "./migrate.ts";

let deps: Deps & { db: Db };
let projectId: string;
const AT = "2026-10-14T12:00:00.000Z";

/** Revision 1 as M14g stored it: author overrides over the generation, with flags. */
const legacy = (overrides: object, flags: string[] = []) =>
  `UPDATE revisions SET body = (body - 'content') || jsonb_build_object(
     'overrides', '${JSON.stringify(overrides)}'::jsonb, 'flags', '${JSON.stringify(flags)}'::jsonb,
     'source', 'author') WHERE project_id = $1`;

/** Revision 1 rewritten by `sql`, with a review and a preview, then migrations `from`–0007 again. */
async function storedBefore(sql: string, from: number, attestationVersion = 1): Promise<void> {
  await deps.db.query(sql, [projectId]);
  await deps.db.query(
    "INSERT INTO reviews (project_id, revision, body) VALUES ($1, 1, $2::jsonb)",
    [projectId, JSON.stringify({ projectId, revision: 1, attestationVersion, createdAt: AT })],
  );
  const preview = { projectId, revision: 1, siteKey: "previews/x/", siteHash: "a".repeat(64) };
  await deps.db.query(
    "INSERT INTO previews (project_id, revision, body) VALUES ($1, 1, $2::jsonb)",
    [projectId, JSON.stringify({ ...preview, createdAt: AT })],
  );
  // Only the ADR-0012 row migrations run again; later ones (0008 creates a table) cannot.
  await deps.db.query("DELETE FROM schema_migrations WHERE version BETWEEN $1 AND 7", [from]);
  await migrate(deps.db);
}

beforeEach(async () => {
  deps = await testDeps();
  ({ projectId } = await generatedProject(deps));
});
afterEach(async () => deps.db.close());

describe("rows stored before ADR-0012 (migrations 0005 and 0007)", () => {
  it("load when they hid features, with nothing of the hiding left", async () => {
    const overrides = { contribution: "Mine.", highlights: [], hiddenFeatureIds: ["signals"] };
    await storedBefore(legacy(overrides, ["hidden-missing:gone", "highlight-missing:x"]), 5);
    const latest = await latestRevision(deps.db, projectId);
    expect(Object.keys(latest ?? {}).sort()).toEqual([
      "content",
      "createdAt",
      "generationId",
      "number",
      "projectId",
    ]);
    expect(await reviewOf(deps.db, projectId, 1)).toBeNull();
    expect(await previewOf(deps.db, projectId, 1)).toBeNull();
  });

  it("hold their generation's content, the model's draft when it wrote one", async () => {
    await storedBefore(legacy({ contribution: "Mine.", highlights: [], tagline: "Mine" }), 7, 2);
    const latest = await latestRevision(deps.db, projectId);
    expect(latest?.content).toEqual({
      tagline: "A tiny demo",
      summary: "It demonstrates RepoWiki.",
      contribution: "I wrote the ingest code.",
      highlights: [],
    });
    // The review and preview were of the author's text, not of this content.
    expect(await reviewOf(deps.db, projectId, 1)).toBeNull();
    expect(await previewOf(deps.db, projectId, 1)).toBeNull();
  });

  it("write the facts paragraph when the model wrote no draft", async () => {
    await deps.db.query(
      `UPDATE generations SET body = jsonb_set(body, '{suggestions,contributionDraft}', '""')
       WHERE project_id = $1`,
      [projectId],
    );
    await storedBefore(legacy({ contribution: "", highlights: [] }), 7, 2);
    expect((await latestRevision(deps.db, projectId))?.content.contribution).toBe(
      "Demo Developer wrote 2 of the repository's 3 commits and about 50% of its current lines.",
    );
  });
});

describe("rows stored before ADR-0012 (migration 0006)", () => {
  it("lose their version 1 reviews, which attested to author-written text", async () => {
    await storedBefore("SELECT $1::uuid", 6);
    expect(await reviewOf(deps.db, projectId, 1)).toBeNull();
    expect(await previewOf(deps.db, projectId, 1)).not.toBeNull();
  });
});
