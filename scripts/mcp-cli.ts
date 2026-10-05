import { parseArgs } from "node:util";
import { CliError } from "./manifest-cli.ts";

export const SERVE_USAGE =
  "usage: node scripts/mcp-serve.ts <repo-path> [--out dir] [--compare-to rev] [--help]";

export interface ServeArgs {
  repo: string | null;
  out: string | null;
  compareTo: string | null;
  help: boolean;
}

/** One value of a flag given at most once. */
function single(name: string, values: readonly string[] | undefined): string | null {
  if (values === undefined) return null;
  if (values.length > 1) throw new CliError(`${name} was given more than once; ${SERVE_USAGE}`);
  const [value = ""] = values;
  if (value === "") throw new CliError(`${name} needs a value; ${SERVE_USAGE}`);
  return value;
}

/** `<repo> [--out dir] [--compare-to rev]`, or `--help` alone; every other usage is a CliError. */
export function parseServeArgs(argv: readonly string[]): ServeArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new CliError(`${(error as Error).message.split("\n")[0]}; ${SERVE_USAGE}`, {
      cause: error,
    });
  }
  const { values, positionals } = parsed;
  const help = values.help?.some(Boolean) === true;
  if (positionals.length > 1) throw new CliError(SERVE_USAGE);
  const [repo = null] = positionals;
  if (!help && (repo === null || repo === "")) throw new CliError(SERVE_USAGE);
  return {
    repo,
    out: single("--out", values.out),
    compareTo: single("--compare-to", values["compare-to"]),
    help,
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: "string", multiple: true },
      "compare-to": { type: "string", multiple: true },
      help: { type: "boolean", short: "h", multiple: true },
    },
  });
}

/** A shell word: as it is when it needs no quoting, else in single quotes. */
const shellWord = (word: string) =>
  /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;

/**
 * --help's text: the usage and the one line that registers the server with Claude Code for a
 * repository, with absolute paths filled in (spec v2 #5 §2, R15). RepoWiki never runs it.
 */
export function registrationHelp(script: string, repo: string | null, out: string | null): string {
  const target = repo ?? "/abs/path/to/repo";
  const args = [script, target, ...(out === null ? [] : ["--out", out])].map(shellWord).join(" ");
  return [
    SERVE_USAGE,
    "",
    "Serves the RepoWiki wiki of one repository to an MCP client over stdio: six read-only tools, no LLM calls, no writes.",
    "Register it with Claude Code for that repository (run this yourself; RepoWiki writes no client config):",
    "",
    `  claude mcp add --scope local repowiki -- node ${args}`,
    "",
    "The client launches it with node, not pnpm: pnpm prints a banner on stdout, which would corrupt the protocol.",
    "",
  ].join("\n");
}

/**
 * The server's own environment, made safe before anything else runs (spec v2 #5 R5, R6): no API
 * key, so not even an accidental provider could authenticate, and GIT_OPTIONAL_LOCKS=0 for every
 * git it starts (the engine's scrubbed environment copies it).
 */
export function prepareEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith("ANTHROPIC_")) delete env[name];
  }
  env.GIT_OPTIONAL_LOCKS = "0";
}
