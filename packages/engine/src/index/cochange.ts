export interface CoChangePair {
  a: string;
  b: string;
  count: number;
}

export interface CoChange {
  /** Every commit not skipped as a sweep, whether or not it contributed any pair. */
  commitsConsidered: number;
  /** Commits ignored for touching more than maxFilesPerCommit files (formatting sweeps, lockfile bumps). */
  commitsSkipped: number;
  /** Per file present at the indexed sha: how many considered commits touched it. */
  fileCommits: Record<string, number>;
  /** Unordered pairs (a < b) of present files changed together, with how often. */
  pairs: CoChangePair[];
}

export const DEFAULT_MAX_FILES_PER_COMMIT = 50;

export function computeCoChange(
  commits: readonly (readonly string[])[],
  present: ReadonlySet<string>,
  maxFilesPerCommit = DEFAULT_MAX_FILES_PER_COMMIT,
): CoChange {
  const fileCommits = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  let considered = 0;
  let skipped = 0;
  for (const changed of commits) {
    const unique = [...new Set(changed)];
    if (unique.length > maxFilesPerCommit) {
      skipped++;
      continue;
    }
    considered++;
    const files = unique.filter((path) => present.has(path)).sort();
    for (const file of files) fileCommits.set(file, (fileCommits.get(file) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}\0${files[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs = [...pairCounts]
    .map(([key, count]) => {
      const [a = "", b = ""] = key.split("\0");
      return { a, b, count };
    })
    .sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return {
    commitsConsidered: considered,
    commitsSkipped: skipped,
    fileCommits: Object.fromEntries([...fileCommits].sort(([x], [y]) => (x < y ? -1 : 1))),
    pairs,
  };
}
