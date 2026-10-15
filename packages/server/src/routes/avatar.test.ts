import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { SILHOUETTE_PATH } from "../pages/biography-style.ts";
import { accountById, saveAvatar } from "../store/accounts.ts";
import { avatarUrl } from "./biography-page.ts";
import { publicRoutes } from "./public.ts";
import { call, signedInCookie, testDeps } from "./test-app.ts";

const SHA = "c".repeat(64);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
let deps: Deps;
let pages: App;
let accountId: string;

beforeEach(async () => {
  deps = await testDeps();
  pages = createApp(deps, publicRoutes(deps), { host: "pages" });
  ({ accountId } = await signedInCookie(deps));
  await deps.objects.put(`avatars/${SHA}`, PNG, "image/png");
  const avatar = {
    sha256: SHA,
    contentType: "image/png" as const,
    source: "https://avatars.githubusercontent.com/u/1",
    fetchedAt: deps.now(),
  };
  await saveAvatar(deps.db, accountId, avatar);
});
afterEach(async () => deps.db.close());

describe("the avatar on the pages origin (ADR-0013)", () => {
  it("is served by its hash, immutable, while an active account uses it", async () => {
    const reply = await call(pages, { path: `/_app/avatar/${SHA}` });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(PNG);
    expect(reply.headers).toMatchObject({
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    expect((await call(pages, { path: `/_app/avatar/${"d".repeat(64)}` })).status).toBe(404);
    expect((await call(pages, { path: "/_app/avatar/../x" })).status).toBe(404);
    await deps.db.query(
      "UPDATE accounts SET body = jsonb_set(body, '{status}', '\"deleting\"') WHERE id = $1",
      [accountId],
    );
    expect((await call(pages, { path: `/_app/avatar/${SHA}` })).status).toBe(404);
  });

  it("is what the biography shows, or the silhouette for an account without one", async () => {
    const account = await accountById(deps.db, accountId);
    if (account === null) throw new Error("account");
    expect(avatarUrl(account)).toBe(`/_app/avatar/${SHA}`);
    const { avatar: _, ...bare } = account;
    expect(avatarUrl({ ...bare, avatar: undefined })).toBe(SILHOUETTE_PATH);
  });
});
