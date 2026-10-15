import { Account } from "@repowiki/hosted";
import { randomToken, sha256Hex } from "../crypto.ts";
import type { Db } from "../db/db.ts";
import { parsedBody } from "./rows.ts";

export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;
/** A session is extended only once its remaining life drops below this, to avoid a write per request. */
const SLIDE_BELOW_MS = (SESSION_DAYS - 1) * DAY_MS;

const plusDays = (now: string, days: number) =>
  new Date(Date.parse(now) + days * DAY_MS).toISOString();

export async function createSession(
  db: Db,
  accountId: string,
  now: string,
): Promise<{ token: string; csrf: string; expiresAt: string }> {
  const token = randomToken();
  const csrf = randomToken();
  const expiresAt = plusDays(now, SESSION_DAYS);
  await db.query(
    "INSERT INTO sessions (id_hash, account_id, csrf, expires_at) VALUES ($1, $2, $3, $4)",
    [sha256Hex(token), accountId, csrf, expiresAt],
  );
  return { token, csrf, expiresAt };
}

/** The signed-in account for a session cookie; an expired session is deleted. */
export async function readSession(
  db: Db,
  token: string,
  now: string,
): Promise<{ account: Account; csrf: string } | null> {
  const rows = await db.query<{ csrf: string; expires_at: Date; body: unknown }>(
    "SELECT s.csrf, s.expires_at, a.body FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id_hash = $1",
    [sha256Hex(token)],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const left = row.expires_at.getTime() - Date.parse(now);
  if (left <= 0) {
    await endSession(db, token);
    return null;
  }
  if (left < SLIDE_BELOW_MS) {
    await db.query("UPDATE sessions SET expires_at = $2 WHERE id_hash = $1", [
      sha256Hex(token),
      plusDays(now, SESSION_DAYS),
    ]);
  }
  return { account: parsedBody(Account, row.body, "account"), csrf: row.csrf };
}

export async function endSession(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE id_hash = $1", [sha256Hex(token)]);
}
