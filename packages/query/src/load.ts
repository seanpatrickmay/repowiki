import { readFileSync } from "node:fs";
import { SCHEMA_VERSION, WikiExport } from "@repowiki/core";

/** An export that cannot be read or does not validate. The message names the file. */
export class ExportLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Reads and validates `<file>` with @repowiki/core's WikiExport schema. Another schema version
 * is named first, with what to do (the site's message): it fails on many fields, which would
 * bury the real cause.
 */
export function loadExport(file: string): WikiExport {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ExportLoadError(`cannot read export ${file}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const version =
    typeof raw === "object" && raw !== null ? Reflect.get(raw, "schemaVersion") : null;
  if (typeof version === "number" && version !== SCHEMA_VERSION) {
    const [age, action] =
      version < SCHEMA_VERSION ? ["older", "re-run the export"] : ["newer", "upgrade RepoWiki"];
    throw new ExportLoadError(
      `export schema ${version} in ${file} is ${age} than this reader (${SCHEMA_VERSION}); ${action}`,
    );
  }
  const result = WikiExport.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.map(String).join(".") || "(root)";
    throw new ExportLoadError(
      `invalid export ${file}: ${where}: ${issue?.message ?? "invalid"}${result.error.issues.length > 1 ? ` (and ${result.error.issues.length - 1} more problems)` : ""}`,
    );
  }
  return result.data;
}
