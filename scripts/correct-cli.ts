import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type CorrectionRequest, MAX_CORRECTIONS, MAX_NOTE_LENGTH } from "@repowiki/engine";
import { z } from "zod";
import { CliError } from "./manifest-cli.ts";

export const CORRECT_USAGE =
  "usage: pnpm wiki:correct <repo-path> --export <export.json> --requests <requests.json> --out <file> [--config <file>]";

export interface CorrectArgs {
  repo: string;
  exportPath: string;
  requestsPath: string;
  out: string;
  config: string | null;
}

/** `<repo>` and the three files, in any order; anything else is a usage error. */
export function parseCorrectArgs(argv: readonly string[]): CorrectArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        export: { type: "string" },
        requests: { type: "string" },
        out: { type: "string" },
        config: { type: "string" },
      },
    });
  } catch {
    throw new CliError(CORRECT_USAGE);
  }
  const { export: exportPath, requests, out, config } = parsed.values;
  const [repo, ...rest] = parsed.positionals;
  if (
    repo === undefined ||
    rest.length > 0 ||
    typeof exportPath !== "string" ||
    typeof requests !== "string" ||
    typeof out !== "string"
  ) {
    throw new CliError(CORRECT_USAGE);
  }
  return {
    repo,
    exportPath,
    requestsPath: requests,
    out,
    config: typeof config === "string" ? config : null,
  };
}

const Requests = z
  .array(
    z.strictObject({
      page: z.string().min(1).max(200),
      claimId: z.string().min(1).max(200),
      note: z.string().max(MAX_NOTE_LENGTH),
    }),
  )
  .max(MAX_CORRECTIONS);

/**
 * The requests file: at most MAX_CORRECTIONS `{page, claimId, note}` items. A refusal names the
 * rule only, never the file's text: the notes are the student's and reach only the model.
 */
export function readRequests(path: string): CorrectionRequest[] {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`the requests file is not readable JSON: ${path}`);
  }
  const parsed = Requests.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      `the requests file must list at most ${MAX_CORRECTIONS} {page, claimId, note} items, each note at most ${MAX_NOTE_LENGTH} characters`,
    );
  }
  return parsed.data;
}
