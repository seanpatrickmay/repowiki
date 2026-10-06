import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { answerTool, askIndexes, askSystemPrompt, createAskTools } from "@repowiki/ask";
import type { WikiExport } from "@repowiki/core";
import { readPageWithHandles, WikiView } from "@repowiki/query";
import { siteMarker } from "@repowiki/site/format";
import { CliError } from "./manifest-cli.ts";
import { badOption, once, priced } from "./wiki-cli.ts";

export const WIKI_SERVE_USAGE =
  "usage: pnpm wiki:serve <repo-path> [--out dir] [--port N] [--repo-url url] [--config file.json] [--question-usd N] [--max-usd N] [--no-ask]";

/** wiki:serve's port unless --port says otherwise; site:preview's too, so one runs at a time. */
export const DEFAULT_PORT = 4321;
/** The caps of one question and one serve session (spec v2 #4 R10, C12), and their ceilings. */
export const DEFAULT_QUESTION_USD = 0.05;
export const MAX_QUESTION_USD = 1;
export const DEFAULT_SESSION_USD = 1;
export const MAX_SESSION_USD = 20;

export interface WikiServeArgs {
  repo: string;
  out: string | null;
  /** 0 asks the system for any free port (tests). */
  port: number;
  repoUrl: string | null;
  config: string | null;
  questionUsd: number;
  maxUsd: number;
  /** False with --no-ask: serve the site in routing mode only. */
  ask: boolean;
}

const fail = (problem: string) => new CliError(`${problem}; ${WIKI_SERVE_USAGE}`);

/** A flag's dollar amount in (0, max], or `fallback` when it is absent. */
function dollars(flag: string, text: string | undefined, fallback: number, max: number): number {
  if (text === undefined) return fallback;
  const usd = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || !(usd > 0 && usd <= max)) {
    throw fail(`${flag} must be a number of dollars above 0 and up to ${max}`);
  }
  return usd;
}

/** `<repo>` plus flags (spec v2 #4 §7); every usage error is a CliError. */
export function parseWikiServeArgs(argv: readonly string[]): WikiServeArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    throw badOption(err, WIKI_SERVE_USAGE);
  }
  const v = parsed.values;
  const [repo, ...extra] = parsed.positionals;
  if (repo === undefined || repo === "" || extra.length > 0) throw new CliError(WIKI_SERVE_USAGE);
  const portText = once("--port", v.port, WIKI_SERVE_USAGE) ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65_535) throw fail("--port must be a port from 0 to 65535");
  const questionUsd = dollars(
    "--question-usd",
    once("--question-usd", v["question-usd"], WIKI_SERVE_USAGE),
    DEFAULT_QUESTION_USD,
    MAX_QUESTION_USD,
  );
  const maxUsd = dollars(
    "--max-usd",
    once("--max-usd", v["max-usd"], WIKI_SERVE_USAGE),
    DEFAULT_SESSION_USD,
    MAX_SESSION_USD,
  );
  if (maxUsd < questionUsd) throw fail("--max-usd must be at least --question-usd");
  return {
    repo,
    out: once("--out", v.out, WIKI_SERVE_USAGE) ?? null,
    port,
    repoUrl: once("--repo-url", v["repo-url"], WIKI_SERVE_USAGE) ?? null,
    config: once("--config", v.config, WIKI_SERVE_USAGE) ?? null,
    questionUsd,
    maxUsd,
    ask: once("--no-ask", v["no-ask"], WIKI_SERVE_USAGE) !== true,
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: "string", multiple: true },
      port: { type: "string", multiple: true },
      "repo-url": { type: "string", multiple: true },
      config: { type: "string", multiple: true },
      "question-usd": { type: "string", multiple: true },
      "max-usd": { type: "string", multiple: true },
      "no-ask": { type: "boolean", multiple: true },
    },
  });
}

/** The site's copy of the export as a build writes it: the validated parse, pretty-printed. */
const builtExport = (wiki: WikiExport) => `${JSON.stringify(wiki, null, 2)}\n`;

/**
 * True when `siteDir` is a finished RepoWiki build of `wiki` by this site code (spec v2 #4 R16):
 * its marker names the site code's format (siteMarker; a build cut short, or one by older or newer
 * site code, has another or none), and its root copy of the export is the one a build of this
 * export writes (writeSiteRoot), byte for byte.
 */
export function siteIsCurrent(siteDir: string, wiki: WikiExport, marker = siteMarker()): boolean {
  try {
    if (readFileSync(join(siteDir, ".repowiki-site"), "utf8") !== marker) return false;
    return readFileSync(join(siteDir, "export.json"), "utf8") === builtExport(wiki);
  } catch {
    return false;
  }
}

/** Characters a token on typical text, for the typical estimate (spec v2 #4 §8). */
export const TYPICAL_CHARS_PER_TOKEN = 3.5;
/** The turn-1 pack's typical size, as measured on next-chief-of-staff (spec v2 #4 §6.2). */
export const TYPICAL_PACK_CHARS = 4500;
/** Output tokens of a tool-call turn, and of the answer turn (spec v2 #4 §8). */
export const TYPICAL_TOOL_TURN_OUTPUT = 60;
export const TYPICAL_ANSWER_OUTPUT = 350;

/**
 * What a typical question costs on this export (spec v2 #4 §8): two turns, the second after one
 * read of the export's median page in ask mode, at TYPICAL_CHARS_PER_TOKEN; a model with no price
 * is a CliError.
 */
export function typicalQuestionUsd(wiki: WikiExport, model: string): number {
  const view = new WikiView(wiki);
  const indexes = askIndexes(view);
  const tools = createAskTools(view, indexes.pages, { searched: () => {}, read: () => {} });
  const prefix =
    askSystemPrompt(wiki.repo).length +
    JSON.stringify([...tools.definitions, answerTool]).length +
    TYPICAL_PACK_CHARS;
  const pages = wiki.pages
    .filter((p) => view.features.get(p.featureId)?.status.kind === "active")
    .map((p) => [...readPageWithHandles(view, p.featureId).text].length)
    .sort((a, b) => a - b);
  const page = pages[Math.floor(pages.length / 2)] ?? 0;
  const input = Math.ceil((2 * prefix + page) / TYPICAL_CHARS_PER_TOKEN) + TYPICAL_TOOL_TURN_OUTPUT;
  return priced(model, input, TYPICAL_TOOL_TURN_OUTPUT + TYPICAL_ANSWER_OUTPUT, false);
}

/** The estimate line wiki:serve prints before it answers anything (spec v2 #4 §2, C12). */
export function serveEstimateLine(at: {
  model: string;
  typicalUsd: number;
  questionUsd: number;
  maxUsd: number;
}): string {
  return `ask: ${at.model}, about $${at.typicalUsd.toFixed(2)} a question, at most $${at.questionUsd.toFixed(2)} a question and $${at.maxUsd.toFixed(2)} this session`;
}

/** The session's total, printed when wiki:serve stops: "12 questions, 3 cached, $0.1104". */
export function totalsLine(totals: { questions: number; cached: number; usd: number }): string {
  return `${totals.questions} question${totals.questions === 1 ? "" : "s"}, ${totals.cached} cached, $${totals.usd.toFixed(4)}`;
}
