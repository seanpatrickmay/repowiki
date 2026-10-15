import { seal, unseal } from "../crypto.ts";
import type { Queryable } from "../db/db.ts";

/** Keep the account's GitHub token, encrypted and bound to the account (spec 2 S7). */
export async function saveGitHubToken(
  tx: Queryable,
  key: Buffer,
  accountId: string,
  token: string,
): Promise<void> {
  const sealed = seal(key, token, accountId);
  await tx.query(
    `INSERT INTO github_tokens (account_id, ciphertext, nonce) VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce`,
    [accountId, sealed.ciphertext, sealed.nonce],
  );
}

/** The account's GitHub token, or null when none is stored or it does not decrypt. */
export async function readGitHubToken(
  db: Queryable,
  key: Buffer,
  accountId: string,
): Promise<string | null> {
  const rows = await db.query<{ ciphertext: Uint8Array; nonce: Uint8Array }>(
    "SELECT ciphertext, nonce FROM github_tokens WHERE account_id = $1",
    [accountId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return unseal(
    key,
    { ciphertext: Buffer.from(row.ciphertext), nonce: Buffer.from(row.nonce) },
    accountId,
  );
}
