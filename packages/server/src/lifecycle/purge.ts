import { randomUUID } from "node:crypto";
import { Account, purge } from "@repowiki/hosted";
import type { Db, Queryable } from "../db/db.ts";
import { avatarKey } from "../github/avatar.ts";
import type { ObjectStore } from "../objects/store.ts";
import { accountById } from "../store/accounts.ts";
import { appendAudit } from "../store/audit.ts";
import { projectById, saveProject } from "../store/projects.ts";
import { asJson, parsedBody } from "../store/rows.ts";

/** How often the server looks for projects whose grace period is over. */
export const PURGE_EVERY_MS = 60 * 60_000;

/** Rows derived from a project's source, deleted by its purge; the project row stays. */
const DERIVED = ["generations", "revisions", "reviews", "previews", "published_versions"];

export interface PurgeDeps {
  db: Db;
  objects: ObjectStore;
  now: () => string;
  log?: (line: object) => void;
}

const audit = (
  tx: Queryable,
  action: string,
  entity: "account" | "project",
  id: string,
  now: string,
) =>
  appendAudit(tx, {
    id: randomUUID(),
    actor: "system",
    action,
    target: { entity, id },
    outcome: "allowed",
    createdAt: now,
  });

/** Delete everything a project's source produced: objects first, so a failure retries next time. */
async function purgeProject(deps: PurgeDeps, id: string, now: string): Promise<boolean> {
  const project = await projectById(deps.db, id);
  if (project === null || !purge(project, now).ok) return false;
  const jobs = await deps.db.query<{ id: string }>("SELECT id FROM jobs WHERE project_id = $1", [
    id,
  ]);
  const keys = [
    ...(await deps.objects.list(`previews/${id}/`)),
    ...(await deps.objects.list(`sites/${id}/`)),
  ];
  for (const job of jobs) keys.push(...(await deps.objects.list(`exports/${job.id}-`)));
  await deps.objects.delete(keys);
  return deps.db.transaction(async (tx) => {
    const locked = await projectById(tx, id, true);
    const purged = locked === null ? null : purge(locked, now);
    if (!purged?.ok) return false;
    for (const table of DERIVED) {
      await tx.query(`DELETE FROM ${table} WHERE project_id = $1`, [id]);
    }
    await tx.query("DELETE FROM preview_tokens WHERE project_id = $1", [id]);
    await tx.query(
      "DELETE FROM job_specs WHERE job_id IN (SELECT id FROM jobs WHERE project_id = $1)",
      [id],
    );
    await saveProject(tx, purged.value);
    await audit(tx, "project.purge", "project", id, now);
    return true;
  });
}

/**
 * Once none of a deleted account's projects is left unpurged: its display name, avatar and billing
 * row go. The GitHub user ID and login stay with the tombstoned handles (ADR-0018).
 */
async function purgeAccount(deps: PurgeDeps, id: string, now: string): Promise<boolean> {
  const left = await deps.db.query(
    "SELECT 1 FROM projects WHERE account_id = $1 AND body->>'state' <> 'purged' LIMIT 1",
    [id],
  );
  const account = await accountById(deps.db, id);
  if (left.length > 0 || account === null) return false;
  const billing = await deps.db.query("SELECT 1 FROM billing WHERE account_id = $1", [id]);
  const { avatar, ...rest } = account;
  if (account.displayName === account.login && avatar === undefined && billing.length === 0) {
    return false;
  }
  if (avatar !== undefined) {
    const shared = await deps.db.query(
      "SELECT 1 FROM accounts WHERE id <> $1 AND body->'avatar'->>'sha256' = $2 LIMIT 1",
      [id, avatar.sha256],
    );
    if (shared.length === 0) await deps.objects.delete([avatarKey(avatar.sha256)]);
  }
  await deps.db.transaction(async (tx) => {
    const scrubbed = parsedBody(Account, { ...rest, displayName: account.login }, "account");
    await tx.query("UPDATE accounts SET body = $2::jsonb WHERE id = $1", [id, asJson(scrubbed)]);
    await tx.query("DELETE FROM billing WHERE account_id = $1", [id]);
    await audit(tx, "account.purge", "account", id, now);
  });
  return true;
}

/** Purge every project whose grace period is over, then what identified a deleted account. */
export async function purgeDue(deps: PurgeDeps): Promise<{ projects: number; accounts: number }> {
  const now = deps.now();
  let projects = 0;
  const withdrawn = await deps.db.query<{ id: string }>(
    "SELECT id FROM projects WHERE body->>'state' = 'withdrawn' ORDER BY id",
  );
  for (const { id } of withdrawn) if (await purgeProject(deps, id, now)) projects++;
  let accounts = 0;
  const deleting = await deps.db.query<{ id: string }>(
    "SELECT id FROM accounts WHERE body->>'status' = 'deleting' ORDER BY id",
  );
  for (const { id } of deleting) if (await purgeAccount(deps, id, now)) accounts++;
  return { projects, accounts };
}

/** Run `purgeDue` every `intervalMs`, one run at a time; returns the stop function. */
export function startPurger(deps: PurgeDeps, intervalMs = PURGE_EVERY_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    purgeDue(deps)
      .then((done) => {
        if (done.projects + done.accounts > 0) deps.log?.({ purge: done });
      })
      .catch((error: unknown) =>
        deps.log?.({ purge: "failed", error: error instanceof Error ? error.name : "unknown" }),
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
