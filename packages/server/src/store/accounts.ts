import { randomUUID } from "node:crypto";
import {
  Account,
  accountReturned,
  Handle,
  type HandleLookup,
  type HandleRecord,
  handleFor,
  lookupHandle,
  type Plan,
} from "@repowiki/hosted";
import { type Db, isUniqueViolation, type Queryable } from "../db/db.ts";
import { appendAudit } from "./audit.ts";
import { projectById, projectsOf, saveProject } from "./projects.ts";
import { asJson, parsedBody } from "./rows.ts";

export interface GitHubProfile {
  githubUserId: number;
  login: string;
  displayName: string;
  githubCreatedAt: string;
}

export interface SignInOptions {
  newAccountId: string;
  /** Whether a GitHub login with no account yet may create one (the sign-up allowlist, S7). */
  allowNew: (login: string) => boolean;
  now: string;
  /** A new account's plan: Free unless local testing asks for Pro (REPOWIKI_LOCAL_PLAN). */
  plan?: Plan;
}

export interface SignedIn {
  account: Account;
  handle: string;
  created: boolean;
}

/**
 * The account for a GitHub user, created with its handle on first sign-in (Contract §9). Null when
 * the user is new and not allowed to sign up. A deleted account comes back (ADR-0021), whatever the
 * allowlist says: it was let in once. Two concurrent first sign-ins make one account.
 */
export async function signIn(
  db: Db,
  profile: GitHubProfile,
  options: SignInOptions,
): Promise<SignedIn | null> {
  try {
    return await signInOnce(db, profile, options);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return signInOnce(db, profile, options);
  }
}

/**
 * A deleted account signing in again (ADR-0021): it gets back its handle (the one for its login,
 * else its newest), and every project its deletion withdrew comes back as the author's own
 * withdrawal, unpublished and no longer purged. Its sessions and token went with the deletion; the
 * sign-in makes new ones. Its usage history was never deleted, so no allowance starts over.
 */
async function comeBack(tx: Queryable, accountId: string, login: string, now: string) {
  const rows = await tx.query<{ body: unknown }>(
    "SELECT body FROM handles WHERE account_id = $1 FOR UPDATE",
    [accountId],
  );
  const tombstoned = rows
    .map((row) => parsedBody(Handle, row.body, "handle"))
    .filter((h) => h.state === "tombstoned")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const back = tombstoned.find((h) => h.handle === login.toLowerCase()) ?? tombstoned[0];
  if (back !== undefined) {
    await tx.query("UPDATE handles SET body = $2::jsonb WHERE handle = $1", [
      back.handle,
      asJson(parsedBody(Handle, { ...back, state: "active", redirectTo: null }, "handle")),
    ]);
  }
  for (const { id } of await projectsOf(tx, accountId)) {
    const project = await projectById(tx, id, true);
    const returned = project === null ? null : accountReturned(project);
    if (returned?.ok) await saveProject(tx, returned.value);
  }
  await appendAudit(tx, {
    id: randomUUID(),
    actor: "author",
    action: "account.return",
    target: { entity: "account", id: accountId },
    outcome: "allowed",
    createdAt: now,
  });
}

async function signInOnce(
  db: Db,
  profile: GitHubProfile,
  options: SignInOptions,
): Promise<SignedIn | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ body: unknown }>(
      "SELECT body FROM accounts WHERE github_user_id = $1 FOR UPDATE",
      [profile.githubUserId],
    );
    const existing = rows[0];
    if (existing !== undefined) {
      const account = parsedBody(Account, existing.body, "account");
      const returning = account.status === "deleting";
      const refreshed: Account = {
        ...account,
        login: profile.login,
        displayName: profile.displayName,
        status: "active",
      };
      await tx.query("UPDATE accounts SET body = $2::jsonb WHERE id = $1", [
        account.id,
        asJson(parsedBody(Account, refreshed, "account")),
      ]);
      if (returning) await comeBack(tx, account.id, profile.login, options.now);
      return {
        account: refreshed,
        handle: (await activeHandle(tx, account.id)) ?? "",
        created: false,
      };
    }
    if (!options.allowNew(profile.login.toLowerCase())) return null;
    const account = parsedBody(
      Account,
      {
        id: options.newAccountId,
        githubUserId: profile.githubUserId,
        login: profile.login,
        displayName: profile.displayName,
        githubCreatedAt: profile.githubCreatedAt,
        plan: options.plan ?? "free",
        status: "active",
        createdAt: options.now,
      },
      "account",
    );
    const base = profile.login.toLowerCase();
    const near = await tx.query<{ handle: string }>(
      "SELECT handle FROM handles WHERE handle LIKE $1",
      [`${base.slice(0, 30)}%`],
    );
    const taken = new Set(near.map((row) => row.handle));
    const chosen = handleFor(profile.login, (h) => taken.has(h));
    if (!chosen.ok) return null;
    const handle = parsedBody(
      Handle,
      {
        handle: chosen.value,
        accountId: account.id,
        state: "active",
        redirectTo: null,
        createdAt: options.now,
      },
      "handle",
    );
    await tx.query("INSERT INTO accounts (id, github_user_id, body) VALUES ($1, $2, $3::jsonb)", [
      account.id,
      account.githubUserId,
      asJson(account),
    ]);
    await tx.query("INSERT INTO handles (handle, account_id, body) VALUES ($1, $2, $3::jsonb)", [
      handle.handle,
      account.id,
      asJson(handle),
    ]);
    await appendAudit(tx, {
      id: randomUUID(),
      actor: "author",
      action: "account.create",
      target: { entity: "account", id: account.id },
      outcome: "allowed",
      createdAt: options.now,
    });
    return { account, handle: handle.handle, created: true };
  });
}

/** The account's stored avatar, replaced (ADR-0013). */
export async function saveAvatar(
  db: Db,
  accountId: string,
  avatar: NonNullable<Account["avatar"]>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.query<{ body: unknown }>(
      "SELECT body FROM accounts WHERE id = $1 FOR UPDATE",
      [accountId],
    );
    if (rows[0] === undefined) return;
    const account = parsedBody(
      Account,
      { ...parsedBody(Account, rows[0].body, "account"), avatar },
      "account",
    );
    await tx.query("UPDATE accounts SET body = $2::jsonb WHERE id = $1", [
      accountId,
      asJson(account),
    ]);
  });
}

/**
 * The image type of the avatar with this hash while an active account shows it, so it may be
 * served; null otherwise. The type is the one checked by magic bytes when it was stored.
 */
export async function avatarInUse(db: Queryable, sha256: string): Promise<string | null> {
  const rows = await db.query<{ body: unknown }>(
    "SELECT body FROM accounts WHERE body -> 'avatar' ->> 'sha256' = $1 AND body ->> 'status' = 'active' LIMIT 1",
    [sha256],
  );
  return rows[0] === undefined
    ? null
    : (parsedBody(Account, rows[0].body, "account").avatar?.contentType ?? null);
}

export async function accountById(db: Queryable, id: string): Promise<Account | null> {
  const rows = await db.query<{ body: unknown }>("SELECT body FROM accounts WHERE id = $1", [id]);
  return rows[0] === undefined ? null : parsedBody(Account, rows[0].body, "account");
}

/** The account's current handle, if it has one. */
export async function activeHandle(db: Queryable, accountId: string): Promise<string | null> {
  const rows = await db.query<{ handle: string }>(
    "SELECT handle FROM handles WHERE account_id = $1 AND body->>'state' = 'active' ORDER BY handle LIMIT 1",
    [accountId],
  );
  return rows[0]?.handle ?? null;
}

const MAX_CHAIN = 16;

/** What /<name> resolves to (Contract §9), following redirects through the database. */
export async function resolveHandle(db: Queryable, name: string): Promise<HandleLookup> {
  const chain = new Map<string, HandleRecord>();
  let next: string | null = name;
  while (next !== null && chain.size < MAX_CHAIN && !chain.has(next)) {
    const rows: { body: unknown }[] = await db.query("SELECT body FROM handles WHERE handle = $1", [
      next,
    ]);
    if (rows[0] === undefined) break;
    const record: HandleRecord = parsedBody(Handle, rows[0].body, "handle");
    chain.set(record.handle, record);
    next = record.state === "redirect" ? record.redirectTo : null;
  }
  return lookupHandle(chain, name);
}
