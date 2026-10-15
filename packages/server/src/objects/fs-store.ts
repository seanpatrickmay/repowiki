import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { assertKey, contentTypeFor, isKey, type ObjectStore } from "./store.ts";

const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code));

/**
 * Objects as files under `root` (development, demo, tests). A content type is not stored: it is
 * read back from the key's extension, which is how every key RepoWiki writes is named.
 */
export function fsObjectStore(root: string): ObjectStore {
  const pathOf = (key: string) => {
    assertKey(key);
    return join(root, ...key.split("/"));
  };
  return {
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
    async get(key) {
      const path = pathOf(key);
      try {
        return { body: new Uint8Array(await readFile(path)), contentType: contentTypeFor(key) };
      } catch (error) {
        if (missing(error) || (error as NodeJS.ErrnoException).code === "EISDIR") return null;
        throw error;
      }
    },
    async head(key) {
      const path = pathOf(key);
      try {
        const found = await stat(path);
        return found.isFile() ? { contentType: contentTypeFor(key), size: found.size } : null;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async list(prefix) {
      const cut = prefix.lastIndexOf("/");
      const dir = cut === -1 ? "" : prefix.slice(0, cut);
      if (dir !== "") assertKey(dir);
      const start = dir === "" ? root : join(root, ...dir.split("/"));
      let entries: Dirent[];
      try {
        entries = await readdir(start, { recursive: true, withFileTypes: true });
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
        .filter((key) => key.startsWith(prefix) && isKey(key))
        .sort();
    },
    async delete(keys) {
      for (const key of keys) await rm(pathOf(key), { force: true });
    },
  };
}
