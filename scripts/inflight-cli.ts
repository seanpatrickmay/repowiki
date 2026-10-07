import { parseArgs } from "node:util";
import type { GitHubSnapshot, InFlight, InFlightPull, WikiExport } from "@repowiki/core";
import type { HeadState, Suggest, SummaryEstimate, SummaryStatus } from "@repowiki/engine";
import type { LedgerTotals } from "@repowiki/llm";
import { ABOUT_PAGE_ID, pageSearchIndex, WikiView } from "@repowiki/query";
import { CliError } from "./manifest-cli.ts";
import { badOption, cell, count, deadlineMinutes, once, problemLine } from "./wiki-cli.ts";

export const INFLIGHT_USAGE =
  "usage: pnpm wiki:inflight <repo-path> [--out dir] [--github owner/name] [--offline] [--no-llm] [--max-usd N] [--dry-run] [--no-batch] [--deadline minutes] [--config file.json] [--clear] [--verbose]";

/** No summary is requested once the next one could pass this, unless --max-usd says otherwise. */
export const DEFAULT_INFLIGHT_USD = 1;
/** The highest --max-usd: a typo of a few zeros must not lift the budget stop. */
const MAX_INFLIGHT_USD = 100;

export interface InflightArgs {
  repo: string;
  out: string | null;
  /** `--github owner/name`, validated by resolveGitHubIdentity; null reads the origin remote. */
  github: string | null;
  /** No gh and no fetch: re-derive from the stored snapshot and inflight.git; implies no call. */
  offline: boolean;
  /** Summaries only from the cache. */
  noLlm: boolean;
  maxUsd: number;
  dryRun: boolean;
  batch: boolean;
  deadlineMinutes: number | null;
  config: string | null;
  /** Delete the stored snapshot, the summary cache and inflight.git, and nothing else. */
  clear: boolean;
  verbose: boolean;
}

const fail = (problem: string) => new CliError(`${problem}; ${INFLIGHT_USAGE}`);

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: "string", multiple: true },
      github: { type: "string", multiple: true },
      offline: { type: "boolean", multiple: true },
      "no-llm": { type: "boolean", multiple: true },
      "max-usd": { type: "string", multiple: true },
      "dry-run": { type: "boolean", multiple: true },
      "no-batch": { type: "boolean", multiple: true },
      deadline: { type: "string", multiple: true },
      config: { type: "string", multiple: true },
      clear: { type: "boolean", multiple: true },
      verbose: { type: "boolean", multiple: true },
    },
  });
}

/**
 * `<repo>` plus spec v2 #9 §6.1's flags in any order, by wiki:build's rules: a repeated or empty
 * flag, an unknown one or a missing or extra positional is a usage error (exit 2). --max-usd is
 * eval:run's rule with a $1 default. --offline reads no GitHub, so --github goes with it only as
 * an error; --clear takes only --out and --verbose.
 */
export function parseInflightArgs(argv: readonly string[]): InflightArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    throw badOption(err, INFLIGHT_USAGE);
  }
  const v = parsed.values;
  const [repo, ...extra] = parsed.positionals;
  if (repo === undefined || extra.length > 0) throw new CliError(INFLIGHT_USAGE);
  if (repo === "") throw fail("<repo-path> must not be empty");
  const usdText = once("--max-usd", v["max-usd"], INFLIGHT_USAGE);
  const maxUsd = Number(usdText ?? DEFAULT_INFLIGHT_USD);
  if (
    usdText !== undefined &&
    (!/^\d+(\.\d+)?$/.test(usdText) || !(maxUsd > 0 && maxUsd <= MAX_INFLIGHT_USD))
  ) {
    throw fail(`--max-usd must be a number of dollars above 0 and up to ${MAX_INFLIGHT_USD}`);
  }
  const args: InflightArgs = {
    repo,
    out: once("--out", v.out, INFLIGHT_USAGE) ?? null,
    github: once("--github", v.github, INFLIGHT_USAGE) ?? null,
    offline: once("--offline", v.offline, INFLIGHT_USAGE) ?? false,
    noLlm: once("--no-llm", v["no-llm"], INFLIGHT_USAGE) ?? false,
    maxUsd,
    dryRun: once("--dry-run", v["dry-run"], INFLIGHT_USAGE) ?? false,
    batch: !once("--no-batch", v["no-batch"], INFLIGHT_USAGE),
    deadlineMinutes: deadlineMinutes(
      once("--deadline", v.deadline, INFLIGHT_USAGE),
      INFLIGHT_USAGE,
    ),
    config: once("--config", v.config, INFLIGHT_USAGE) ?? null,
    clear: once("--clear", v.clear, INFLIGHT_USAGE) ?? false,
    verbose: once("--verbose", v.verbose, INFLIGHT_USAGE) ?? false,
  };
  if (args.offline && args.github !== null)
    throw fail("--offline reads no GitHub, so it takes no --github");
  const others = Object.keys(v).filter(
    (flag) => flag !== "out" && flag !== "verbose" && flag !== "clear",
  );
  if (args.clear && others.length > 0)
    throw fail(`--clear takes only --out and --verbose, not --${others[0]}`);
  return args;
}

const money = (usd: number): string => `$${usd.toFixed(4)}`;
const plural = (n: number, one: string, many = `${one}s`): string =>
  `${count(n)} ${n === 1 ? one : many}`;

/** What was read from GitHub, on one line: the repository, the counts, R19's caps and drops. */
export function readLine(snapshot: GitHubSnapshot): string {
  const { owner, name } = snapshot.repo;
  const parts = [
    `${owner}/${name}: ${plural(snapshot.pulls.length, "open pull request")}, ${plural(snapshot.issues.length, "open issue")}`,
  ];
  const { pulls, issues } = snapshot.omitted;
  if (pulls + issues > 0)
    parts.push(
      `${count(pulls)} more pull requests and ${count(issues)} more issues not read (the caps)`,
    );
  if (snapshot.dropped > 0)
    parts.push(`${plural(snapshot.dropped, "malformed entry", "malformed entries")} dropped`);
  if (snapshot.droppedPaths > 0)
    parts.push(`${plural(snapshot.droppedPaths, "unsafe file path")} dropped`);
  return parts.join("; ");
}

/**
 * The run's spend line: the new summaries, and what every call of the run cost by its ledger rows,
 * failed calls and answers that verified to nothing included.
 */
export function spendLine(newSummaries: number, spent: LedgerTotals): string {
  const calls = spent.calls > 0 ? ` for ${plural(spent.calls, "call")}` : "";
  return `${plural(newSummaries, "new summary", "new summaries")}, ${money(spent.usd)}${calls}`;
}

/** How the pull-request heads stand after the fetch, and its first error line, redacted. */
export function fetchLine(heads: ReadonlyMap<number, HeadState>, problem: string | null): string {
  const n = (state: HeadState) => [...heads.values()].filter((h) => h === state).length;
  const line = `pull-request heads: ${count(n("fetched"))} fetched, ${count(n("missing"))} missing, ${count(n("moved"))} moved since GitHub was read`;
  return problem === null ? line : `${line}; the fetch said: ${problemLine(problem)}`;
}

/** spec v2 #9 §7.3's line, printed before any call; a dry run stops after it. */
export function inflightEstimateLine(
  estimate: SummaryEstimate,
  args: Pick<InflightArgs, "maxUsd" | "batch">,
): string {
  const due = Math.max(0, estimate.requests - estimate.cached);
  return `${plural(estimate.requests, "pull-request summary", "pull-request summaries")} (${count(estimate.cached)} cached, ${count(due)} to request): about ${money(estimate.typicalUsd)}${args.batch ? " (batched)" : ""} assuming 700 output tokens each and no cache hits, at most ${money(estimate.ceilingUsd)} if every answer takes 1,500; no summary is requested beyond ${money(args.maxUsd)} (--max-usd)`;
}

/**
 * The estimate line when the inflight model has no price and no call can happen this run
 * (--offline, --no-llm, the update hook): what is due, and that it is not estimated or asked.
 */
export function unpricedEstimateLine(
  estimate: { requests: number; cached: number },
  model: string,
): string {
  const due = Math.max(0, estimate.requests - estimate.cached);
  return `${plural(estimate.requests, "pull-request summary", "pull-request summaries")} (${count(estimate.cached)} cached, ${count(due)} to request): no estimate, since the inflight role's model ${model} has no known price; none is requested this run`;
}

/**
 * wiki:build's line when the store holds a snapshot its new export leaves out (it disagrees with
 * the rebuilt pages); null otherwise. The build stays as v1: it re-derives nothing.
 */
export function inflightLeftOutLine(
  stored: InFlight | null,
  wiki: Pick<WikiExport, "inflight">,
): string | null {
  return stored !== null && wiki.inflight === null
    ? "work in flight left out: rebuilt at a new revision; run wiki:inflight --offline"
    : null;
}

/** A pull request's predicted effect on the pages: certain stale claims, then the uncertain ones. */
function effectCell(pull: InFlight["pulls"][number]): string {
  if (pull.head !== "fetched") return `not computed (head ${pull.head})`;
  const certain = pull.effects.filter((e) => e.certain).length;
  const uncertain = pull.effects.length - certain;
  return uncertain === 0 ? count(certain) : `${count(certain)} (+${count(uncertain)} may change)`;
}

/** The summary table (spec v2 #9 §6.1): every GitHub text through cell(), failures after it. */
export function renderInflightTable(
  inflight: InFlight,
  status: ReadonlyMap<number, SummaryStatus>,
  failures: ReadonlyMap<number, string>,
): string {
  if (inflight.pulls.length === 0) return "No open pull requests.";
  const lines = [
    "| Pull request | Features touched | Claims it would make stale | Summary |",
    "|---|---|---|---|",
    ...inflight.pulls.map((pull) => {
      const features =
        pull.features.length === 0
          ? "none"
          : pull.features.map((f) => cell(f.featureId)).join(", ");
      return `| ${cell(`#${pull.number} ${pull.title}`)} | ${features} | ${effectCell(pull)} | ${status.get(pull.number) ?? "none"} |`;
    }),
    ...inflight.pulls.flatMap((pull) => {
      const why = behindLine(pull);
      return why === null ? [] : [`#${pull.number}: ${why}`];
    }),
    ...[...failures].map(([n, why]) => `#${n}: no summary this run: ${problemLine(why)}`),
  ];
  return lines.join("\n");
}

/** R27's one line for why the wiki cannot predict a pull request exactly, or null. */
function behindLine(pull: InFlightPull): string | null {
  switch (pull.behind) {
    case null:
      return null;
    case "stacked":
      return `targets ${cell(pull.baseRef)}, which the wiki does not describe; its predictions are may-change until ${cell(pull.baseRef)} merges`;
    case "base-unread":
      return "its base could not be read this run; run pnpm wiki:inflight again";
    case "wiki-behind":
      return `the wiki is behind this pull request's base (${(pull.baseSha ?? "").slice(0, 7)}); run pnpm wiki:update for exact predictions`;
  }
}

/**
 * How many pages issue search asks for: three, so that with the About article left out the
 * caller still has the best page and the runner-up to weigh.
 */
const SUGGEST_PAGES = 3;

/**
 * Issue mapping's page search (C3): query's BM25F page search over the export, the About
 * article left out, each match with its score.
 */
export function suggestFor(wiki: WikiExport): Suggest {
  const index = pageSearchIndex(new WikiView(wiki));
  return (text) =>
    index
      .ranked(text, SUGGEST_PAGES)
      .filter((match) => match.id !== ABOUT_PAGE_ID)
      .map((match) => ({ featureId: match.id, score: match.score }));
}
