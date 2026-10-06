/**
 * The shapes of GitHub tokens (spec v2 #9 R25): classic and app tokens (`ghp_`, `gho_`, `ghu_`,
 * `ghs_`, `ghr_`) and fine-grained ones (`github_pat_`), which a `gh` or `git fetch` error can echo.
 */
export const GITHUB_TOKEN_SHAPE = /\bgh[pousr]_[A-Za-z0-9]+|\bgithub_pat_[A-Za-z0-9_]+/g;

/** The variables that hold a GitHub token gh or git may use, whatever its shape (R25). */
export const GITHUB_TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/** A shorter configured value is not replaced: it would blank ordinary words. */
const MIN_TOKEN_VALUE_LENGTH = 8;

/**
 * `text` with every GitHub token replaced by "[redacted]" (R25): the exact values the token
 * variables of `env` hold (of at least 8 characters), then anything token-shaped. Redact before
 * cutting or filtering, so neither can leave part of a token.
 */
export function redactGitHub(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let plain = text;
  for (const name of GITHUB_TOKEN_VARIABLES) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length >= MIN_TOKEN_VALUE_LENGTH)
      plain = plain.split(value).join("[redacted]");
  }
  return plain.replace(GITHUB_TOKEN_SHAPE, "[redacted]");
}
