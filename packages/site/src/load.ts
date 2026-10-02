import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION, WikiExport } from "@repowiki/core";
import { z } from "zod";

/** The export could not be read or failed schema validation. The message is reader-facing. */
export class ExportError extends Error {
  override name = "ExportError";
}

/** A directory argument means "<dir>/export.json"; anything else is taken as the file itself. */
export function resolveExportFile(path: string): string {
  try {
    return statSync(path).isDirectory() ? join(path, "export.json") : path;
  } catch {
    return path;
  }
}

/** Reads and validates an export with the @repowiki/core schema. Throws ExportError. */
export function loadExport(path: string): WikiExport {
  const file = resolveExportFile(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ExportError(`cannot read export ${file}: ${(error as Error).message}`);
  }
  const version =
    typeof raw === "object" && raw !== null ? Reflect.get(raw, "schemaVersion") : null;
  if (typeof version === "number" && version !== SCHEMA_VERSION) {
    // Checked first: a different version fails on many fields, which would bury the real cause.
    const [age, action] =
      version < SCHEMA_VERSION ? ["older", "re-run the export"] : ["newer", "upgrade RepoWiki"];
    throw new ExportError(
      `export schema ${version} in ${file} is ${age} than this reader (${SCHEMA_VERSION}); ${action}`,
    );
  }
  const result = WikiExport.safeParse(raw);
  if (!result.success) {
    throw new ExportError(`invalid export ${file}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
