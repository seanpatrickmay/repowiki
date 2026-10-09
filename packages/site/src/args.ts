import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isBasePath } from "./base-path.ts";
import { resolveExportFile } from "./load.ts";

/**
 * `path` with every symlink resolved: the realpath of its nearest existing ancestor, then the
 * rest of it, so a directory not made yet compares like one that exists.
 */
export function realPath(path: string): string {
  let ancestor = resolve(path);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, resolve(path)));
}

export interface SiteArgs {
  command: "build" | "preview";
  /** Absolute path of the export JSON file (null only for `preview --out`). */
  exportFile: string | null;
  /** Absolute output directory of the built site. */
  outDir: string;
  /** Web URL of the documented repo (GitHub-style), or null to leave citations unlinked. */
  repoUrl: string | null;
  /** False with `build --no-inflight`: the site and its export copy carry no work in flight. */
  inflight: boolean;
  /** The path the site is served under, "/" or "/seg/.../" (`--base`, issue #610). */
  base: string;
}

export class UsageError extends Error {
  override name = "UsageError";
}

export const USAGE =
  "usage: site build --export <file|dir> [--out <dir>] [--repo-url <https-url>] [--base <path>] [--no-inflight]\n" +
  "       site preview (--export <file|dir> | --out <dir>) [--base <path>]";

const FLAGS = new Set(["--export", "--out", "--repo-url", "--base"]);

/** Parses `build|preview` plus flags. The default --out is a `site` directory next to the export. */
export function parseSiteArgs(argv: readonly string[]): SiteArgs {
  const [command, ...given] = argv;
  if (command !== "build" && command !== "preview") throw new UsageError(USAGE);
  // --no-inflight is the one flag without a value, and only build takes it.
  const noInflight = given.filter((arg) => arg === "--no-inflight").length;
  if (noInflight > 1) throw new UsageError(`--no-inflight was given more than once\n${USAGE}`);
  if (noInflight > 0 && command !== "build")
    throw new UsageError(`only build takes --no-inflight\n${USAGE}`);
  const rest = given.filter((arg) => arg !== "--no-inflight");
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? "";
    const value = rest[i + 1];
    if (!FLAGS.has(flag)) throw new UsageError(`unknown argument ${flag}\n${USAGE}`);
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value\n${USAGE}`);
    }
    flags.set(flag, value);
  }

  const exportFlag = flags.get("--export");
  const outFlag = flags.get("--out");
  if (exportFlag === undefined && (command === "build" || outFlag === undefined)) {
    throw new UsageError(`--export is required\n${USAGE}`);
  }
  const exportFile = exportFlag === undefined ? null : resolve(resolveExportFile(exportFlag));
  const defaultOut = resolve(dirname(exportFile ?? ""), "site");
  const outDir = resolve(outFlag ?? defaultOut);
  // <out>/site/ is the default site, built with the work in flight; a site to share without
  // it goes elsewhere, so one directory never holds both (R18, C11), however a symlink spells it.
  if (noInflight > 0 && realPath(outDir) === realPath(defaultOut)) {
    throw new UsageError(
      `--no-inflight refuses ${defaultOut}, the default site, built with the work in flight; choose another --out\n${USAGE}`,
    );
  }
  return {
    command,
    exportFile,
    outDir,
    repoUrl: parseRepoUrl(flags.get("--repo-url")),
    inflight: noInflight === 0,
    base: parseBase(flags.get("--base") ?? "/"),
  };
}

/**
 * Normalizes a base path to "/seg/.../" (`wiki/ncos` is `/wiki/ncos/`) and refuses anything but
 * segments of [A-Za-z0-9._~-]: no dot segment, empty segment, query, fragment, `%`, quote, space,
 * backslash or scheme. The base is spliced into HTML attributes, CSS and scripts unescaped, so
 * this is the guard against injecting markup or code through it.
 */
export function parseBase(value: string, name = "--base"): string {
  const base = `${value.startsWith("/") ? "" : "/"}${value}${value.endsWith("/") ? "" : "/"}`;
  if (value === "" || !isBasePath(base)) {
    throw new UsageError(
      `${name} must be a path of segments of letters, digits and . _ ~ - (like wiki/ncos), got ${JSON.stringify(value)}`,
    );
  }
  return base;
}

/**
 * Validates a repo web URL: absolute http(s), no credentials, no query or fragment. Trailing
 * slashes are dropped. Error messages never echo the value, which may hold a token.
 */
export function parseRepoUrl(value: string | undefined, name = "--repo-url"): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${name} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`${name} must be an absolute http(s) URL, got scheme ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UsageError(`${name} must not contain credentials (user or token before @)`);
  }
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(value)) {
    throw new UsageError(`${name} must not have a query or fragment`);
  }
  return url.href.replace(/\/+$/, "");
}
