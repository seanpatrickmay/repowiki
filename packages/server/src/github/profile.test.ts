import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WikiExport, WikiExport as WikiExportSchema } from "@repowiki/core";
import { makePeopleSnapshot } from "@repowiki/core/test-fixtures";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseExports, LocalProfile, loadProfile, takeProfile } from "./profile.ts";

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
