import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import { signIn } from "./accounts.ts";
import { readGitHubToken, saveGitHubToken } from "./github-tokens.ts";
import { freshDb } from "./test-db.ts";

const KEY = Buffer.alloc(32, 3);
const A1 = "00000000-0000-4000-8000-000000000001";
const A2 = "00000000-0000-4000-8000-000000000002";
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  for (const [id, githubUserId] of [
    [A1, 1],
    [A2, 2],
  ] as const) {
    await signIn(
      db,
      {
        githubUserId,
        login: `u${githubUserId}`,
        displayName: "U",
        githubCreatedAt: "2019-01-01T00:00:00Z",
      },
      { newAccountId: id, allowNew: () => true, now: "2026-10-14T12:00:00Z" },
    );
  }
});
afterEach(async () => db.close());

describe("stored GitHub tokens (spec 2 S7)", () => {
  it("are kept encrypted and replaced on the next sign-in", async () => {
    await db.transaction((tx) => saveGitHubToken(tx, KEY, A1, "gho_first"));
    await db.transaction((tx) => saveGitHubToken(tx, KEY, A1, "gho_second"));
    const rows = await db.query<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM github_tokens");
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]?.ciphertext ?? []).toString("utf8")).not.toContain("gho_");
    expect(await readGitHubToken(db, KEY, A1)).toBe("gho_second");
  });

  it("are absent for an account that never stored one", async () => {
    expect(await readGitHubToken(db, KEY, A2)).toBeNull();
  });

  it("do not decrypt once moved to another account's row", async () => {
    await db.transaction((tx) => saveGitHubToken(tx, KEY, A1, "gho_first"));
    await db.query("UPDATE github_tokens SET account_id = $1", [A2]);
    const quiet = () => {};
    expect(await readGitHubToken(db, KEY, A2, quiet)).toBeNull();
    expect(await readGitHubToken(db, KEY, A1, quiet)).toBeNull();
  });

  it("do not decrypt once a ciphertext byte is changed", async () => {
    await db.transaction((tx) => saveGitHubToken(tx, KEY, A1, "gho_first"));
    await db.query(
      "UPDATE github_tokens SET ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)",
    );
    expect(await readGitHubToken(db, KEY, A1)).toBeNull();
  });

  it("log a token that no longer decrypts (a rotated TOKEN_KEY), never its value", async () => {
    await db.transaction((tx) => saveGitHubToken(tx, KEY, A1, "gho_secret"));
    const lines: object[] = [];
    expect(await readGitHubToken(db, Buffer.alloc(32, 4), A1, (l) => lines.push(l))).toBeNull();
    expect(lines).toEqual([{ githubToken: "undecryptable", error: "DecryptFailed" }]);
    expect(JSON.stringify(lines)).not.toContain("gho_");
    expect(await readGitHubToken(db, KEY, A2, (l) => lines.push(l))).toBeNull();
    expect(lines).toHaveLength(1);
  });
});
