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

export const PROBE_USAGE = "usage: pnpm mcp:probe <repo-path> [--out dir]";

/** `<repo> [--out dir]`; every other usage is a CliError. */
export function parseProbeArgs(argv: readonly string[]): { repo: string; out: string | null } {
  let parsed: ReturnType<
    typeof parseArgs<{
      allowPositionals: true;
      options: { out: { type: "string"; multiple: true } };
    }>
  >;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { out: { type: "string", multiple: true } },
    });
  } catch (error) {
    throw new CliError(`${(error as Error).message.split("\n")[0]}; ${PROBE_USAGE}`, {
      cause: error,
    });
  }
  const [repo, ...extra] = parsed.positionals;
  if (repo === undefined || repo === "" || extra.length > 0) throw new CliError(PROBE_USAGE);
  const out = parsed.values.out;
  if (out !== undefined && (out.length > 1 || out[0] === ""))
    throw new CliError(`--out takes one value; ${PROBE_USAGE}`);
  return { repo, out: out?.[0] ?? null };
}

/** The probe's searches: generic words that most repositories' wikis answer. */
export const PROBE_QUERIES = ["how does it start", "configuration", "tests"] as const;

/** One probed call: its time, its result's size in code points, and whether it was an error. */
export interface ProbeRow {
  call: string;
  ms: number;
  codePoints: number | null;
  isError: boolean | null;
}

/** What the probe needs of a client: McpClient's calls. */
export interface ProbeClient {
  listTools(): Promise<unknown[]>;
  callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }>;
}

/**
 * pnpm mcp:probe's fixed list of calls (spec v2 #5 §6.1): the start to the initialize reply,
 * tools/list, list_pages, three searches, read_page of the first result, cited_code of its
 * reference 1, read_page as of its first revision's date, and page_changes of it. No LLM.
 */
export async function runProbe(
  connect: () => Promise<ProbeClient>,
  now: () => number = () => performance.now(),
): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  let at = now();
  const client = await connect();
  rows.push({ call: "start to initialize", ms: now() - at, codePoints: null, isError: null });
  at = now();
  const tools = await client.listTools();
  rows.push({
    call: "tools/list",
    ms: now() - at,
    codePoints: [...JSON.stringify(tools)].length,
    isError: false,
  });
  const call = async (label: string, name: string, args: unknown) => {
    const start = now();
    const out = await client.callTool(name, args);
    rows.push({
      call: label,
      ms: now() - start,
      codePoints: [...out.text].length,
      isError: out.isError,
    });
    return out.text;
  };
  const listed = await call("list_pages", "list_pages", {});
  // The first feature page a result names (a feature id; not special:about, which has no history).
  const pageId = (text: string) => /^- ([a-z0-9]+(?:-[a-z0-9]+)*): /m.exec(text)?.[1] ?? null;
  let id: string | null = null;
  for (const query of PROBE_QUERIES) {
    const found = await call(`search ${JSON.stringify(query)}`, "search", { query });
    id ??= pageId(found);
  }
  id ??= pageId(listed);
  if (id === null) return rows;
  const page = await call(`read_page ${id}`, "read_page", { id });
  await call(`cited_code ${id} 1`, "cited_code", { id, ref: 1 });
  const first = /Page history, oldest first: (\d{4}-\d{2}-\d{2})/.exec(page)?.[1];
  if (first !== undefined)
    await call(`read_page ${id} as_of ${first}`, "read_page", { id, as_of: first });
  await call(`page_changes ${id}`, "page_changes", { id });
  return rows;
}

/** The probe's report: one row per call, then the slowest call and the largest result. */
export function probeReport(rows: readonly ProbeRow[], cap: number): string {
  const lines = ["      ms  code points  error  call"];
  for (const r of rows) {
    const size = r.codePoints === null ? "-" : r.codePoints.toLocaleString("en-US");
    const error = r.isError === null ? "-" : r.isError ? "yes" : "no";
    lines.push(
      `${Math.round(r.ms).toString().padStart(8)}  ${size.padStart(11)}  ${error.padStart(5)}  ${r.call}`,
    );
  }
  const calls = rows.filter((r) => r.isError !== null && r.call !== "tools/list");
  const slowest = calls.reduce<ProbeRow | null>(
    (a, r) => (a === null || r.ms > a.ms ? r : a),
    null,
  );
  const largest = calls.reduce((n, r) => Math.max(n, r.codePoints ?? 0), 0);
  lines.push(
    "",
    `slowest tool call: ${slowest === null ? "-" : `${Math.round(slowest.ms)} ms (${slowest.call})`}; largest result: ${largest.toLocaleString("en-US")} code points (the cap is ${cap.toLocaleString("en-US")}); errors: ${calls.filter((r) => r.isError).length}`,
  );
  return `${lines.join("\n")}\n`;
}
