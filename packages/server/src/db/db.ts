/** Run SQL with positional parameters; rows come back as plain objects, `jsonb` already parsed. */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  /** Several statements with no parameters, such as a migration. */
  exec(sql: string): Promise<void>;
}

/** Postgres, through `pg` in production or PGlite in tests and development (spec 2 S3). */
export interface Db extends Queryable {
  /** `fn` in one transaction: committed when it returns, rolled back when it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const RETRYABLE: ReadonlySet<string> = new Set(["40001", "40P01"]);

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** `run` again after a serialization failure or deadlock, up to `attempts` times in all. */
export async function withRetries<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has(codeOf(error) ?? "")) throw error;
    }
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return codeOf(error) === "23505";
}
