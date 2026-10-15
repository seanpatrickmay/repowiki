import {
  authorize,
  HANDLE_PATTERN,
  type Project,
  type PublishedVersion,
  Slug,
} from "@repowiki/hosted";
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
  | {
      accountId: string;
      handle: string;
      displayName: string;
      status: string;
      /** The name asked for is not the handle's canonical spelling (case, or a renamed handle). */
      moved: boolean;
    };

/** A decoded path tail, encoded again for a Location header. */
const encodedRest = (rest: string) => rest.split("/").map(encodeURIComponent).join("/");

/**
 * Signed-out reads of published pages and profiles (spec 2 S14), registered after every app route.
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
      displayName: account.displayName,
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
    const base = `/${who.handle}/${project.slug}`;
    const canonical = who.moved || slug !== project.slug ? base : null;
    return { project, version, handle: who.handle, canonical };
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
      // The pages origin's root is the product's own front door (ADR-0012).
      method: "GET",
      pattern: "/",
      handler: async () => ({
        status: 302,
        headers: { location: `${deps.config.appOrigin}/` },
      }),
    },
    {
      method: "GET",
      pattern: "/:handle",
      handler: async (request) => {
        const who = await owner(request.params.handle ?? "");
        if ("reply" in who) return who.reply;
        if (who.status !== "active") return plain(410, "This page was removed.");
        if (who.moved) return moved(`/${who.handle}`);
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
        const { appOrigin } = deps.config;
        const body = profilePage({
          handle: who.handle,
          displayName: who.displayName,
          entries,
          appOrigin,
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
        if (found.canonical !== null) return moved(found.canonical);
        const data = await portfolioOf(found.version);
        if (data === null) return notFound();
        const base = siteBase(found.handle, found.project.slug);
        const { appOrigin } = deps.config;
        const options = { base, publishedAt: found.version.publishedAt, preview: false, appOrigin };
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
        if (rest !== "" && rest !== "docs" && !rest.startsWith("docs/")) return notFound();
        const found = await published(handle, slug);
        if ("reply" in found) return found.reply;
        const base = found.canonical ?? `/${found.handle}/${found.project.slug}`;
        if (rest === "") return moved(base);
        if (rest === "docs") return moved(`${base}/docs/`);
        if (found.canonical !== null) return moved(`${base}/${encodedRest(rest)}`);
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
