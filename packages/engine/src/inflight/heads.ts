import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REDIRECTING_GH_ENV } from "../github/index.ts";
import { GitError, type GitOptions, isSha, scrubbedGitEnv } from "../index/index.ts";

/** The private bare repository under the out dir that holds fetched pull-request heads (R5). */
export const INFLIGHT_DIR = "inflight.git";

/**
 * What every git command in inflight.git runs with on top of scrubbedGitEnv() (C13): no system or
 * global config, so no `url.*.insteadOf`, hook, merge driver or credential helper of the user's
 * applies, and no terminal prompt.
 */
export const INFLIGHT_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** The longest one read in inflight.git takes before it is stopped (the fetch has its own). */
export const INFLIGHT_READ_TIMEOUT_MS = 2 * 60_000;

/**
 * GitOptions for the index module's reads in inflight.git: named with `--git-dir` (never found by
 * discovery), without ANTHROPIC_* variables, and stopped after INFLIGHT_READ_TIMEOUT_MS.
 */
export const INFLIGHT_GIT: GitOptions = {
  env: INFLIGHT_GIT_ENV,
  gitDir: true,
  timeoutMs: INFLIGHT_READ_TIMEOUT_MS,
};

/**
 * inflight.git's own config, set when it is created and again on every run (R5, R21): no
 * automatic gc (an object the documented repo still has must stay readable), no hooks, and no
 * attributes from any file or tree, so no merge driver or filter a pull request names can run.
 */
const REPO_CONFIG: readonly [string, string][] = [
  ["gc.auto", "0"],
  ["core.hooksPath", "/dev/null"],
  ["core.attributesFile", "/dev/null"],
  ["attr.tree", ""],
];

/** The ref a pull request's head is fetched to. */
export const pullRef = (n: number): string => `refs/repowiki/pull/${n}`;
/** The ref its base branch's tip (GitHub's baseRefOid) is fetched to, by oid (R27). */
export const baseRef = (n: number): string => `refs/repowiki/base/${n}`;

/** Where a pull request's head stands after a fetch (R6). */
export type HeadState = "fetched" | "missing" | "moved";

/** The longest fetch takes before it is stopped. */
export const FETCH_TIMEOUT_MS = 10 * 60_000;

/**
 * The environment of a command in inflight.git `dir`, without any ANTHROPIC_* variable or
 * GIT_ATTR_SOURCE (which would override `attr.tree=""`), less `unset`, and with
 * GIT_CEILING_DIRECTORIES at the out dir's parent, so no git run for it ever finds a repository
 * above the out dir.
 */
function inflightEnv(
  dir: string,
  extra: Readonly<Record<string, string>> = {},
  unset: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env = scrubbedGitEnv({
    ...INFLIGHT_GIT_ENV,
    GIT_CEILING_DIRECTORIES: dirname(dirname(dir)),
    ...extra,
  });
  for (const name of Object.keys(env)) if (name.startsWith("ANTHROPIC_")) delete env[name];
  for (const name of ["GIT_ATTR_SOURCE", ...unset]) delete env[name];
  return env;
}

/**
 * What a fetch adds (R6): gh is the only credential source, so no askpass program of the user's
 * runs (GIT_ASKPASS beats `core.askPass`, and an empty one stops git falling back to SSH_ASKPASS),
 * and ssh never prompts either; and gh's own switches (R25), since git runs the credential helper
 * `gh auth git-credential` with the fetch's environment.
 */
export const FETCH_ENV: Readonly<Record<string, string>> = {
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
};

/**
 * What a fetch drops: whatever would point the credential helper's gh elsewhere or print its
 * traffic (REDIRECTING_GH_ENV, as ghEnv drops it), TLS verification turned off, and git's curl and
 * packet traces, which can log the token git sends.
 */
const FETCH_UNSET: readonly string[] = [
  ...REDIRECTING_GH_ENV,
  "GIT_SSL_NO_VERIFY",
  "GIT_TRACE",
  "GIT_TRACE_CURL",
  "GIT_TRACE_CURL_NO_DATA",
  "GIT_TRACE_PACKET",
  "GIT_TRACE_REDACT",
  "GIT_CURL_VERBOSE",
];

/**
 * One git command in inflight.git `dir` with inflight's environment: its status and output, never
 * a throw. It names the repository with `--git-dir` (never `-C`), so a broken inflight.git is an
 * error, not a walk up to whatever repository encloses the out dir. It is stopped after
 * `timeoutMs`, by default INFLIGHT_READ_TIMEOUT_MS.
 */
export function inflightGit(
  dir: string,
  args: readonly string[],
  options: {
    timeoutMs?: number;
    input?: string;
    env?: Readonly<Record<string, string>>;
    unset?: readonly string[];
  } = {},
): { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const limit = options.timeoutMs ?? INFLIGHT_READ_TIMEOUT_MS;
  const out = spawnSync("git", [`--git-dir=${dir}`, ...args], {
    env: inflightEnv(dir, options.env, options.unset),
    encoding: "utf8",
    maxBuffer: 1 << 30,
    timeout: limit,
    input: options.input,
  });
  if (out.error !== undefined) {
    const timedOut = (out.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      status: null,
      stdout: "",
      stderr: timedOut
        ? `git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""} timed out after ${limit / 1000} s`
        : `could not run git: ${out.error.message}`,
      timedOut,
    };
  }
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, timedOut: false };
}

/** Whether `dir` is a bare repository git itself accepts, asked with `--git-dir`. */
function isBareRepository(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const out = inflightGit(dir, ["rev-parse", "--is-bare-repository"]);
  return out.status === 0 && out.stdout.trim() === "true";
}

/** git's first message line, for one terminal line (the caller redacts it, R25). */
export const firstLine = (stderr: string): string =>
  stderr
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? "no message";

/** The documented repository's object directory, absolute, for inflight.git's alternates. */
function objectDirectory(repo: string): string {
  const out = spawnSync(
    "git",
    ["-C", repo, "rev-parse", "--path-format=absolute", "--git-path", "objects"],
    { env: scrubbedGitEnv(), encoding: "utf8" },
  );
  const path = out.stdout?.trim() ?? "";
  if (out.status !== 0 || path === "")
    throw new GitError(`cannot find the object directory of ${repo}`);
  return path;
}

/**
 * Creates `<out>/inflight.git` when it is missing (R5): bare, from an empty template, with
 * REPO_CONFIG, and an alternates file naming the documented repository's objects, so a fetch
 * downloads only the objects the pull requests add and the documented repository is only read.
 * An existing one gets its config and alternates set again (the documented repository may have
 * moved); one git does not accept as a bare repository (a delete cut short) is made again.
 * Returns its path.
 */
export function ensureInflightRepo(out: string, repo: string): string {
  const dir = join(out, INFLIGHT_DIR);
  if (existsSync(dir) && !isBareRepository(dir)) rmSync(dir, { recursive: true, force: true });
  if (!existsSync(dir)) {
    mkdirSync(out, { recursive: true });
    const init = spawnSync("git", ["init", "--bare", "--quiet", "--template=", dir], {
      env: inflightEnv(dir),
      encoding: "utf8",
    });
    if (init.status !== 0 || !isBareRepository(dir))
      throw new GitError(`cannot create ${dir}: ${firstLine(init.stderr ?? "")}`);
  }
  for (const [key, value] of REPO_CONFIG) {
    const set = inflightGit(dir, ["config", key, value]);
    if (set.status !== 0) throw new GitError(`cannot configure ${dir}: ${firstLine(set.stderr)}`);
  }
  mkdirSync(join(dir, "objects", "info"), { recursive: true });
  writeFileSync(join(dir, "objects", "info", "alternates"), `${objectDirectory(repo)}\n`);
  return dir;
}

/** Deletes inflight.git, for a rebuild after a missing object (R5). */
export function removeInflightRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** The fetch URL, built from the validated identity, never read from config (R6). */
export const githubFetchUrl = (identity: { owner: string; name: string }): string =>
  `https://github.com/${identity.owner}/${identity.name}.git`;

/** The commit a pull request's ref names in inflight.git, or null when it has none. */
function refSha(dir: string, n: number): string | null {
  const out = inflightGit(dir, ["rev-parse", "--verify", "--quiet", `${pullRef(n)}^{commit}`]);
  const sha = out.stdout.trim();
  return out.status === 0 && isSha(sha) ? sha : null;
}

export interface FetchOptions {
  /**
   * The one transport the fetch may use. "https" always, except fetch tests, which pass "file"
   * for a fixture remote or "http" for a local server; the CLI never does (spec v2 #9 §9).
   */
  protocol?: "https" | "file" | "http";
  timeoutMs?: number;
}

/**
 * Why a fetch failed, on one line, and whether it is a missing remote ref: a closed pull request's
 * head, or a base oid the remote no longer serves ("not our ref", a force-pushed branch).
 */
interface FetchFailure {
  line: string;
  missingRef: boolean;
}

/** One fetch of `refspecs` from `url` into inflight.git, hardened (R6); null, or why it failed. */
function fetch(
  dir: string,
  url: string,
  refspecs: readonly string[],
  options: FetchOptions,
): FetchFailure | null {
  const protocol = options.protocol ?? "https";
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const out = inflightGit(
    dir,
    [
      "-c",
      "protocol.allow=never",
      "-c",
      `protocol.${protocol}.allow=always`,
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "-c",
      "core.hooksPath=/dev/null",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--prune",
      "--end-of-options",
      url,
      ...refspecs,
    ],
    { timeoutMs, env: FETCH_ENV, unset: FETCH_UNSET },
  );
  if (out.status === 0) return null;
  if (out.timedOut)
    return { line: `git fetch timed out after ${timeoutMs / 1000} s`, missingRef: false };
  return {
    line: firstLine(out.stderr),
    missingRef: /couldn't find remote ref|not our ref/i.test(out.stderr),
  };
}

/** What fetchHeads did: each pull request's head, and the first fetch error, if any. */
export interface FetchedHeads {
  heads: Map<number, HeadState>;
  problem: string | null;
}

/**
 * Fetches every pull request's `refs/pull/<n>/head` into `refs/repowiki/pull/<n>`, and each base
 * oid GitHub reported into `refs/repowiki/base/<n>` (R27), in one call (R6); when that call fails
 * on a missing remote ref (a pull request closed since GitHub was read, or a base the remote no
 * longer serves, makes the whole fetch fail), each ref is fetched on its own, until one fails for
 * another reason. Any other failure (a timeout, an auth or network failure) ends the step with its
 * one line: no fetch is retried after it. A
 * head whose fetched commit differs from `headRefOid` is fetched once more, then `moved`; one that
 * could not be fetched is `missing`; a base that could not be fetched is simply not there. Refs of
 * pull requests no longer listed are deleted.
 */
export function fetchHeads(
  dir: string,
  url: string,
  pulls: readonly { number: number; headRefOid: string; baseRefOid?: string | null }[],
  options: FetchOptions = {},
): FetchedHeads {
  const spec = (n: number) => `+refs/pull/${n}/head:${pullRef(n)}`;
  const specs = pulls.flatMap((p) => [
    spec(p.number),
    ...(p.baseRefOid != null && isSha(p.baseRefOid)
      ? [`+${p.baseRefOid}:${baseRef(p.number)}`]
      : []),
  ]);
  let failure = pulls.length === 0 ? null : fetch(dir, url, specs, options);
  if (failure?.missingRef === true) {
    for (const one of specs) {
      const single = fetch(dir, url, [one], options);
      if (single !== null && !single.missingRef) {
        failure = single;
        break;
      }
    }
  }
  if (failure === null || failure.missingRef) {
    for (const p of pulls) {
      const sha = refSha(dir, p.number);
      if (sha !== null && sha !== p.headRefOid) fetch(dir, url, [spec(p.number)], options);
    }
  }
  const pruned = pruneHeadRefs(dir, pulls);
  return { heads: headStates(dir, pulls), problem: failure?.line ?? pruned };
}

/**
 * Each pull request's head as inflight.git holds it now, with no network (the offline re-derive):
 * `fetched` when its ref names `headRefOid`, `moved` when it names another commit, `missing` when
 * there is no ref or no inflight.git.
 */
export function headStates(
  dir: string,
  pulls: readonly { number: number; headRefOid: string }[],
): Map<number, HeadState> {
  const there = existsSync(join(dir, "HEAD"));
  return new Map(
    pulls.map((p) => {
      const sha = there ? refSha(dir, p.number) : null;
      return [p.number, sha === null ? "missing" : sha === p.headRefOid ? "fetched" : "moved"];
    }),
  );
}

/**
 * Deletes the head and base refs of pull requests that are not listed (closed or merged since);
 * null, or why it could not.
 */
function pruneHeadRefs(dir: string, pulls: readonly { number: number }[]): string | null {
  const keep = new Set(pulls.flatMap((p) => [pullRef(p.number), baseRef(p.number)]));
  const refs = inflightGit(dir, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/repowiki/pull/",
    "refs/repowiki/base/",
  ]);
  const stale = refs.stdout.split("\n").filter((ref) => ref !== "" && !keep.has(ref));
  if (stale.length === 0) return null;
  const deleted = inflightGit(dir, ["update-ref", "--stdin"], {
    input: stale.map((ref) => `delete ${ref}\n`).join(""),
  });
  return deleted.status === 0
    ? null
    : `could not delete the refs of closed pull requests: ${firstLine(deleted.stderr)}`;
}

/**
 * Whether a git failure says an object is missing or corrupt: inflight.git lost an object it
 * borrowed from the documented repository (R5), or a partial clone lacks one (C13). Only git's
 * object messages count, never "could not read Username" (an auth failure) or a ref name that is
 * not valid (a missing ref).
 */
export function isMissingObject(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /bad object|missing (?:blob|tree|commit|object)|unable to read (?:tree|blob|commit|object|[0-9a-f]{7,})|is corrupt|not a valid (?:object|commit) name [0-9a-f]{4,}\b|could not fetch [0-9a-f]+ from promisor|object [0-9a-f]+ is missing|invalid object/i.test(
    text,
  );
}
