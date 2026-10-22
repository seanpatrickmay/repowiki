import {
  type Account,
  authorize,
  BiographyEntry,
  type BiographyProject,
  biography,
} from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import { avatarPath } from "../github/avatar.ts";
import type { ObjectStore } from "../objects/store.ts";
import { SILHOUETTE_PATH } from "../pages/biography-style.ts";
import { biographyHtml } from "../render/biography.ts";
import { ENTRY_FILE } from "../render/build.ts";
import { accountById } from "../store/accounts.ts";
import { versionOf } from "../store/drafts.ts";
import { projectsOf } from "../store/projects.ts";

/** The biography entry of the tree at `prefix`, parsed; null when the tree has none. */
export async function storedEntry(
  objects: ObjectStore,
  prefix: string,
): Promise<BiographyEntry | null> {
  const stored = await objects.get(`${prefix}${ENTRY_FILE}`);
  return stored === null
    ? null
    : BiographyEntry.parse(JSON.parse(new TextDecoder().decode(stored.body)));
}

export interface PublishedEntry {
  projectId: string;
  slug: string;
  entry: BiographyEntry;
  publishedAt: string;
}

/**
 * The account's projects anyone may read now (the `public.read` policy), each with its current
 * version's entry (ADR-0013).
 */
export async function publishedEntries(deps: Deps, accountId: string): Promise<PublishedEntry[]> {
  const owner = await accountById(deps.db, accountId);
  if (owner === null) return [];
  const found: PublishedEntry[] = [];
  for (const project of await projectsOf(deps.db, accountId)) {
    const verdict = authorize("public.read", {
      now: deps.now(),
      caller: { kind: "anonymous" },
      project,
      ownerStatus: owner.status,
    });
    if (!verdict.ok) continue;
    const version = await versionOf(deps.db, project.id, project.currentVersion);
    const entry = version === null ? null : await storedEntry(deps.objects, version.siteKey);
    if (version === null || entry === null) continue;
    found.push({
      projectId: project.id,
      slug: project.slug,
      entry,
      publishedAt: version.publishedAt,
    });
  }
  return found;
}

/** The account's stored avatar on the pages origin, or the silhouette (ADR-0013). */
export const avatarUrl = (account: Pick<Account, "avatar">) =>
  account.avatar === undefined ? SILHOUETTE_PATH : avatarPath(account.avatar.sha256);

/** The biography page of `account` over `projects` (ADR-0013). */
export function biographyPage(
  deps: Deps,
  account: Pick<Account, "login" | "displayName" | "avatar">,
  projects: readonly BiographyProject[],
  options: {
    asOf: string;
    self: string;
    preview: boolean;
    example?: boolean;
    /** Where the avatar is served, for a page whose account isn't stored (the example). */
    avatarUrl?: string;
  },
): string {
  const person = { login: account.login, displayName: account.displayName };
  return biographyHtml(biography({ person, projects, asOf: options.asOf }), {
    self: options.self,
    avatarUrl: options.avatarUrl ?? avatarUrl(account),
    appOrigin: deps.config.appOrigin,
    preview: options.preview,
    example: options.example ?? false,
  });
}
