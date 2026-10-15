import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../app.ts";
import { sha256Hex } from "../crypto.ts";
import type { Db } from "../db/db.ts";
import { generatedProject, testDeps } from "../routes/test-app.ts";
import { mintPreviewToken, PREVIEW_TOKEN_MS, previewByToken } from "./preview-tokens.ts";

let deps: Deps & { db: Db };
let projectId: string;
const NOW = "2026-10-14T12:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

beforeEach(async () => {
  deps = await testDeps();
  ({ projectId } = await generatedProject(deps));
});
afterEach(async () => deps.db.close());

describe("preview tokens (ADR-0012)", () => {
  it("are 32 random bytes, stored only as their SHA-256", async () => {
    const token = await mintPreviewToken(deps.db, { projectId, revision: 1 }, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await mintPreviewToken(deps.db, { projectId, revision: 1 }, NOW)).not.toBe(token);
    const rows = await deps.db.query<Record<string, unknown>>("SELECT * FROM preview_tokens");
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows.map((r) => r.token_hash)).toContain(sha256Hex(token));
  });

  it("open their revision's preview for an hour, then nothing", async () => {
    expect(PREVIEW_TOKEN_MS).toBe(3_600_000);
    const token = await mintPreviewToken(deps.db, { projectId, revision: 1 }, NOW);
    expect(await previewByToken(deps.db, token, later(PREVIEW_TOKEN_MS - 1))).toEqual({
      projectId,
      revision: 1,
    });
    expect(await previewByToken(deps.db, token, later(PREVIEW_TOKEN_MS))).toBeNull();
  });

  it("open nothing for an unknown or malformed token", async () => {
    await mintPreviewToken(deps.db, { projectId, revision: 1 }, NOW);
    for (const token of ["A".repeat(43), "", "x", `${"A".repeat(42)}%`]) {
      expect(await previewByToken(deps.db, token, NOW), token).toBeNull();
    }
  });

  it("are deleted once expired, when the next one is minted", async () => {
    await mintPreviewToken(deps.db, { projectId, revision: 1 }, NOW);
    await mintPreviewToken(deps.db, { projectId, revision: 1 }, later(PREVIEW_TOKEN_MS));
    const rows = await deps.db.query("SELECT token_hash FROM preview_tokens");
    expect(rows).toHaveLength(1);
  });
});
