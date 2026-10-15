import { describe, expect, it } from "vitest";
import { ApiError, workerApi } from "./api.ts";

const TOKEN = "t".repeat(43);
const SPEC = {
  jobId: "00000000-0000-4000-8000-000000000001",
  attempt: 1,
  kind: "generate",
  commitSha: "a".repeat(40),
  repo: {
    fullName: "demo-dev/demo-repo",
    name: "demo-repo",
    cloneUrl: "https://github.com/demo-dev/demo-repo.git",
    sizeKb: 120,
  },
  author: { login: "demo-dev", githubUserId: 4242, commitShas: ["b".repeat(40)] },
  limits: { maxIndexedFiles: 1000 },
  llmUrl: "http://repowiki.internal:8787/llm",
};

function fake(status = 200, body: unknown = SPEC) {
  const calls: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  return { fetchFn, calls };
}

describe("the worker's API client (spec 2 §6)", () => {
  it("leases with the bearer token and parses the spec", async () => {
    const { fetchFn, calls } = fake();
    const api = workerApi("http://repowiki.internal:8787", TOKEN, fetchFn);
    expect(await api.lease()).toEqual(SPEC);
    expect(calls[0]).toMatchObject({
      url: "http://repowiki.internal:8787/internal/job/lease",
      method: "POST",
      body: undefined,
    });
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a lease reply that is not a job spec", async () => {
    const { fetchFn } = fake(200, { jobId: "x" });
    await expect(workerApi("http://s", TOKEN, fetchFn).lease()).rejects.toThrow();
  });

  it("refuses a repository name that is not one directory name", async () => {
    for (const name of [".", "..", "a/b", ""]) {
      const { fetchFn } = fake(200, { ...SPEC, repo: { ...SPEC.repo, name } });
      await expect(workerApi("http://s", TOKEN, fetchFn).lease()).rejects.toThrow();
    }
  });

  it("reports a repository the server found too large instead of throwing", async () => {
    const { fetchFn, calls } = fake(422, { code: "repo-too-large" });
    expect(await workerApi("http://s", TOKEN, fetchFn).indexed(5000)).toBe("too-large");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ indexedFiles: 5000 });
  });

  it("throws ApiError with the status, and never the token, for any other refusal", async () => {
    const { fetchFn } = fake(401, { error: "no" });
    const error = await workerApi("http://s", TOKEN, fetchFn)
      .heartbeat("index")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401 });
    expect(String((error as Error).message)).not.toContain(TOKEN);
    const { fetchFn: conflict } = fake(409, { error: "invalid-transition" });
    await expect(workerApi("http://s", TOKEN, conflict).indexed(3)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("uploads the export as JSON bytes and fails with a code", async () => {
    const { fetchFn, calls } = fake(204);
    const api = workerApi("http://s", TOKEN, fetchFn);
    await api.putExport(new TextEncoder().encode("{}"));
    await api.heartbeat("write");
    await api.fail("job-cost-cap");
    expect(calls.map((c) => [c.method, c.url, c.headers.get("content-type")])).toEqual([
      ["PUT", "http://s/internal/job/export", "application/json"],
      ["POST", "http://s/internal/job/heartbeat", "application/json"],
      ["POST", "http://s/internal/job/fail", "application/json"],
    ]);
    expect(await new Response(calls[0]?.body as BodyInit).text()).toBe("{}");
    expect(JSON.parse(String(calls[1]?.body))).toEqual({ step: "write" });
    expect(JSON.parse(String(calls[2]?.body))).toEqual({ code: "job-cost-cap" });
  });
});
