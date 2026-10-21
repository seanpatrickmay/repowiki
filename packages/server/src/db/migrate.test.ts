import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./db.ts";
import { isUniqueViolation } from "./db.ts";
import { migrate, migrationFiles, openDatabase } from "./migrate.ts";
import { openPglite } from "./pglite.ts";

let db: Db;
beforeAll(async () => {
  db = await openPglite(null);
});
afterAll(async () => db.close());

describe("migrations (spec 2 S4)", () => {
  it("are numbered from 1 with no gaps", () => {
    const files = migrationFiles();
    expect(files.map((f) => f.version)).toEqual(files.map((_, i) => i + 1));
    expect(files[0]?.name).toBe("0001-initial.sql");
  });

  it("apply once, then are a no-op", async () => {
    expect(await migrate(db)).toEqual(migrationFiles().map((f) => f.version));
    expect(await migrate(db)).toEqual([]);
    const tables = await db.query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(tables.map((t) => t.name)).toEqual([
      "accounts",
      "audit_events",
      "billing",
      "generations",
      "github_tokens",
      "handles",
      "job_specs",
      "job_tokens",
      "jobs",
      "preview_tokens",
      "previews",
      "projects",
      "published_versions",
      "repositories",
      "reservations",
      "reviews",
      "revisions",
      "schema_migrations",
      "sessions",
      "stripe_events",
    ]);
  });
});

describe("openDatabase (spec 2 S3)", () => {
  it("opens the configured database already migrated", async () => {
    const opened = await openDatabase({ kind: "pglite", dataDir: null });
    const rows = await opened.query<{ version: number }>("SELECT version FROM schema_migrations");
    expect(rows.map((r) => r.version)).toEqual(migrationFiles().map((f) => f.version));
    await opened.close();
  });
});

describe("constraints (spec 2 §5)", () => {
  const P = "00000000-0000-4000-8000-0000000000a1";
  const J1 = "00000000-0000-4000-8000-0000000000b1";
  const J2 = "00000000-0000-4000-8000-0000000000b2";

  it("allow one non-terminal job per project, and any number of finished ones", async () => {
    const insert = (id: string, status: string) =>
      db.query(
        "INSERT INTO jobs (id, project_id, status, lease_expires_at, body) VALUES ($1, $2, $3, NULL, '{}'::jsonb)",
        [id, P, status],
      );
    await insert(J1, "queued");
    const error = await insert(J2, "running").catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    await db.query("UPDATE jobs SET status = 'failed' WHERE id = $1", [J1]);
    await insert(J2, "running");
  });

  it("allow one project per repository and per slug within an account", async () => {
    const A = "00000000-0000-4000-8000-0000000000c1";
    await db.query("INSERT INTO accounts (id, github_user_id, body) VALUES ($1, 7, '{}'::jsonb)", [
      A,
    ]);
    const project = (id: string, repo: number, slug: string) =>
      db
        .query(
          "INSERT INTO projects (id, account_id, github_repo_id, slug, body) VALUES ($1, $2, $3, $4, '{}'::jsonb)",
          [id, A, repo, slug],
        )
        .then(
          () => "ok",
          (e: unknown) => (isUniqueViolation(e) ? "duplicate" : e),
        );
    expect(await project("00000000-0000-4000-8000-0000000000d1", 1, "a")).toBe("ok");
    expect(await project("00000000-0000-4000-8000-0000000000d2", 1, "b")).toBe("duplicate");
    expect(await project("00000000-0000-4000-8000-0000000000d3", 2, "a")).toBe("duplicate");
    expect(await project("00000000-0000-4000-8000-0000000000d4", 2, "b")).toBe("ok");
  });
});
