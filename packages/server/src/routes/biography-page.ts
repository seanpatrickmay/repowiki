import { type Account, BiographyEntry, type BiographyProject, biography } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { ObjectStore } from "../objects/store.ts";
import { SILHOUETTE_PATH } from "../pages/biography-style.ts";
import { biographyHtml } from "../render/biography.ts";
import { ENTRY_FILE } from "../render/build.ts";
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

/** The account's published projects, each with its current version's entry (ADR-0013). */
export async function publishedEntries(deps: Deps, accountId: string): Promise<PublishedEntry[]> {
  const found: PublishedEntry[] = [];
  for (const project of await projectsOf(deps.db, accountId)) {
    if (project.state !== "published") continue;
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

/** The biography page of `account` over `projects` (ADR-0013). */
export function biographyPage(
  deps: Deps,
  account: Pick<Account, "login" | "displayName">,
  projects: readonly BiographyProject[],
  options: { asOf: string; self: string; preview: boolean },
): string {
  const person = { login: account.login, displayName: account.displayName };
  return biographyHtml(biography({ person, projects, asOf: options.asOf }), {
    self: options.self,
    avatarUrl: SILHOUETTE_PATH,
    appOrigin: deps.config.appOrigin,
    preview: options.preview,
  });
}
