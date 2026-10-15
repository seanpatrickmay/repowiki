/** Where exports, previews and published sites live (spec 2 S12). */
export interface ObjectStore {
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  head(key: string): Promise<{ contentType: string; size: number } | null>;
  /** Every key under `prefix` (a plain string prefix, not only whole segments), sorted. */
  list(prefix: string): Promise<string[]>;
  /** Deleting a key that is not there is not an error. */
  delete(keys: readonly string[]): Promise<void>;
}

const KEY = /^[A-Za-z0-9._~@+=-]+(?:\/[A-Za-z0-9 ._~@+=&-]+)*$/;
const KEY_MAX = 512;

/** A key that cannot escape its prefix or the store root: no "", ".", ".." or "\" segments. */
export function isKey(key: string): boolean {
  return (
    key.length <= KEY_MAX &&
    KEY.test(key) &&
    key.split("/").every((segment) => segment !== "." && segment !== "..")
  );
}

export function assertKey(key: string): void {
  if (!isKey(key)) throw new Error("invalid object key");
}

const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  xml: "application/xml",
  wasm: "application/wasm",
};

/** The content type a key's extension implies; octet-stream for anything else. */
export function contentTypeFor(key: string): string {
  const name = key.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return (
    (dot > 0 ? TYPES[name.slice(dot + 1).toLowerCase()] : undefined) ?? "application/octet-stream"
  );
}

/** Copy every object under `from` to the same relative key under `to`; returns how many. */
export async function copyPrefix(store: ObjectStore, from: string, to: string): Promise<number> {
  let copied = 0;
  for (const key of await store.list(from)) {
    const object = await store.get(key);
    if (object === null) continue;
    await store.put(`${to}${key.slice(from.length)}`, object.body, object.contentType);
    copied++;
  }
  return copied;
}
