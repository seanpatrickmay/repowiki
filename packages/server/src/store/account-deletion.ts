import { randomUUID } from "node:crypto";
import { Account, accountDeleted, Handle } from "@repowiki/hosted";
import type { Queryable } from "../db/db.ts";
import { appendAudit } from "./audit.ts";
import { activeJob } from "./jobs.ts";
import { projectById, projectsOf, saveProject } from "./projects.ts";
import { asJson, parsedBody } from "./rows.ts";

/** Whether any of the account's projects has a build queued or running. */
export async function buildInFlight(q: Queryable, accountId: string): Promise<boolean> {
  for (const project of await projectsOf(q, accountId)) {
    if ((await activeJob(q, project.id, true)) !== null) return true;
  }
  return false;
}

/**
 * Delete an account (Contract §6.2, §9; ADR-0018), inside the caller's transaction: the account
 * turns `deleting`, every project is withdrawn for account deletion (its pages answer 410 and the
 * 30-day purge clock starts), every handle is tombstoned, and its sessions, GitHub token and
 * preview links are gone. "build" when a build is in flight, which must finish first.
 */
export async function deleteAccount(
  tx: Queryable,
  input: { accountId: string; now: string },
): Promise<"deleted" | "build"> {
  const { accountId, now } = input;
  const rows = await tx.query<{ body: unknown }>(
    "SELECT body FROM accounts WHERE id = $1 FOR UPDATE",
    [accountId],
  );
  const account = parsedBody(Account, rows[0]?.body, "account");
  if (account.status === "deleting") return "deleted";
  if (await buildInFlight(tx, accountId)) return "build";
  await tx.query("UPDATE accounts SET body = $2::jsonb WHERE id = $1", [
    accountId,
    asJson(parsedBody(Account, { ...account, status: "deleting" }, "account")),
  ]);
  for (const { id } of await projectsOf(tx, accountId)) {
    const project = await projectById(tx, id, true);
    const withdrawn = project === null ? null : accountDeleted(project, now);
    if (withdrawn?.ok) await saveProject(tx, withdrawn.value);
  }
  const handles = await tx.query<{ body: unknown }>(
    "SELECT body FROM handles WHERE account_id = $1 FOR UPDATE",
    [accountId],
  );
  for (const row of handles) {
    const handle = parsedBody(Handle, row.body, "handle");
    const tombstone = { ...handle, state: "tombstoned" as const, redirectTo: null };
    await tx.query("UPDATE handles SET body = $2::jsonb WHERE handle = $1", [
      handle.handle,
      asJson(parsedBody(Handle, tombstone, "handle")),
    ]);
  }
  await tx.query("DELETE FROM sessions WHERE account_id = $1", [accountId]);
  await tx.query("DELETE FROM github_tokens WHERE account_id = $1", [accountId]);
  await tx.query(
    "DELETE FROM preview_tokens WHERE project_id IN (SELECT id FROM projects WHERE account_id = $1)",
    [accountId],
  );
  await appendAudit(tx, {
    id: randomUUID(),
    actor: "author",
    action: "account.delete",
    target: { entity: "account", id: accountId },
    outcome: "allowed",
    createdAt: now,
  });
  return "deleted";
}
