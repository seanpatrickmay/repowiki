import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { HttpError } from "../http/body.ts";
import { revokeTokens } from "../store/jobs.ts";
import { heldJob } from "./job-token.ts";
import { startedJob, testDeps } from "./test-app.ts";

let deps: Deps;
let job: { jobId: string; token: string };

beforeEach(async () => {
  deps = await testDeps();
  job = await startedJob(deps);
});
afterEach(async () => deps.db.close());

describe("heldJob (spec 2 §6)", () => {
  it("refuses a token revoked while it waited for the job's lock", async () => {
    // Staged by hand (PGlite runs one transaction at a time): the sweeper revokes the token
    // after heldJob's unlocked token read and before its locked job read returns.
    await deps.db.transaction(async (tx) => {
      const racing: Queryable = {
        ...tx,
        query: async (sql, params) => {
          if (sql.includes("FROM jobs") && sql.includes("FOR UPDATE")) {
            await revokeTokens(tx, job.jobId);
          }
          return tx.query(sql, params);
        },
      };
      const held = heldJob(racing, job.token, true);
      await expect(held).rejects.toBeInstanceOf(HttpError);
      await expect(held).rejects.toMatchObject({ status: 401 });
    });
  });
});
