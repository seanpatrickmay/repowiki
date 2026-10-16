import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WikiExport, WikiExport as WikiExportSchema } from "@repowiki/core";
import { makePeopleSnapshot } from "@repowiki/core/test-fixtures";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chooseExports,
  LocalProfile,
  loadAvatar,
  loadProfile,
  takeAvatar,
  takeProfile,
} from "./profile.ts";

const API = "https://api.github.com";
const EXPORT_HEAD = "e".repeat(40);
const TOOL_HEAD = "1".repeat(40);
const NOTES_HEAD = "2".repeat(40);
const sha = (i: number) => i.toString(16).padStart(40, "a");

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name.length * 1000 + name.charCodeAt(0),
  name,
  full_name: `ada/${name}`,
  owner: { login: "ada" },
  private: false,
  fork: false,
  default_branch: "main",
  size: 10,
  description: null,
  html_url: `https://github.com/ada/${name}`,
  clone_url: `https://github.com/ada/${name}.git`,
  stargazers_count: 3,
  ...extra,
});

/** A made-up GitHub user `ada` with a fork, a repository with local exports and one without. */
function adaFetch(seen: Headers[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    seen.push(new Headers(init?.headers));
    const path = url.pathname;
    if (path === "/users/ada") {
      return Response.json({
        id: 77,
        login: "ada",
        name: "Ada Lovelace",
        created_at: "2015-01-01T00:00:00Z",
        bio: "ignored",
      });
    }
    if (path === "/users/ada/repos") {
      if (url.searchParams.get("page") !== "1") return Response.json([]);
      return Response.json([
        repo("Ada-Tool"),
        repo("forked", { fork: true }),
        repo("notes", { default_branch: "trunk" }),
      ]);
    }
    if (path === "/repos/ada/Ada-Tool/commits") {
      expect(url.searchParams.get("author")).toBe("ada");
      const perPage = Number(url.searchParams.get("per_page"));
      if (perPage === 1) {
        return Response.json([{ sha: sha(0) }], {
          headers: {
            link: `<${API}${path}?per_page=1&page=2>; rel="next", <${API}${path}?per_page=1&page=250>; rel="last"`,
          },
        });
      }
      return Response.json(Array.from({ length: 150 }, (_, i) => ({ sha: sha(i) })));
    }
    if (path === "/repos/ada/notes/commits") {
      return Response.json([{ sha: sha(1) }, { sha: sha(2) }, { sha: sha(3) }]);
    }
    if (path === "/repos/ada/Ada-Tool/commits/main") return Response.json({ sha: TOOL_HEAD });
    if (path === "/repos/ada/notes/commits/trunk") return Response.json({ sha: NOTES_HEAD });
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
}

function withPeople(exp: WikiExport): WikiExport {
  return WikiExportSchema.parse({
    ...exp,
    people: { snapshot: makePeopleSnapshot({ sha: exp.head }), pages: [] },
  });
}

let dir: string;
const writeExport = (name: string, exp: unknown) => {
  mkdirSync(join(dir, name), { recursive: true });
  const path = join(dir, name, "export.json");
  writeFileSync(path, JSON.stringify(exp));
  return path;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "profile-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("chooseExports", () => {
  it("prefers the export with People, then the one with more pages, by repository name", () => {
    const base = fixtureExport();
    const many = { ...base, repo: "ada-tool" };
    const kept = base.pages.slice(0, 3);
    const fewer = withPeople({
      ...base,
      repo: "Ada-Tool",
      pages: kept,
      history: Object.fromEntries(kept.map((p) => [p.featureId, base.history[p.featureId] ?? []])),
      architecture: [],
    });
    writeExport("ada-tool-old", many);
    const chosen = writeExport("ada-tool", fewer);
    writeExport("broken", { repo: "notes" });
    mkdirSync(join(dir, "no-export"));
    const choice = chooseExports(dir);
    expect([...choice.keys()]).toEqual(["ada-tool"]);
    expect(choice.get("ada-tool")).toMatchObject({ path: chosen, pages: 3, people: true });

    const morePages = writeExport("ada-tool-new", withPeople({ ...many }));
    expect(chooseExports(dir).get("ada-tool")).toMatchObject({
      path: morePages,
      pages: base.pages.length,
      people: true,
    });
  });

  it("is empty for a directory that does not exist", () => {
    expect(chooseExports(join(dir, "missing")).size).toBe(0);
  });
});

describe("takeProfile", () => {
  it("snapshots the user's own public repositories and maps each to its best export", async () => {
    const exp = withPeople({ ...fixtureExport(), repo: "Ada-Tool", head: EXPORT_HEAD });
    const people = writeExport("ada-tool", exp);
    writeExport("ada-tool-old", { ...fixtureExport(), repo: "ada-tool" });
    const seen: Headers[] = [];
    const profile = await takeProfile({ login: "ada", fetch: adaFetch(seen), exportsDir: dir });

    expect(LocalProfile.parse(profile)).toEqual(profile);
    expect(profile.user).toEqual({
      id: 77,
      login: "ada",
      name: "Ada Lovelace",
      created_at: "2015-01-01T00:00:00Z",
    });
    expect(profile.repos.map((r) => r.repo.name)).toEqual(["Ada-Tool", "notes"]);
    const [tool, notes] = profile.repos;
    expect(tool?.repo.permissions).toMatchObject({ admin: true, push: true, pull: true });
    expect(tool).toMatchObject({
      commits: 250,
      head: EXPORT_HEAD,
      githubHead: TOOL_HEAD,
      export: people,
    });
    expect(tool?.commitShas).toHaveLength(100);
    expect(notes).toMatchObject({
      commits: 3,
      head: NOTES_HEAD,
      githubHead: NOTES_HEAD,
      export: null,
    });
    expect(seen.every((h) => h.get("authorization") === null)).toBe(true);
  });

  it("sends the token when there is one", async () => {
    const seen: Headers[] = [];
    await takeProfile({ login: "ada", fetch: adaFetch(seen), token: "t0k", exportsDir: dir });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h.get("authorization") === "Bearer t0k")).toBe(true);
  });

  it("refuses a user GitHub does not know", async () => {
    await expect(
      takeProfile({ login: "nobody", fetch: adaFetch([]), exportsDir: dir }),
    ).rejects.toThrow(/nobody/);
  });
});

describe("the snapshot's technology files (ADR-0014)", () => {
  const TEXT: Record<string, string> = {
    "package.json": '{"dependencies":{"react":"18"}}',
    "web/package.json": '{"devDependencies":{"vite":"5"}}',
    "liar/requirements.txt": "x".repeat(70_000),
  };
  const tree = [
    { path: "package.json", type: "blob", size: 31 },
    { path: "web", type: "tree" },
    { path: "web/package.json", type: "blob", size: 32 },
    { path: "node_modules/x/package.json", type: "blob", size: 10 },
    { path: ".github/workflows/ci.yml", type: "blob", size: 10 },
    { path: "src/a.ts", type: "blob", size: 10 },
    { path: "big/requirements.txt", type: "blob", size: 70_000 },
    { path: "liar/requirements.txt", type: "blob", size: 10 },
    ...Array.from({ length: 40 }, (_, i) => ({ path: `p/${i}/Cargo.toml`, type: "blob", size: 9 })),
    ...Array.from({ length: 600 }, (_, i) => ({ path: `tf/${i}.tf`, type: "blob", size: 9 })),
    { path: "deploy/Dockerfile", type: "blob", size: 9 },
  ];
  const asked: string[] = [];
  const withTree: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const treePath = `/repos/ada/Ada-Tool/git/trees/${EXPORT_HEAD}`;
    if (url.pathname === treePath) {
      expect(url.searchParams.get("recursive")).toBe("1");
      return Response.json({ sha: EXPORT_HEAD, tree, truncated: false });
    }
    const contents = "/repos/ada/Ada-Tool/contents/";
    if (url.pathname.startsWith(contents)) {
      const path = decodeURIComponent(url.pathname.slice(contents.length));
      asked.push(path);
      expect(url.searchParams.get("ref")).toBe(EXPORT_HEAD);
      expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.github.raw");
      return new Response(TEXT[path] ?? "[dependencies]\nserde = '1'\n");
    }
    return adaFetch([])(input, init);
  };

  it("keeps, at the export's head, the technology paths and at most 30 small files", async () => {
    writeExport("ada-tool", { ...fixtureExport(), repo: "Ada-Tool", head: EXPORT_HEAD });
    const profile = await takeProfile({ login: "ada", fetch: withTree, exportsDir: dir });
    const [tool, notes] = profile.repos;
    const technology = tool?.technology;
    expect(technology?.paths).toHaveLength(500);
    expect(technology?.paths.slice(0, 3)).toEqual([
      "package.json",
      "web/package.json",
      ".github/workflows/ci.yml",
    ]);
    expect(technology?.paths).not.toContain("node_modules/x/package.json");
    expect(technology?.paths).not.toContain("src/a.ts");
    // The first path of every rule survives the cut at 500 (review M7).
    expect(technology?.paths).toContain("deploy/Dockerfile");
    expect(technology?.files).toHaveLength(29);
    expect(technology?.files[0]).toEqual({ path: "package.json", text: TEXT["package.json"] });
    // Too big by the tree's size is never asked for; too big when it arrives is dropped.
    expect(asked).not.toContain("big/requirements.txt");
    expect(asked).toHaveLength(30);
    expect(technology?.files.map((f) => f.path)).not.toContain("liar/requirements.txt");
    expect(notes?.technology).toBeUndefined();
  });

  it("goes on without the files when GitHub will not list the tree", async () => {
    writeExport("ada-tool", { ...fixtureExport(), repo: "Ada-Tool", head: EXPORT_HEAD });
    const profile = await takeProfile({ login: "ada", fetch: adaFetch([]), exportsDir: dir });
    expect(profile.repos[0]?.technology).toBeUndefined();
  });

  it("refuses a snapshot holding more than 30 files", () => {
    const files = Array.from({ length: 31 }, (_, i) => ({ path: `${i}/package.json`, text: "{}" }));
    const repoEntry = {
      repo: { ...repo("Ada-Tool"), permissions: { admin: true, push: true, pull: true } },
      commits: 0,
      commitShas: [],
      head: EXPORT_HEAD,
      githubHead: null,
      export: "/x/export.json",
      technology: { paths: [], files },
    };
    const user = { id: 77, login: "ada", name: null, created_at: "2015-01-01T00:00:00Z" };
    const snapshot = { takenAt: "2026-10-15T00:00:00.000Z", user, repos: [repoEntry] };
    expect(LocalProfile.safeParse(snapshot).success).toBe(false);
    expect(
      LocalProfile.safeParse({
        ...snapshot,
        repos: [{ ...repoEntry, technology: { paths: [], files: [] } }],
      }).success,
    ).toBe(true);
  });

  it("warns, naming the repository and GITHUB_TOKEN, when GitHub limits the rate (review M7)", async () => {
    writeExport("ada-tool", { ...fixtureExport(), repo: "Ada-Tool", head: EXPORT_HEAD });
    for (const status of [403, 429]) {
      const warnings: string[] = [];
      const limited: typeof fetch = async (input, init) =>
        new URL(String(input)).pathname.includes("/git/trees/")
          ? Response.json({ message: "rate limited" }, { status })
          : withTree(input, init);
      const profile = await takeProfile({
        login: "ada",
        fetch: limited,
        exportsDir: dir,
        warn: (line) => warnings.push(line),
      });
      expect(profile.repos[0]?.technology).toBeUndefined();
      expect(warnings).toEqual([expect.stringMatching(/ada\/Ada-Tool.*GITHUB_TOKEN/)]);
    }
  });

  it("warns when GitHub truncates the tree, and keeps what it sent", async () => {
    writeExport("ada-tool", { ...fixtureExport(), repo: "Ada-Tool", head: EXPORT_HEAD });
    const warnings: string[] = [];
    const truncated: typeof fetch = async (input, init) =>
      new URL(String(input)).pathname.includes("/git/trees/")
        ? Response.json({ sha: EXPORT_HEAD, tree: tree.slice(0, 2), truncated: true })
        : withTree(input, init);
    const profile = await takeProfile({
      login: "ada",
      fetch: truncated,
      exportsDir: dir,
      warn: (line) => warnings.push(line),
    });
    expect(profile.repos[0]?.technology?.paths).toEqual(["package.json"]);
    expect(warnings).toEqual([expect.stringMatching(/truncated ada\/Ada-Tool/)]);
  });
});

describe("loadProfile", () => {
  it("reads a saved snapshot and refuses one that does not parse", async () => {
    const profile = await takeProfile({ login: "ada", fetch: adaFetch([]), exportsDir: dir });
    const path = join(dir, "ada.json");
    writeFileSync(path, JSON.stringify(profile));
    expect(loadProfile(path)).toEqual(profile);
    writeFileSync(path, JSON.stringify({ ...profile, extra: 1 }));
    expect(() => loadProfile(path)).toThrow();
  });
});

describe("the snapshot's avatar (ADR-0013)", () => {
  const AVATAR = "https://avatars.githubusercontent.com/u/77?v=4";
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);
  /** GitHub as `adaFetch` has it, with an avatar URL on the user and the avatar host answering. */
  const withAvatar: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === AVATAR) return new Response(PNG);
    const reply = await adaFetch([])(input, init);
    if (!url.endsWith("/users/ada")) return reply;
    return Response.json({ ...(await reply.json()), avatar_url: AVATAR });
  };

  it("keeps the avatar's URL, and its bytes beside the snapshot", async () => {
    const profile = await takeProfile({ login: "ada", fetch: withAvatar, exportsDir: dir });
    expect(profile.user.avatar_url).toBe(AVATAR);
    const bytes = await takeAvatar(profile, withAvatar);
    expect(bytes).toEqual(PNG);
    const path = join(dir, "ada.json");
    writeFileSync(path, JSON.stringify(profile));
    expect(loadAvatar(path)).toBeNull();
    writeFileSync(`${path}.avatar`, bytes ?? new Uint8Array());
    expect(loadAvatar(path)).toEqual(PNG);
    // Only an image is kept.
    writeFileSync(`${path}.avatar`, "<svg/>");
    expect(loadAvatar(path)).toBeNull();
  });

  it("has no avatar when GitHub names none", async () => {
    const profile = await takeProfile({ login: "ada", fetch: adaFetch([]), exportsDir: dir });
    expect(await takeAvatar(profile, withAvatar)).toBeNull();
  });
});
