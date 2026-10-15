import { randomToken, safeEqual, sha256Hex } from "../crypto.ts";
import type { Queryable } from "../db/db.ts";

/** How long a preview link works (ADR-0012): long enough to review, gone the same day. */
export const PREVIEW_TOKEN_MS = 3_600_000;
/** 32 bytes, base64url: what `randomToken` makes. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A new link to one revision's preview; expired links are deleted first. Returns the token. */
export async function mintPreviewToken(
  q: Queryable,
  target: { projectId: string; revision: number },
  now: string,
): Promise<string> {
  await q.query("DELETE FROM preview_tokens WHERE expires_at <= $1", [now]);
  const token = randomToken();
  const expiresAt = new Date(Date.parse(now) + PREVIEW_TOKEN_MS).toISOString();
  await q.query(
    "INSERT INTO preview_tokens (token_hash, project_id, revision, expires_at) VALUES ($1, $2, $3, $4)",
    [sha256Hex(token), target.projectId, target.revision, expiresAt],
  );
  return token;
}

/**
 * The revision a live token opens, or null. The lookup is by the token's hash; the stored hash
 * is compared again in constant time, so nothing about it depends on how a guess differs.
 */
export async function previewByToken(
  q: Queryable,
  token: string,
  now: string,
): Promise<{ projectId: string; revision: number } | null> {
  if (!TOKEN.test(token)) return null;
  const hash = sha256Hex(token);
  const rows = await q.query<{
    token_hash: string;
    project_id: string;
    revision: number;
    expires_at: Date;
  }>(
    "SELECT token_hash, project_id, revision, expires_at FROM preview_tokens WHERE token_hash = $1",
    [hash],
  );
  const row = rows[0];
  if (row === undefined || !safeEqual(row.token_hash, hash)) return null;
  if (row.expires_at.getTime() <= Date.parse(now)) return null;
  return { projectId: row.project_id, revision: row.revision };
}
