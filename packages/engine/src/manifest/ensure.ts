import type { Manifest } from "@repowiki/core";
import type { RepoIndex } from "../index/index.ts";
import { DuplicateManifestError, type Store } from "../store/index.ts";
import {
  buildManifest,
  type ManifestBuild,
  ManifestBuildError,
  type ManifestBuildOptions,
} from "./build.ts";

/**
 * Returns the manifest for index.sha, building and storing it (as the drift baseline) when the
 * store has none. A store that already holds a manifest for another sha needs an update, which
 * revises the prior manifest instead of rebuilding it (spec §4, §6.1), so this refuses.
 *
 * Concurrent calls on an empty store may each pay for a build: nothing locks across the LLM call.
 * The first to finish stores its manifest; the others return that stored manifest with
 * `build: null` and discard their own.
 */
export async function ensureManifest(
  store: Store,
  index: RepoIndex,
  options: ManifestBuildOptions,
): Promise<{ manifest: Manifest; build: ManifestBuild | null }> {
  const stored = store.getManifest(index.sha);
  if (stored !== null) return { manifest: stored, build: null };
  const latest = store.getLatestManifest();
  if (latest !== null) {
    throw new ManifestBuildError(
      `the store already has a manifest for ${latest.sha}; moving to ${index.sha} is an update, not a build`,
    );
  }
  const build = await buildManifest(index, options);
  try {
    store.putManifest(build.manifest, { llmRevised: true });
  } catch (error) {
    const winner = error instanceof DuplicateManifestError ? store.getManifest(index.sha) : null;
    if (winner === null) throw error;
    return { manifest: winner, build: null };
  }
  return { manifest: build.manifest, build };
}
