import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import type { buildTree } from "../render/build.ts";
import { treeHash } from "../render/tree.ts";
import { draftRoutes } from "../routes/drafts.ts";
import { EXAMPLE_PREFIX, exampleRoutes } from "../routes/example.ts";
import { previewRoutes } from "../routes/preview.ts";
import { publishRoutes } from "../routes/publish.ts";
import { call, form, generatedProject, testDeps } from "../routes/test-app.ts";
import { previewOf } from "../store/drafts.ts";
import { exampleSnapshot, uploadExample } from "./snapshot.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A build that records what it was asked for and writes one page naming its base. */
const builds: Parameters<typeof buildTree>[0][] = [];
const fakeBuild: typeof buildTree = async (input) => {
  builds.push(input);
  const files = [
    { path: "site/index.html", bytes: encode(`<p>wiki at ${input.base}</p>`) },
    { path: "entry.json", bytes: input.entry },
  ];
  return { files, hash: treeHash(files) };
};

let deps: Deps;
let p: { projectId: string; cookie: string; csrf: string };
beforeAll(async () => {
  deps = await testDeps();
  const app: App = createApp(deps, [
    ...draftRoutes(deps),
    ...previewRoutes(deps, fakeBuild),
    ...publishRoutes(deps),
  ]);
  p = await generatedProject(deps);
  const post = (path: string, body: string) =>
    call(app, {
      method: "POST",
      path,
      headers: form(p.cookie, deps.config.appOrigin),
      body: `csrf=${p.csrf}&${body}`,
    });
  await post(`/projects/${p.projectId}/review`, "revision=1&attest=yes");
  await post(`/projects/${p.projectId}/preview`, "revision=1");
  const hash = (await previewOf(deps.db, p.projectId, 1))?.siteHash ?? "";
  const published = await post(
    `/projects/${p.projectId}/publish`,
    `revision=1&expectedVersion=0&previewHash=${hash}`,
  );
  if (published.status !== 303) throw new Error(`publish answered ${published.status}`);
  builds.length = 0;
}, 120_000);
afterAll(async () => deps.db.close());

describe("the example's snapshot (ADR-0017)", () => {
  it("renders each published wiki again at /example/<slug>/, beside the entry it was published with", async () => {
    const files = await exampleSnapshot({ ...deps, handle: "demo-dev", build: fakeBuild });
    expect(builds.map((b) => [b.base, b.repoUrl, b.author])).toEqual([
      [
        "/example/demo-repo/",
        "https://github.com/demo-dev/demo-repo",
        { name: "Demo Developer", url: "/example" },
      ],
    ]);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["demo-repo/entry.json", "demo-repo/site/index.html", "index.json"]);
    const index = JSON.parse(
      decode(files.find((f) => f.path === "index.json")?.bytes ?? encode("")),
    );
    expect(index).toMatchObject({
      person: { login: "demo-dev", displayName: "Demo Developer" },
      projects: [{ slug: "demo-repo" }],
    });
  });

  it("refuses a handle with nothing published", async () => {
    await expect(exampleSnapshot({ ...deps, handle: "nobody", build: fakeBuild })).rejects.toThrow(
      /nobody/,
    );
  });

  it("uploads under example/, the index last, removing what an older snapshot left", async () => {
    await deps.objects.put(`${EXAMPLE_PREFIX}old/site/index.html`, "stale", "text/html");
    const files = await exampleSnapshot({ ...deps, handle: "demo-dev", build: fakeBuild });
    expect(await uploadExample(deps.objects, files)).toEqual({ written: 3, removed: 1 });
    expect(await deps.objects.get(`${EXAMPLE_PREFIX}old/site/index.html`)).toBeNull();
    const app = createApp(deps, exampleRoutes(deps), { host: "pages" });
    const page = await call(app, { path: "/example" });
    expect(String(page.body)).toContain("Demo Developer");
    const wiki = await call(app, { path: "/example/demo-repo/" });
    expect(Buffer.from(wiki.body as Uint8Array).toString()).toContain(
      "wiki at /example/demo-repo/",
    );
  });

  it("refuses to upload a snapshot without a valid index", async () => {
    await expect(
      uploadExample(deps.objects, [{ path: "a/site/index.html", bytes: encode("x") }]),
    ).rejects.toThrow(/index/);
  });

  it("carries the account's stored GitHub avatar, named in the index (ADR-0013)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const sha256 = createHash("sha256").update(png).digest("hex");
    await deps.objects.put(`avatars/${sha256}`, png, "image/png");
    const avatar = {
      sha256,
      contentType: "image/png",
      source: "https://avatars.githubusercontent.com/u/1?v=4",
      fetchedAt: "2026-10-22T12:00:00.000Z",
    };
    await deps.db.query(
      "UPDATE accounts SET body = body || jsonb_build_object('avatar', $1::jsonb)",
      [JSON.stringify(avatar)],
    );
    const files = await exampleSnapshot({ ...deps, handle: "demo-dev", build: fakeBuild });
    expect(files.find((f) => f.path === "avatar.png")?.bytes).toEqual(png);
    const index = JSON.parse(
      decode(files.find((f) => f.path === "index.json")?.bytes ?? encode("")),
    );
    expect(index.person.avatar).toBe("avatar.png");
  });
});
