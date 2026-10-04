export interface IndexArgs {
  repo: string;
  rev: string;
  out: string | null;
}

/** `<repo> [rev] [--out file]`, flags and positionals in any order; null when the usage is wrong. */
export function parseIndexArgs(argv: readonly string[]): IndexArgs | null {
  const positionals: string[] = [];
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--out") {
      const value = argv[++i];
      if (value === undefined) return null;
      out = value;
    } else if (arg.startsWith("--")) {
      return null;
    } else {
      positionals.push(arg);
    }
  }
  const [repo, rev = "HEAD", ...extra] = positionals;
  if (repo === undefined || extra.length > 0) return null;
  return { repo, rev, out };
}
