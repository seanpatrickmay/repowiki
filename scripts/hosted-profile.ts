import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { takeProfile } from "@repowiki/server";

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

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseProfileArgs(process.argv.slice(2), { home: homedir(), repoRoot });
  const token = process.env.GITHUB_TOKEN;
  const profile = await takeProfile({
    login: args.login,
    fetch,
    exportsDir: args.exports,
    ...(token ? { token } : {}),
  });
  for (const entry of profile.repos) {
    const drift =
      entry.export !== null && entry.githubHead !== null && entry.head !== entry.githubHead
        ? "  (export behind GitHub)"
        : "";
    console.log(`${entry.repo.name}  ${entry.commits}  ${entry.export ?? "none"}${drift}`);
  }
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  chmodSync(args.out, 0o600);
  console.log(`wrote ${args.out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
