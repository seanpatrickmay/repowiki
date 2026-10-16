import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GitSha, WikiExport } from "@repowiki/core";
import { sourcePaths, technologyPaths } from "@repowiki/hosted";
import { z } from "zod";
import { GitHubError, GitHubRepo, GitHubUser, githubApi } from "./api.ts";
import { avatarSource, avatarType, fetchAvatar } from "./avatar.ts";
import { GITHUB } from "./endpoints.ts";

const MAX_SHAS = 100;
const MAX_REPO_PAGES = 10;
const OWNER = { admin: true, maintain: true, push: true, triage: true, pull: true };
/** What a snapshot keeps of each tree for detection (ADR-0014). */
export const SNAPSHOT_PATHS = 500;
export const SNAPSHOT_FILES = 30;
export const SNAPSHOT_FILE_BYTES = 64 * 1024;

const GitTree = z.object({
  tree: z.array(
    z.object({ path: z.string(), type: z.string(), size: z.int().nonnegative().optional() }),
  ),
});

/**
 * A snapshot of one GitHub user's public repositories for local testing (M14g), beside the
 * local wiki export each one maps to. It lives outside the repository.
 */
export const LocalProfile = z.strictObject({
  takenAt: z.iso.datetime(),
  user: z.strictObject({
    id: z.int().positive(),
    login: z.string().min(1).max(39),
    name: z.string().nullable(),
    created_at: z.iso.datetime({ offset: true }),
    /** GitHub's avatar URL; its bytes are saved beside the snapshot (ADR-0013). */
    avatar_url: z.string().max(500).optional(),
  }),
  repos: z.array(
    z.strictObject({
      repo: GitHubRepo,
      /** Commits authored by the user, capped at 1000 (`countCommits`). */
      commits: z.int().nonnegative(),
      commitShas: z.array(GitSha).max(MAX_SHAS),
      /** The export's head when one is mapped, else the default branch's; null when neither. */
      head: GitSha.nullable(),
      githubHead: GitSha.nullable(),
      /** Absolute path of the mapped export.json. */
      export: z.string().min(1).nullable(),
      /**
       * The tree's technology paths and its manifest and compose files at `head`, for the import
       * worker's detection (ADR-0014); only with an export, and absent from older snapshots.
       */
      technology: z
        .strictObject({
          paths: z.array(z.string().min(1).max(1000)).max(SNAPSHOT_PATHS),
          files: z
            .array(
              z.strictObject({
                path: z.string().min(1).max(1000),
                text: z.string().max(SNAPSHOT_FILE_BYTES),
              }),
            )
            .max(SNAPSHOT_FILES),
        })
        .optional(),
    }),
  ),
});
export type LocalProfile = z.infer<typeof LocalProfile>;

export interface ExportChoice {
  path: string;
  pages: number;
  people: boolean;
  head: string;
}

/** Whether `a` is the better export for one repository: People first, then more pages. */
const better = (a: ExportChoice, b: ExportChoice) =>
  a.people !== b.people ? a.people : a.pages > b.pages;

/**
 * The best `<dir>/<name>/export.json` for each repository, keyed by the export's `repo`
 * lowercased. Files that do not parse as a wiki export are skipped.
 */
export function chooseExports(dir: string): Map<string, ExportChoice> {
  const chosen = new Map<string, ExportChoice>();
  if (!existsSync(dir)) return chosen;
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const path = join(dir, name, "export.json");
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const parsed = WikiExport.safeParse(raw);
    if (!parsed.success) continue;
    const exp = parsed.data;
    const choice = { path, pages: exp.pages.length, people: exp.people !== null, head: exp.head };
    const key = exp.repo.toLowerCase();
    const current = chosen.get(key);
    if (current === undefined || better(choice, current)) chosen.set(key, choice);
  }
  return chosen;
}

export interface TakeProfileOptions {
  login: string;
  fetch: typeof fetch;
  /** Sent as a bearer token when set; the snapshot works unauthenticated within GitHub's limit. */
  token?: string;
  exportsDir: string;
  api?: string;
  now?: () => Date;
}

/** Reads `login`'s public, non-fork repositories from GitHub's REST API (the script only). */
export async function takeProfile(options: TakeProfileOptions): Promise<LocalProfile> {
  const api = options.api ?? GITHUB.api;
  const token = options.token ?? "";
  // githubApi always sends a bearer token; send the real one, or none for an anonymous snapshot.
  const authed: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    else headers.delete("authorization");
    return options.fetch(input, { ...init, headers });
  };
  const gh = githubApi(authed, { web: GITHUB.web, api });

  async function read<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
    const response = await authed(`${api}${path}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "RepoWiki" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new GitHubError(`GitHub answered ${response.status} for ${path}`);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new GitHubError(`GitHub sent something unexpected for ${path}`);
    return parsed.data;
  }

  const login = encodeURIComponent(options.login);
  const user = await read(`/users/${login}`, GitHubUser);
  if (user === null) throw new GitHubError(`GitHub has no user ${options.login}`);

  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const batch = await read(
      `/users/${login}/repos?type=owner&sort=pushed&per_page=100&page=${page}`,
      z.array(GitHubRepo),
    );
    if (batch === null) break;
    repos.push(...batch.filter((repo) => !repo.fork && !repo.private));
    if (batch.length < 100) break;
  }

  /**
   * The technology paths and files of `fullName` at `sha`: the git-tree API, recursive, then the
   * contents API, raw, for at most SNAPSHOT_FILES files of at most SNAPSHOT_FILE_BYTES each,
   * shallowest first. Undefined when GitHub will not list the tree; a file it will not give is
   * left out.
   */
  async function technologyOf(fullName: string, sha: string) {
    const repoPath = fullName.split("/").map(encodeURIComponent).join("/");
    let listed: z.infer<typeof GitTree> | null;
    try {
      listed = await read(`/repos/${repoPath}/git/trees/${sha}?recursive=1`, GitTree);
    } catch {
      return undefined;
    }
    if (listed === null) return undefined;
    const blobs = listed.tree.filter((e) => e.type === "blob");
    const size = new Map(blobs.map((b) => [b.path, b.size ?? 0]));
    const all = blobs.map((b) => b.path);
    const wanted = sourcePaths(
      all.filter((p) => (size.get(p) ?? 0) <= SNAPSHOT_FILE_BYTES),
      SNAPSHOT_FILES,
    );
    const files: { path: string; text: string }[] = [];
    for (const path of wanted) {
      const file = path.split("/").map(encodeURIComponent).join("/");
      const response = await authed(`${api}/repos/${repoPath}/contents/${file}?ref=${sha}`, {
        headers: { accept: "application/vnd.github.raw", "user-agent": "RepoWiki" },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (response === null || !response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > SNAPSHOT_FILE_BYTES) continue;
      files.push({ path, text: new TextDecoder().decode(bytes) });
    }
    return { paths: technologyPaths(all).slice(0, SNAPSHOT_PATHS), files };
  }

  const exports = chooseExports(options.exportsDir);
  const entries: LocalProfile["repos"] = [];
  for (const repo of repos) {
    const mapped = exports.get(repo.name.toLowerCase());
    const githubHead = await gh.headSha(token, repo.full_name, repo.default_branch);
    const technology =
      mapped === undefined ? undefined : await technologyOf(repo.full_name, mapped.head);
    entries.push({
      repo: { ...repo, permissions: OWNER },
      commits: await gh.countCommits(token, repo.full_name, user.login),
      commitShas: await gh.commitShas(token, repo.full_name, user.login, MAX_SHAS),
      head: mapped?.head ?? githubHead,
      githubHead,
      export: mapped?.path ?? null,
      ...(technology === undefined ? {} : { technology }),
    });
  }
  const now = options.now ?? (() => new Date());
  return LocalProfile.parse({ takenAt: now().toISOString(), user, repos: entries });
}

/** The snapshot at `path`, parsed. */
export function loadProfile(path: string): LocalProfile {
  return LocalProfile.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** The user's avatar for the snapshot, checked as sign-in checks it; null when there is none. */
export async function takeAvatar(
  profile: LocalProfile,
  fetchFn: typeof fetch,
): Promise<Uint8Array | null> {
  const source = avatarSource(profile.user.avatar_url);
  return source === null ? null : ((await fetchAvatar(fetchFn, source))?.bytes ?? null);
}

/** Where the avatar of the snapshot at `path` is saved. */
export const avatarFileOf = (path: string) => `${path}.avatar`;

/** The avatar saved beside the snapshot at `path`, when there is one and it is an image. */
export function loadAvatar(path: string): Uint8Array | null {
  const file = avatarFileOf(path);
  if (!existsSync(file)) return null;
  const bytes = new Uint8Array(readFileSync(file));
  return avatarType(bytes) === null ? null : bytes;
}
