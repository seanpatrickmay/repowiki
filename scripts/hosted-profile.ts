import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WikiExport } from "@repowiki/core";
import { avatarFileOf, takeAvatar, takeProfile } from "@repowiki/server";
import { matchAuthor } from "@repowiki/worker";

export const PROFILE_USAGE = "usage: pnpm hosted:profile <login> [--out file] [--exports dir]";

export interface ProfileArgs {
  login: string;
  out: string;
  exports: string;
}

/** `path` with its longest existing ancestor made canonical, so a symlink cannot hide the repo. */
function canonical(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync.native(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(canonical(parent), basename(abs));
}

/** `<login>` plus `--out` and `--exports`; the snapshot never lands inside the repository. */
export function parseProfileArgs(
  argv: readonly string[],
  where: { home: string; repoRoot: string },
): ProfileArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { out: { type: "string" }, exports: { type: "string" } },
    });
  } catch {
    throw new Error(PROFILE_USAGE);
  }
  const [login, ...rest] = parsed.positionals;
  if (login === undefined || rest.length > 0) throw new Error(PROFILE_USAGE);
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error(`not a GitHub login: ${login}`);
  const { out: outFlag, exports: exportsFlag } = parsed.values;
  const out =
    typeof outFlag === "string"
      ? outFlag
      : join(where.home, ".repowiki", "hosted-local", `${login}.json`);
  const exports = typeof exportsFlag === "string" ? exportsFlag : join(where.home, ".repowiki");
  const rel = relative(canonical(where.repoRoot), canonical(out));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`refusing to write the snapshot inside the repository: ${out}`);
  }
  return { login, out, exports };
}

interface Entry {
  repo: { name: string };
  commits: number;
  export: string | null;
  head: string | null;
  githubHead: string | null;
}

/**
 * One repository of the snapshot: its commits, its export, and the People id whose numbers the
 * import worker will show as the user's (matched the worker's way), or none and why.
 */
export function repoLine(entry: Entry, user: { login: string; name: string | null }): string {
  const head = `${entry.repo.name}  ${entry.commits}  ${entry.export ?? "none"}`;
  if (entry.export === null) return head;
  const exp = WikiExport.parse(JSON.parse(readFileSync(entry.export, "utf8")));
  const snapshot = exp.people?.snapshot ?? null;
  const person = snapshot === null ? null : matchAuthor(snapshot, user);
  const names = [user.login, user.name].filter((n) => n !== null).join(" or ");
  const author =
    person !== null
      ? `author: ${person.id}`
      : snapshot === null
        ? "author: none (no People)"
        : `author: none (People does not name ${names})`;
  const drift =
    entry.githubHead !== null && entry.head !== entry.githubHead ? "  (export behind GitHub)" : "";
  return `${head}  ${author}${drift}`;
}

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseProfileArgs(process.argv.slice(2), { home: homedir(), repoRoot });
  const token = process.env.GITHUB_TOKEN;
  const profile = await takeProfile({
    login: args.login,
    fetch,
    exportsDir: args.exports,
    warn: (line) => console.error(`warning: ${line}`),
    ...(token ? { token } : {}),
  });
  for (const entry of profile.repos) console.log(repoLine(entry, profile.user));
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  chmodSync(args.out, 0o600);
  console.log(`wrote ${args.out}`);
  // The avatar beside the snapshot, so local mode shows it without reaching GitHub (ADR-0013).
  const avatar = await takeAvatar(profile, fetch);
  const avatarFile = avatarFileOf(args.out);
  rmSync(avatarFile, { force: true });
  if (avatar === null) {
    console.log("avatar: none");
  } else {
    writeFileSync(avatarFile, avatar, { mode: 0o600 });
    console.log(`wrote ${avatarFile}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
