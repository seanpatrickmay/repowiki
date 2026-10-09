// Code-like tokens and whether a text writes them (spec v2 #4 R6), with no zod: the Ask
// sidebar's sentence check and work in flight's summary check ground names by the same rule.

/**
 * File extensions that make a word code-like: spec v2 #4 R6's list, plus the other common source,
 * config and text files (plan ruling), so `secrets.txt` or `main.go` must be grounded too.
 */
const SOURCE_EXTENSION =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|tf|hcl|json|yml|yaml|toml|sql|sh|css|html|md|txt|env|ini|cfg|xml|lock|go|rs|java|kt|rb|php|c|h|cpp|cs|swift)$/i;

/** A run of the characters a name is made of: letters, digits and `.`, `/`, `_`, `-`. */
const NAME_RUN = /[\p{L}\p{N}._/-]+/gu;
/** A sentence's dashes and dots at a name's ends (not a dotfile's dot or `../`). */
const NAME_LEAD = /^(?:-+|\.{2,}(?!\/))/;
const NAME_TAIL = /[.-]+$/;
/** What follows a name that makes it a call: `()` or `(args)`. */
const CALL_AFTER = /^\([^()\n]*\)/;
/** Invisible format characters, which can split a name without showing (removed first). */
const INVISIBLE = /[\p{Cf}\u200B-\u200D\u2060\uFEFF]/gu;

/** `file(s)`, `API(es)`: a plural after a word of one case, not a call. */
const PLURAL_AFTER = /^\(e?s\)/;

/**
 * The code-like tokens of a sentence (spec v2 #4 R6): every backtick span, and every other name
 * that contains `/` or `_`, is a call, or ends in a source-file extension. A name is a run of
 * letters, digits, `.`, `/`, `_` and `-`; any other character (Unicode quotes, dashes, ellipses,
 * apostrophes, symbols) ends it, so `secrets.txt's` and a curly-quoted `secrets.txt` both give
 * `secrets.txt`. The text is NFKC-normalised and its invisible format characters removed first,
 * so neither a full-width form nor a zero-width space hides a name. A sentence's dots and dashes
 * at a name's ends are not part of it. `name(args)` is the call `name()`, and its arguments
 * (nested calls in backticks included) are read as names too; `file(s)` or `API(s)` after a word
 * of one case is a plural.
 */
export function codeTokens(text: string): string[] {
  const tokens: string[] = [];
  // NFKC first, so a full-width dot or letter is the ASCII one, then no invisible character.
  const plain = text.normalize("NFKC").replace(INVISIBLE, "");
  const rest = plain.replace(/`([^`]*)`/g, (_span, inner: string) => {
    const code = inner.trim();
    const call = /^([\p{L}\p{N}._/-]+)\((.*)\)$/su.exec(code);
    if (call !== null) tokens.push(`${call[1]}()`);
    else if (code !== "") tokens.push(code);
    return ` ${call?.[2] ?? ""} `;
  });
  for (const match of rest.matchAll(NAME_RUN)) {
    const run = match[0];
    const word = run.replace(NAME_LEAD, "").replace(NAME_TAIL, "");
    if (!/[\p{L}\p{N}]/u.test(word)) continue;
    const after = rest.slice(match.index + run.length);
    const call =
      run.endsWith(word) &&
      CALL_AFTER.test(after) &&
      !(PLURAL_AFTER.test(after) && /^(\p{Ll}+|\p{Lu}+)$/u.test(word));
    if (call) tokens.push(`${word}()`);
    else if (/[/_]/.test(word) || SOURCE_EXTENSION.test(word)) tokens.push(word);
  }
  return tokens;
}

/** A character a name is made of: one next to a match makes the match part of a longer name. */
const NAME_CHARACTER = /[A-Za-z0-9_]/;

/**
 * True when `ground` writes `token` as a whole name: at some place where neither the character
 * before it nor the one after it continues an identifier the token starts or ends with, so
 * `sign` is not written by `signal` or `save_signal`, but `ingest.py` is by `src/ingest.py`.
 */
export function writesName(ground: string, token: string): boolean {
  const opens = NAME_CHARACTER.test(token.charAt(0));
  const closes = NAME_CHARACTER.test(token.charAt(token.length - 1));
  for (let at = ground.indexOf(token); at !== -1; at = ground.indexOf(token, at + 1)) {
    const before = ground.charAt(at - 1);
    const after = ground.charAt(at + token.length);
    if (!(opens && NAME_CHARACTER.test(before)) && !(closes && NAME_CHARACTER.test(after))) {
      return true;
    }
  }
  return false;
}

/**
 * The first code-like token of `text` (codeTokens) that `ground` does not write as a whole name
 * (writesName), or null when every one is grounded; `foo()` is grounded by `foo`.
 */
export function ungroundedCodeToken(ground: string, text: string): string | null {
  for (const token of codeTokens(text)) {
    const base = token.endsWith("()") ? token.slice(0, -2) : token;
    if (!writesName(ground, token) && (base === "" || !writesName(ground, base))) return token;
  }
  return null;
}
