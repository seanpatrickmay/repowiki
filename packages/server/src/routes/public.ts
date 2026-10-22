import {
  type Account,
  authorize,
  HANDLE_PATTERN,
  type Project,
  type PublishedVersion,
  Slug,
} from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import { avatarKey } from "../github/avatar.ts";
import type { Reply, Route } from "../http/router.ts";
import { SITE_DIR } from "../render/build.ts";
import { accountById, avatarInUse, resolveHandle } from "../store/accounts.ts";
import { versionOf } from "../store/drafts.ts";
import { projectBySlug } from "../store/projects.ts";
import { biographyPage, publishedEntries } from "./biography-page.ts";
import { SITE_CSP, serveTreeFile } from "./preview.ts";

const PUBLIC = { "cache-control": "public, max-age=60" };
const plain = (status: number, body: string): Reply => ({
  status,
  headers: { ...PUBLIC, "content-type": "text/plain; charset=utf-8" },
  body,
});
const notFound = () => plain(404, "Not found");
const moved = (location: string): Reply => ({ status: 301, headers: { ...PUBLIC, location } });

type Owner =
  | { reply: Reply }
  | {
      accountId: string;
      handle: string;
      login: string;
      displayName: string;
      avatar: Account["avatar"];
      status: string;
      /** The name asked for is not the handle's canonical spelling (case, or a renamed handle). */
      moved: boolean;
    };

/** A decoded path tail, encoded again for a Location header. */
const encodedRest = (rest: string) => rest.split("/").map(encodeURIComponent).join("/");

/**
 * Signed-out reads of biographies and published wikis (spec 2 S14, ADR-0013), on the pages host.
 * A redirect is only ever built from a stored handle and slug, after the page itself was found,
 * so no request can turn one into a link off the site.
 */
export function publicRoutes(deps: Deps): Route[] {
  /** The handle's active account (following one rename), or the reply for a missing or gone one. */
  async function owner(name: string): Promise<Owner> {
    const lower = name.toLowerCase();
    if (!HANDLE_PATTERN.test(lower)) return { reply: notFound() };
    let found = await resolveHandle(deps.db, lower);
    let moved = name !== lower;
    if (found.kind === "redirect") {
      if (!HANDLE_PATTERN.test(found.to)) return { reply: notFound() };
      found = await resolveHandle(deps.db, found.to);
      moved = true;
    }
    if (found.kind === "gone") return { reply: plain(410, "This page was removed.") };
    if (found.kind !== "active") return { reply: notFound() };
    const account = await accountById(deps.db, found.accountId);
    if (account === null) return { reply: notFound() };
    return {
      accountId: account.id,
      handle: found.handle,
      login: account.login,
      displayName: account.displayName,
      avatar: account.avatar,
      status: account.status,
      moved: moved || name !== found.handle,
    };
  }

  /** The project's current version when the policy lets anyone read it; 404 or 410 otherwise. */
  async function published(
    name: string,
    slug: string,
  ): Promise<
    | { reply: Reply }
    | { project: Project; version: PublishedVersion; handle: string; canonical: string | null }
  > {
    const lowerSlug = slug.toLowerCase();
    if (!Slug.safeParse(lowerSlug).success) return { reply: notFound() };
    const who = await owner(name);
    if ("reply" in who) return who;
    const project = await projectBySlug(deps.db, who.accountId, lowerSlug);
    if (project === null) return { reply: notFound() };
    const verdict = authorize("public.read", {
      now: deps.now(),
      caller: { kind: "anonymous" },
      project,
      ownerStatus: who.status as "active" | "deleting",
    });
    if (!verdict.ok) {
      if (verdict.code !== "withdrawn") return { reply: notFound() };
      const by = project.withdrawReason === "author" ? "The author withdrew this page." : null;
      return { reply: plain(410, by ?? "This page was removed.") };
    }
    const version = await versionOf(deps.db, project.id, project.currentVersion);
    if (version === null) return { reply: notFound() };
    const base = `/${who.handle}/${project.slug}/`;
    const canonical = who.moved || slug !== project.slug ? base : null;
    return { project, version, handle: who.handle, canonical };
  }

  return [
    {
      // An account's stored GitHub avatar, by content hash (ADR-0013): it never changes.
      method: "GET",
      pattern: "/_app/avatar/:sha",
      handler: async (request) => {
        const sha = request.params.sha ?? "";
        const type = /^[0-9a-f]{64}$/.test(sha) ? await avatarInUse(deps.db, sha) : null;
        const stored = type === null ? null : await deps.objects.get(avatarKey(sha));
        if (type === null || stored === null) return notFound();
        const headers = {
          "content-type": type,
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        };
        return { status: 200, headers, body: stored.body };
      },
    },
    {
      method: "GET",
      pattern: "/:handle",
      handler: async (request) => {
        const who = await owner(request.params.handle ?? "");
        if ("reply" in who) return who.reply;
        if (who.status !== "active") return plain(410, "This page was removed.");
        if (who.moved) return moved(`/${who.handle}`);
        // Built on request from the projects published now (ADR-0013): none, no page.
        const published = await publishedEntries(deps, who.accountId);
        if (published.length === 0) return notFound();
        const projects = published.map((p) => ({
          slug: p.slug,
          href: `/${who.handle}/${p.slug}/`,
          entry: p.entry,
        }));
        const asOf =
          published
            .map((p) => p.publishedAt)
            .sort()
            .at(-1) ?? deps.now();
        const body = biographyPage(deps, who, projects, {
          asOf,
          self: `/${who.handle}`,
          preview: false,
        });
        return {
          status: 200,
          headers: { ...PUBLIC, "content-type": "text/html; charset=utf-8" },
          body,
        };
      },
    },
    {
      method: "GET",
      pattern: "/:handle/:slug",
      handler: async (request) => {
        const found = await published(request.params.handle ?? "", request.params.slug ?? "");
        if ("reply" in found) return found.reply;
        return moved(found.canonical ?? `/${found.handle}/${found.project.slug}/`);
      },
    },
    {
      // The project's wiki, its main page at the project's own path (ADR-0013).
      method: "GET",
      pattern: "/:handle/:slug/*",
      handler: async (request) => {
        const { handle = "", slug = "" } = request.params;
        const rest = request.params["*"] ?? "";
        const found = await published(handle, slug);
        if ("reply" in found) return found.reply;
        if (found.canonical !== null) return moved(`${found.canonical}${encodedRest(rest)}`);
        // The published bytes exactly as previewed and copied (Contract §6.4).
        const prefix = `${found.version.siteKey}${SITE_DIR}`;
        const file = await serveTreeFile(deps.objects, prefix, rest);
        if (file === null) return notFound();
        const headers = {
          ...PUBLIC,
          "content-type": file.contentType,
          "content-security-policy": SITE_CSP,
        };
        return { status: 200, headers, body: file.body };
      },
    },
    {
      method: "GET",
      pattern: "/:handle/*",
      handler: async (request) => {
        // Only `/<handle>/` reaches here: every longer path matched a route above.
        if ((request.params["*"] ?? "") !== "") return notFound();
        const who = await owner(request.params.handle ?? "");
        if ("reply" in who) return who.reply;
        return moved(`/${who.handle}`);
      },
    },
  ];
}
