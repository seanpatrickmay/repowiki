import type { PeopleConfig } from "@repowiki/core";
import { type AuthoredCommit, readAuthorship, readBlobAt } from "../index/index.ts";
import { type Store, StoreError } from "../store/index.ts";
import { type ResolvedIdentities, resolveIdentities } from "./identities.ts";
import { type Mailmap, parseMailmap } from "./mailmap.ts";
import { blameTree, ignoreRevsFrom, type Ownership } from "./ownership.ts";
import { type Assigned, assignIds } from "./registry.ts";
import { type ComputedSnapshot, computeSnapshot } from "./snapshot.ts";

/** Everything People reads before blame: no store write, no call. */
export interface PeopleRead {
  sha: string;
  commits: AuthoredCommit[];
  mailmap: Mailmap;
  identities: ResolvedIdentities;
  assigned: Assigned;
  /** The committed `.git-blame-ignore-revs` (R4), unless the file says `ignoreRevs: false`. */
  ignoreRevs: string[];
  /** One line each, naming no email: keys matching nobody, a damaged mailmap. */
  warnings: string[];
}

export interface ReadInput {
  repo: string;
  /** The wiki's head, which People documents (never a new sha, spec v2 #6 §10). */
  sha: string;
  store: Store;
  config: PeopleConfig;
  ownerEmail: string | null;
}

/**
 * Reads who wrote the history at `sha` (spec v2 #6 §4 steps 1-3): the log, the committed
 * mailmap and ignore-revs blobs (never the work tree), the identity groups and their ids against
 * the stored registry. Writes nothing; people:suggest stops here.
 */
export function readPeople(input: ReadInput): PeopleRead {
  const { repo, sha, store, config } = input;
  const commits = readAuthorship(repo, sha);
  const mailmap = parseMailmap(readBlobAt(repo, sha, ".mailmap") ?? "");
  const identities = resolveIdentities({
    commits,
    mailmap,
    config,
    salt: store.getPeopleSalt(),
    ownerEmail: input.ownerEmail,
  });
  const assigned = assignIds(identities.groups, store.listPeopleRegistry());
  const known = new Set(commits.map((c) => c.sha));
  const ignoreRevs = config.ignoreRevs
    ? ignoreRevsFrom(readBlobAt(repo, sha, ".git-blame-ignore-revs") ?? "", known)
    : [];
  const warnings = [...identities.warnings];
  if (mailmap.skipped > 0) warnings.push(`.mailmap: ${mailmap.skipped} malformed lines skipped`);
  return { sha, commits, mailmap, identities, assigned, ignoreRevs, warnings };
}

export interface RefreshInput extends ReadInput {
  /** wiki:people --rebuild-blame. */
  rebuildBlame?: boolean;
  concurrency?: number;
  timeoutMs?: number;
}

export type Refreshed = PeopleRead & ComputedSnapshot & { ownership: Ownership };

/**
 * The People refresh (spec v2 #6 §4 steps 1-5, §9): readPeople, blame through the cache, the
 * snapshot, and then the snapshot and the registry stored in one transaction. No LLM call.
 * Throws a StoreError when the store has no manifest for the sha's wiki.
 */
export async function refreshPeople(input: RefreshInput): Promise<Refreshed> {
  const manifests = input.store.listManifests();
  if (manifests.length === 0)
    throw new StoreError("the store has no manifest; run pnpm wiki:build first");
  const read = readPeople(input);
  const ownership = await blameTree(input.repo, input.sha, input.store, {
    ignoreRevs: read.ignoreRevs,
    ...(input.rebuildBlame === undefined ? {} : { rebuild: input.rebuildBlame }),
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  for (const { path } of ownership.timedOut)
    read.warnings.push(
      `blame timed out for ${JSON.stringify(path.slice(0, 200))}; its lines are unattributed`,
    );
  const computed = computeSnapshot({
    sha: input.sha,
    commits: read.commits,
    identities: read.identities,
    ids: read.assigned.ids,
    redirects: read.assigned.redirects,
    ownership,
    manifests,
    config: input.config,
  });
  input.store.transaction(() => {
    input.store.putPeopleRegistry(read.assigned.registry);
    input.store.putPeopleSnapshot(computed.snapshot);
  });
  return { ...read, ...computed, ownership };
}
