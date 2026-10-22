import { WikiExport } from "@repowiki/core";
import { authorize, biographyName } from "@repowiki/hosted";
import type { Queryable } from "../db/db.ts";
import { contentTypeFor, type ObjectStore } from "../objects/store.ts";
import { type buildTree, ENTRY_FILE } from "../render/build.ts";
import { hostedExport } from "../render/hosted-export.ts";
import type { TreeFile } from "../render/tree.ts";
import { EXAMPLE_PREFIX, ExampleIndex } from "../routes/example.ts";
import { accountById, resolveHandle } from "../store/accounts.ts";
import { generationById, latestRevision, versionOf } from "../store/drafts.ts";
import { projectsOf } from "../store/projects.ts";

const INDEX_FILE = "index.json";
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * The example's snapshot (ADR-0017) from a local mode account: each wiki anyone may read, rendered
 * again from its stored export at /example/<slug>/ beside the entry it was published with, and the
 * index the /example route reads. Paths are relative to `example/`.
 */
export async function exampleSnapshot(input: {
  db: Queryable;
  objects: ObjectStore;
  handle: string;
  now: () => string;
  build: typeof buildTree;
}): Promise<TreeFile[]> {
  const { db, objects, handle } = input;
  const found = await resolveHandle(db, handle);
  const account = found.kind === "active" ? await accountById(db, found.accountId) : null;
  if (account === null) throw new Error(`no active account has the handle ${handle}`);
  const files: TreeFile[] = [];
  const projects: ExampleIndex["projects"] = [];
  for (const project of await projectsOf(db, account.id)) {
    const verdict = authorize("public.read", {
      now: input.now(),
      caller: { kind: "anonymous" },
      project,
      ownerStatus: account.status,
    });
    if (!verdict.ok) continue;
    const version = await versionOf(db, project.id, project.currentVersion);
    const revision = await latestRevision(db, project.id);
    if (version === null || revision === null || revision.number !== version.revision) {
      throw new Error(`${project.slug}: publish its latest revision first`);
    }
    const generation = await generationById(db, revision.generationId);
    const stored = generation === null ? null : await objects.get(generation.exportKey);
    const entry = await objects.get(`${version.siteKey}${ENTRY_FILE}`);
    if (stored === null || entry === null) {
      throw new Error(`${project.slug}: its export or biography entry is missing`);
    }
    const tree = await input.build({
      exp: hostedExport(WikiExport.parse(JSON.parse(decode(stored.body)))),
      base: `/example/${project.slug}/`,
      repoUrl: `https://github.com/${version.authorization.fullName}`,
      entry: entry.body,
      author: { name: biographyName(account.displayName, account.login), url: "/example" },
    });
    for (const file of tree.files) files.push({ ...file, path: `${project.slug}/${file.path}` });
    projects.push({ slug: project.slug, publishedAt: version.publishedAt });
  }
  if (projects.length === 0) throw new Error(`${handle} has no published project`);
  projects.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const index = ExampleIndex.parse({
    person: { login: account.login, displayName: account.displayName },
    projects,
  });
  files.push({ path: INDEX_FILE, bytes: new TextEncoder().encode(JSON.stringify(index)) });
  return files;
}

/**
 * Store a snapshot under `example/`: every file, then the index, so a reader never sees an index
 * naming files not there yet; then remove what an older snapshot left.
 */
export async function uploadExample(
  objects: ObjectStore,
  files: readonly TreeFile[],
): Promise<{ written: number; removed: number }> {
  const index = files.find((f) => f.path === INDEX_FILE);
  if (index === undefined || !ExampleIndex.safeParse(JSON.parse(decode(index.bytes))).success) {
    throw new Error(`a snapshot needs a valid ${INDEX_FILE}`);
  }
  for (const file of files) {
    if (file === index) continue;
    await objects.put(`${EXAMPLE_PREFIX}${file.path}`, file.bytes, contentTypeFor(file.path));
  }
  await objects.put(`${EXAMPLE_PREFIX}${INDEX_FILE}`, index.bytes, "application/json");
  const keep = new Set(files.map((f) => `${EXAMPLE_PREFIX}${f.path}`));
  const stale = (await objects.list(EXAMPLE_PREFIX)).filter((key) => !keep.has(key));
  await objects.delete(stale);
  return { written: files.length, removed: stale.length };
}
