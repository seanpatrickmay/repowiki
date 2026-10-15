import type { Config } from "../config.ts";
import { fsObjectStore } from "./fs-store.ts";
import { s3ObjectStore } from "./s3-store.ts";
import type { ObjectStore } from "./store.ts";

/** The configured object store: the filesystem outside production, R2 in it. */
export function objectStoreFor(objects: Config["objects"], fetchFn: typeof fetch): ObjectStore {
  if (objects.kind === "fs") return fsObjectStore(objects.root);
  const { endpoint, bucket, accessKeyId, secretAccessKey } = objects;
  return s3ObjectStore({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    fetch: fetchFn,
    now: () => new Date(),
  });
}
