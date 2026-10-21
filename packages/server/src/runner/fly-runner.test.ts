import { describe, expect, it } from "vitest";
import { FLY_API, flyRunner } from "./fly-runner.ts";

function fake(status = 200, created: unknown = { id: "e784079b449483", state: "created" }) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const body = status === 200 ? created : { error: "no capacity" };
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchFn, calls };
}

const options = {
  apiToken: "fly-secret",
  app: "repowiki-workers",
  image: "registry.fly.io/repowiki-workers:deployment-1",
  internalUrl: "http://repowiki.internal:8788",
  engineVersion: "abc1234",
};

describe("the Fly runner (spec 2 S16)", () => {
  it("creates one auto-destroying machine with only the job's environment", async () => {
    const { fetchFn, calls } = fake();
    await flyRunner({ ...options, fetch: fetchFn }).start({
      jobId: "j1",
      attempt: 2,
      token: "job-token",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${FLY_API}/apps/repowiki-workers/machines`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer fly-secret");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.config).toMatchObject({
      image: options.image,
      auto_destroy: true,
      restart: { policy: "no" },
      metadata: { repowiki_job: "j1", repowiki_attempt: "2" },
    });
    expect(body.config.env).toEqual({
      REPOWIKI_API_URL: "http://repowiki.internal:8788",
      REPOWIKI_JOB_TOKEN: "job-token",
      REPOWIKI_WORKER_MODE: "engine",
      REPOWIKI_ENGINE_VERSION: "abc1234",
    });
    expect(JSON.stringify(body)).not.toContain("fly-secret");
  });

  it("asks for dedicated CPUs, which a shared machine throttles to a fraction of a core", async () => {
    // On a throttled shared-cpu-2x the People step's blame ran 32 minutes and hit its 120 s
    // per-file limit on 3 files; on performance-2x it takes minutes and never does.
    const { fetchFn, calls } = fake();
    await flyRunner({ ...options, fetch: fetchFn }).start({ jobId: "j1", attempt: 1, token: "t" });
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.config.guest).toEqual({ cpu_kind: "performance", cpus: 2, memory_mb: 4096 });
  });

  it("logs the created machine's id with the job, never a token", async () => {
    const lines: object[] = [];
    const log = (line: object) => lines.push(line);
    const { fetchFn } = fake();
    const runner = flyRunner({ ...options, fetch: fetchFn, log });
    await runner.start({ jobId: "j1", attempt: 2, token: "job-token" });
    expect(lines).toEqual([{ machine: "e784079b449483", job: "j1", attempt: 2 }]);
    // An id it cannot read is logged as null rather than echoed.
    const odd = fake(200, { id: "x\ny" });
    await flyRunner({ ...options, fetch: odd.fetchFn, log }).start({
      jobId: "j2",
      attempt: 1,
      token: "job-token",
    });
    expect(lines[1]).toEqual({ machine: null, job: "j2", attempt: 1 });
    expect(JSON.stringify(lines)).not.toMatch(/job-token|fly-secret/);
  });

  it("throws when Fly refuses, without echoing the token", async () => {
    const { fetchFn } = fake(422);
    const start = flyRunner({ ...options, fetch: fetchFn }).start({
      jobId: "j1",
      attempt: 1,
      token: "job-token",
    });
    await expect(start).rejects.toThrow("Fly refused the worker machine: HTTP 422");
    await expect(start).rejects.not.toThrow(/job-token|fly-secret/);
  });
});
