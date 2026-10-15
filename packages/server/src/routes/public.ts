import { authorize, HANDLE_PATTERN, type Project, type PublishedVersion } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Reply, Route } from "../http/router.ts";
import { type ProfileEntry, profilePage } from "../pages/profile.ts";
import { PortfolioData, portfolioHtml } from "../render/portfolio.ts";
import { accountById, resolveHandle } from "../store/accounts.ts";
import { versionOf } from "../store/drafts.ts";
import { projectBySlug, projectsOf } from "../store/projects.ts";
import { SITE_CSP, serveTreeFile, siteBase } from "./preview.ts";

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
  | { accountId: string; handle: string; displayName: string; status: string };

/** Signed-out reads of published pages and profiles (spec 2 S14), registered after every app route. */
export function publicRoutes(deps: Deps): Route[] {
  /** The handle's active account, or the reply for a redirect, a gone or a missing handle. */
  async function owner(name: string, rest: string): Promise<Owner> {
    const lower = name.toLowerCase();
    if (!HANDLE_PATTERN.test(lower)) return { reply: notFound() };
    const found = await resolveHandle(deps.db, lower);
    if (found.kind === "redirect") return { reply: moved(`/${found.to}${rest}`) };
    if (found.kind === "gone") return { reply: plain(410, "This page was removed.") };
    if (found.kind === "missing") return { reply: notFound() };
    if (name !== found.handle) return { reply: moved(`/${found.handle}${rest}`) };
    const account = await accountById(deps.db, found.accountId);
    if (account === null) return { reply: notFound() };
    return {
      accountId: account.id,
      handle: found.handle,
      displayName: account.displayName,
      status: account.status,
    };
  }

  /** The project's current version when the policy lets anyone read it; 404 or 410 otherwise. */
  async function published(
    name: string,
    slug: string,
    rest: string,
  ): Promise<{ reply: Reply } | { project: Project; version: PublishedVersion; handle: string }> {
    const who = await owner(name, `/${slug}${rest}`);
    if ("reply" in who) return who;
    const project = await projectBySlug(deps.db, who.accountId, slug);
    if (project === null) return { reply: notFound() };
    const verdict = authorize("public.read", {
      now: deps.now(),
      caller: { kind: "anonymous" },
      project,
      ownerStatus: who.status as "active" | "deleting",
    });
    if (!verdict.ok) {
      return {
        reply:
          verdict.code === "withdrawn" ? plain(410, "The author withdrew this page.") : notFound(),
      };
    }
    const version = await versionOf(deps.db, project.id, project.currentVersion);
    if (version === null) return { reply: notFound() };
    return { project, version, handle: who.handle };
  }

  /** The stored portfolio layer of a version. */
  async function portfolioOf(version: PublishedVersion): Promise<PortfolioData | null> {
    const stored = await deps.objects.get(`${version.siteKey}portfolio.json`);
    return stored === null
      ? null
      : PortfolioData.parse(JSON.parse(new TextDecoder().decode(stored.body)));
  }

  return [
    {
      method: "GET",
      pattern: "/:handle",
      handler: async (request) => {
        const who = await owner(request.params.handle ?? "", "");
        if ("reply" in who) return who.reply;
        if (who.status !== "active") return plain(410, "This page was removed.");
        const entries: ProfileEntry[] = [];
        for (const project of await projectsOf(deps.db, who.accountId)) {
          if (project.state !== "published") continue;
          const version = await versionOf(deps.db, project.id, project.currentVersion);
          const data = version === null ? null : await portfolioOf(version);
          if (version === null || data === null) continue;
          entries.push({
            slug: project.slug,
            title: data.title,
            tagline: data.tagline,
            publishedAt: version.publishedAt,
          });
        }
        entries.sort((a, b) =>
          a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0,
        );
        const body = profilePage({ handle: who.handle, displayName: who.displayName, entries });
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
        const found = await published(request.params.handle ?? "", request.params.slug ?? "", "");
        if ("reply" in found) return found.reply;
        const data = await portfolioOf(found.version);
        if (data === null) return notFound();
        const base = siteBase(found.handle, found.project.slug);
        const options = { base, publishedAt: found.version.publishedAt, preview: false };
        return {
          status: 200,
          headers: { ...PUBLIC, "content-type": "text/html; charset=utf-8" },
          body: portfolioHtml(data, options),
        };
      },
    },
    {
      method: "GET",
      pattern: "/:handle/:slug/*",
      handler: async (request) => {
        const { handle = "", slug = "" } = request.params;
        const rest = request.params["*"] ?? "";
        if (rest === "") return moved(`/${handle}/${slug}`);
        if (rest === "docs") return moved(`/${handle}/${slug}/docs/`);
        const found = await published(handle, slug, `/${rest}`);
        if ("reply" in found) return found.reply;
        if (!rest.startsWith("docs/")) return notFound();
        // The published bytes exactly as previewed and copied (Contract §6.4).
        const file = await serveTreeFile(deps.objects, found.version.siteKey, rest);
        if (file === null) return notFound();
        const headers = {
          ...PUBLIC,
          "content-type": file.contentType,
          "content-security-policy": SITE_CSP,
        };
        return { status: 200, headers, body: file.body };
      },
    },
  ];
}
