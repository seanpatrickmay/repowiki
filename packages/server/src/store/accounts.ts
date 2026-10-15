import { randomUUID } from "node:crypto";
import {
  Account,
  Handle,
  type HandleLookup,
  type HandleRecord,
  handleFor,
  lookupHandle,
  type Plan,
} from "@repowiki/hosted";
import { type Db, isUniqueViolation, type Queryable } from "../db/db.ts";
import { appendAudit } from "./audit.ts";
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
 * the user is new and not allowed to sign up. Two concurrent first sign-ins make one account.
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
      const refreshed: Account = {
        ...account,
        login: profile.login,
        displayName: profile.displayName,
      };
      await tx.query("UPDATE accounts SET body = $2::jsonb WHERE id = $1", [
        account.id,
        asJson(parsedBody(Account, refreshed, "account")),
      ]);
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
