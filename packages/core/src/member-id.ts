/**
 * Member ids name what a feature owns: "path" for a whole file, "path#symbol" for one symbol.
 * The path part percent-encodes "%" and "#" so the first "#" always separates path from symbol;
 * symbols may contain "#" (TypeScript private members: "Cls.#secret").
 */
export function memberId(path: string, symbol?: string): string {
  const encoded = path.replace(/[%#]/g, (ch) => (ch === "%" ? "%25" : "%23"));
  return symbol === undefined ? encoded : `${encoded}#${symbol}`;
}

/** Inverse of memberId; null when the id is malformed (bad escape, empty symbol). */
export function parseMemberId(id: string): { path: string; symbol: string | null } | null {
  const hash = id.indexOf("#");
  const encoded = hash === -1 ? id : id.slice(0, hash);
  const symbol = hash === -1 ? null : id.slice(hash + 1);
  if (symbol === "" || /%(?!25|23)/.test(encoded)) return null;
  return { path: encoded.replace(/%2[53]/g, (esc) => (esc === "%25" ? "%" : "#")), symbol };
}
