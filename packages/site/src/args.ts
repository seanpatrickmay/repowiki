import { dirname, resolve } from "node:path";
import { resolveExportFile } from "./load.ts";

export interface SiteArgs {
  command: "build" | "preview";
  /** Absolute path of the export JSON file (null only for `preview --out`). */
  exportFile: string | null;
  /** Absolute output directory of the built site. */
  outDir: string;
  /** Web URL of the documented repo (GitHub-style), or null to leave citations unlinked. */
  repoUrl: string | null;
}

export class UsageError extends Error {
  override name = "UsageError";
}

export const USAGE =
  "usage: site build --export <file|dir> [--out <dir>] [--repo-url <https-url>]\n" +
  "       site preview (--export <file|dir> | --out <dir>)";

const FLAGS = new Set(["--export", "--out", "--repo-url"]);

/** Parses `build|preview` plus flags. The default --out is a `site` directory next to the export. */
export function parseSiteArgs(argv: readonly string[]): SiteArgs {
  const [command, ...rest] = argv;
  if (command !== "build" && command !== "preview") throw new UsageError(USAGE);
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
  const outDir = resolve(outFlag ?? resolve(dirname(exportFile ?? ""), "site"));
  return { command, exportFile, outDir, repoUrl: parseRepoUrl(flags.get("--repo-url")) };
}

function parseRepoUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`--repo-url must be an absolute http(s) URL, got ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`--repo-url must be an absolute http(s) URL, got ${value}`);
  }
  return url.href.replace(/\/+$/, "");
}
