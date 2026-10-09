import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import * as pagefind from "pagefind";

/** The slice of the Pagefind Node API the site build uses (a seam so a test can stand in for it). */
export interface SearchIndexApi {
  createIndex(config: { forceLanguage: string }): Promise<{
    index?: {
      addDirectory(source: { path: string }): Promise<{ errors: string[]; page_count: number }>;
      getFiles(): Promise<{ errors: string[]; files: { path: string; content: Uint8Array }[] }>;
    };
    errors: string[];
  }>;
  close(): Promise<unknown>;
}

/**
 * Pagefind's scripts fall back to the bundle path "/pagefind/" when they cannot tell where they
 * were loaded from; a site served under `base` keeps its bundle at <base>pagefind/, so that is
 * the fallback its scripts get. Other files, and every file under the base "/", are unchanged.
 */
function bundleFile(path: string, content: Uint8Array, base: string): Uint8Array {
  if (base === "/" || !path.endsWith(".js")) return content;
  const script = Buffer.from(content).toString("utf8");
  return Buffer.from(script.replaceAll('"/pagefind/"', JSON.stringify(`${base}pagefind/`)));
}

/**
 * Indexes the built HTML in outDir and writes the Pagefind bundle to outDir/pagefind, for a site
 * served under `base`. The index's URLs stay relative to the site's root; the search page gives
 * Pagefind the base (client/search.ts).
 *
 * The bundle is fetched from the backend (getFiles) and written here, not written by the backend
 * (writeFiles): the backend answers writeFiles before it has finished writing, so the files can
 * still be empty when the promise resolves, and closing the backend then leaves them empty for
 * good (issue #342). Every file is on disk, whole, by the time this returns.
 */
export async function writeSearchIndex(
  outDir: string,
  base = "/",
  api: SearchIndexApi = pagefind,
): Promise<{ htmlPages: number }> {
  const { index, errors } = await api.createIndex({ forceLanguage: "en" });
  try {
    if (index === undefined) throw new Error(`pagefind: ${errors.join("; ")}`);
    const added = await index.addDirectory({ path: outDir });
    if (added.errors.length > 0) throw new Error(`pagefind: ${added.errors.join("; ")}`);
    const bundle = await index.getFiles();
    if (bundle.errors.length > 0) throw new Error(`pagefind: ${bundle.errors.join("; ")}`);
    const target = resolve(outDir, "pagefind");
    // Resolve every path first, so a path that escapes the bundle directory writes nothing at all.
    const writes = bundle.files.map((file) => {
      const path = resolve(target, file.path);
      const inside = relative(target, path);
      if (
        inside === "" ||
        inside === ".." ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside) ||
        isAbsolute(file.path)
      ) {
        throw new Error(`pagefind: refusing to write outside the output directory: "${file.path}"`);
      }
      return { path, content: bundleFile(file.path, file.content, base) };
    });
    for (const { path, content } of writes) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return { htmlPages: added.page_count };
  } finally {
    await api.close();
  }
}
