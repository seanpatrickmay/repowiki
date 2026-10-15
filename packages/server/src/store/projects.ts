import { monthOf, Project, Repository, type Usage } from "@repowiki/hosted";
import type { Queryable } from "../db/db.ts";
import { asJson, parsedBody } from "./rows.ts";

const lock = (forUpdate: boolean) => (forUpdate ? " FOR UPDATE" : "");
const parsed = (rows: { body: unknown }[]) =>
  rows[0] === undefined ? null : parsedBody(Project, rows[0].body, "project");

export async function projectById(
  q: Queryable,
  id: string,
  forUpdate = false,
): Promise<Project | null> {
  return parsed(
    await q.query<{ body: unknown }>(`SELECT body FROM projects WHERE id = $1${lock(forUpdate)}`, [
      id,
    ]),
  );
}

export async function projectFor(
  q: Queryable,
  accountId: string,
  githubRepoId: number,
  forUpdate = false,
): Promise<Project | null> {
  return parsed(
    await q.query<{ body: unknown }>(
      `SELECT body FROM projects WHERE account_id = $1 AND github_repo_id = $2${lock(forUpdate)}`,
      [accountId, githubRepoId],
    ),
  );
}

export async function projectsOf(q: Queryable, accountId: string): Promise<Project[]> {
  const rows = await q.query<{ body: unknown }>(
    "SELECT body FROM projects WHERE account_id = $1 ORDER BY body->>'createdAt' DESC, id",
    [accountId],
  );
  return rows.map((r) => parsedBody(Project, r.body, "project"));
}

export async function saveProject(q: Queryable, project: Project): Promise<void> {
  const body = parsedBody(Project, project, "project");
  await q.query(
    `INSERT INTO projects (id, account_id, github_repo_id, slug, body) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, body = excluded.body`,
    [body.id, body.accountId, body.githubRepoId, body.slug, asJson(body)],
  );
}

export async function saveRepository(q: Queryable, repository: Repository): Promise<void> {
  const body = parsedBody(Repository, repository, "repository");
  await q.query(
    `INSERT INTO repositories (github_repo_id, body) VALUES ($1, $2::jsonb)
     ON CONFLICT (github_repo_id) DO UPDATE SET body = excluded.body`,
    [body.githubRepoId, asJson(body)],
  );
}

const monthStart = (now: string) => `${monthOf(now)}-01T00:00:00.000Z`;
const dayStart = (now: string) => `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;

/** Reserved caps of unfinished jobs plus actual spend of finished ones (Contract C8, §18.6). */
const COST = `CASE WHEN j.status IN ('queued', 'running') THEN (j.body->>'capUsdMicros')::bigint
  ELSE (j.body->>'spentUsdMicros')::bigint END`;
const SUCCEEDED = (kind: string) => `j.status = 'succeeded' AND j.body->>'kind' = '${kind}'`;
const IN_FLIGHT = (kind: string) =>
  `j.status IN ('queued', 'running') AND j.body->>'kind' = '${kind}'`;
const THIS_MONTH = (field: string) => `(j.body->>'${field}')::timestamptz >= $2`;

/** The Contract's Usage for one account, from the jobs and projects tables (spec 2 S15). */
export async function usageFor(q: Queryable, accountId: string, now: string): Promise<Usage> {
  const rows = await q.query<Record<string, string | number | null>>(
    `SELECT
      (SELECT count(*) FROM projects WHERE account_id = $1 AND body->>'state' IN ('draft', 'published')) AS active,
      count(*) FILTER (WHERE ${SUCCEEDED("generate")}) AS gen_life,
      count(*) FILTER (WHERE ${SUCCEEDED("generate")} AND ${THIS_MONTH("finishedAt")}) AS gen_month,
      count(*) FILTER (WHERE ${SUCCEEDED("refresh")} AND ${THIS_MONTH("finishedAt")}) AS ref_month,
      count(*) FILTER (WHERE ${IN_FLIGHT("generate")}) AS gen_flight,
      count(*) FILTER (WHERE ${IN_FLIGHT("refresh")}) AS ref_flight,
      COALESCE(sum(${COST}) FILTER (WHERE ${THIS_MONTH("createdAt")}), 0) AS month_usd
    FROM projects p JOIN jobs j ON j.project_id = p.id WHERE p.account_id = $1`,
    [accountId, monthStart(now)],
  );
  // `pg` returns bigint counts and sums as strings.
  const r = rows[0] ?? {};
  const n = (key: string) => Number(r[key] ?? 0);
  return {
    activeProjects: n("active"),
    generationsLifetime: n("gen_life"),
    generationsThisMonth: n("gen_month"),
    refreshesThisMonth: n("ref_month"),
    inFlightGenerations: n("gen_flight"),
    inFlightRefreshes: n("ref_flight"),
    monthUsdMicros: n("month_usd"),
    platformDayUsdMicros: await platformDayUsdMicros(q, now),
  };
}

/** Platform-wide model cost of the UTC day: reserved caps plus actual spend. */
export async function platformDayUsdMicros(q: Queryable, now: string): Promise<number> {
  const rows = await q.query<{ usd: string | number }>(
    `SELECT COALESCE(sum(${COST}), 0) AS usd FROM jobs j WHERE (j.body->>'createdAt')::timestamptz >= $1`,
    [dayStart(now)],
  );
  return Number(rows[0]?.usd ?? 0);
}
