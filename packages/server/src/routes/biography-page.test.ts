import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../app.ts";
import { publishedEntries } from "./biography-page.ts";
import { publishedStub, signedInCookie, testDeps } from "./test-app.ts";

let deps: Deps;
let accountId: string;
beforeEach(async () => {
  deps = await testDeps();
  ({ accountId } = await signedInCookie(deps));
  await publishedStub(deps, accountId, "stub", 777);
});
afterEach(async () => deps.db.close());

describe("publishedEntries (ADR-0013)", () => {
  it("asks the read policy, so an owner being deleted shows nothing (review M8)", async () => {
    expect((await publishedEntries(deps, accountId)).map((p) => p.slug)).toEqual(["stub"]);
    await deps.db.query(
      "UPDATE accounts SET body = jsonb_set(body, '{status}', '\"deleting\"') WHERE id = $1",
      [accountId],
    );
    expect(await publishedEntries(deps, accountId)).toEqual([]);
  });
});
