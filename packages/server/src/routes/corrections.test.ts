import { fixtureExport } from "@repowiki/site/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { recordingRunner, type StartRequest } from "../runner/runner.ts";
import { generationsOf } from "../store/drafts.ts";
import { jobSpec, jobsOf } from "../store/jobs.ts";
import { correctionRoutes } from "./corrections.ts";
import { draftRoutes } from "./drafts.ts";
import { call, form, generatedProject, otherCookie, testDeps } from "./test-app.ts";

// Each test builds a project through the internal API on PGlite: seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const NOTE = "It caps each chunk, not the whole run.";
let deps: Deps;
let app: App;
let started: StartRequest[];
let owner: Awaited<ReturnType<typeof generatedProject>>;
beforeEach(async () => {
  const recording = recordingRunner();
  started = recording.started;
  deps = await testDeps({ runner: recording.runner });
  owner = await generatedProject(deps);
  app = createApp(deps, [...correctionRoutes(deps), ...draftRoutes(deps)]);
});
afterEach(async () => deps.db.close());

const exp = fixtureExport();
const [first] = exp.pages;
const page = first?.featureId ?? "";
const claimIds = first?.sections.flatMap((s) => s.claims.map((c) => c.id)) ?? [];
const base = () => `/projects/${owner.projectId}/corrections`;
const get = (path: string, cookie = owner.cookie) => call(app, { path, headers: { cookie } });
const generationId = async () => (await generationsOf(deps.db, owner.projectId))[0]?.id ?? "";
const post = async (path: string, fields: [string, string][], cookie = owner.cookie) => {
  const body = new URLSearchParams([["csrf", owner.csrf], ...fields]).toString();
  return call(app, {
    method: "POST",
    path,
    headers: form(cookie, deps.config.appOrigin),
    body,
  });
};

describe("choosing what to correct (sentence corrections spec)", () => {
  it("lists the About article and every page of the latest draft", async () => {
    const body = String((await get(base())).body);
    expect(body).toContain(`href="${base()}/about"`);
    for (const p of exp.pages) expect(body).toContain(`href="${base()}/pages/${p.featureId}"`);
  });

  it("lists an article's sentences in page order as plain text, each to tick and explain", async () => {
    const reply = await get(`${base()}/pages/${page}`);
    expect(reply.status).toBe(200);
    const body = String(reply.body);
    const positions = claimIds.map((id) => body.indexOf(`name="claim" value="${id}"`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(body).toContain(`name="note-${claimIds[0]}"`);
    expect(body).toContain('maxlength="500"');
    expect(body).not.toContain("[[");
  });

  it("shows nothing of another account's project", async () => {
    const other = await otherCookie(deps);
    expect((await get(base(), other.cookie)).status).toBe(404);
    expect((await get(`${base()}/pages/${page}`, other.cookie)).status).toBe(404);
  });
});

describe("starting a correction (sentence corrections spec)", () => {
  it("starts a correction of the ticked sentences, with their notes, and goes to the project", async () => {
    const reply = await post(`${base()}/pages/${page}`, [
      ["generation", await generationId()],
      ["claim", claimIds[0] ?? ""],
      [`note-${claimIds[0]}`, NOTE],
    ]);
    expect(reply.status).toBe(303);
    expect(reply.headers?.location).toBe(`/projects/${owner.projectId}`);
    expect(started).toHaveLength(1);
    const job = (await jobsOf(deps.db, owner.projectId)).find((j) => j.kind === "correct");
    expect(job).toBeDefined();
    expect((await jobSpec(deps.db, job?.id ?? ""))?.correction?.items).toEqual([
      { page, claimId: claimIds[0], note: NOTE },
    ]);
    const project = String((await get(`/projects/${owner.projectId}`)).body);
    expect(project).not.toContain(NOTE);
  });

  it("refuses no sentence, a sentence with no note, a long note and an unknown sentence", async () => {
    const gen = await generationId();
    const id = claimIds[0] ?? "";
    for (const fields of [
      [["generation", gen]],
      [
        ["generation", gen],
        ["claim", id],
      ],
      [
        ["generation", gen],
        ["claim", id],
        [`note-${id}`, "x".repeat(501)],
      ],
      [
        ["generation", gen],
        ["claim", "c999"],
        ["note-c999", NOTE],
      ],
    ] as [string, string][][]) {
      expect((await post(`${base()}/pages/${page}`, fields)).status).toBe(400);
    }
    expect(started).toEqual([]);
  });

  it("refuses a form written against an older draft", async () => {
    const reply = await post(`${base()}/pages/${page}`, [
      ["generation", "00000000-0000-4000-8000-00000000dead"],
      ["claim", claimIds[0] ?? ""],
      [`note-${claimIds[0]}`, NOTE],
    ]);
    expect(reply.status).toBe(409);
    expect(started).toEqual([]);
  });

  it("corrects the About article's sentences too", async () => {
    const about = exp.architecture.at(-1);
    const id = about?.sections[0]?.claims[0]?.id ?? "";
    const reply = await post(`${base()}/about`, [
      ["generation", await generationId()],
      ["claim", id],
      [`note-${id}`, NOTE],
    ]);
    expect(reply.status).toBe(303);
    const job = (await jobsOf(deps.db, owner.projectId)).find((j) => j.kind === "correct");
    expect((await jobSpec(deps.db, job?.id ?? ""))?.correction?.items[0]).toMatchObject({
      page: "@about",
      claimId: id,
    });
  });
});
