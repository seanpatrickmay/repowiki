import { resolve } from "node:path";
import { loadConfig, objectStoreFor, readTree, uploadExample } from "@repowiki/server";

/**
 * pnpm example:upload <dir> (ADR-0017): store a snapshot from `pnpm example:snapshot` under
 * `example/` in the object store the environment configures. Run on the server's machine, so the
 * storage credentials stay in its secrets.
 */
async function main(): Promise<void> {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error("usage: pnpm example:upload <dir>");
  const config = loadConfig(process.env);
  const files = readTree(resolve(dir));
  const { written, removed } = await uploadExample(objectStoreFor(config.objects, fetch), files);
  console.log(`stored ${written} files under example/, removed ${removed}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
