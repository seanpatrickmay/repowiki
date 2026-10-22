import { IsoDateTime } from "@repowiki/core";
import { Slug } from "@repowiki/hosted";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { Reply, Route } from "../http/router.ts";
import { contentTypeFor } from "../objects/store.ts";
import { SITE_DIR } from "../render/build.ts";
import { biographyPage, storedEntry } from "./biography-page.ts";
import { SITE_CSP, serveTreeFile } from "./preview.ts";

/** Where the example's snapshot lives in the object store (ADR-0017). */
export const EXAMPLE_PREFIX = "example/";

/** The snapshot's index: who the example is, and its projects in the order they were published. */
export const ExampleIndex = z.strictObject({
  person: z.strictObject({
    login: z.string().min(1).max(39),
    displayName: z.string().min(1).max(120),
    /** The account's stored GitHub avatar, as a file of the snapshot (ADR-0013); else the silhouette. */
    avatar: z.enum(["avatar.png", "avatar.jpg", "avatar.gif", "avatar.webp"]).optional(),
  }),
  projects: z
    .array(z.strictObject({ slug: Slug, publishedAt: IsoDateTime }))
    .min(1)
    .max(10),
});
export type ExampleIndex = z.infer<typeof ExampleIndex>;

const PUBLIC = { "cache-control": "public, max-age=60" };
/** Where the example serves its person's avatar. */
const AVATAR_PATH = "/example/_avatar";
const notFound = (): Reply => ({
  status: 404,
  headers: { ...PUBLIC, "content-type": "text/plain; charset=utf-8" },
  body: "Not found",
});
const moved = (location: string): Reply => ({ status: 301, headers: { ...PUBLIC, location } });

/**
 * repowiki.app/example (ADR-0017): a snapshot of the pipeline's own output for the example
 * student, its biography rendered on request like any other and its wikis served as built.
 */
export function exampleRoutes(deps: Deps): Route[] {
  async function index(): Promise<ExampleIndex | null> {
    const stored = await deps.objects.get(`${EXAMPLE_PREFIX}index.json`);
    if (stored === null) return null;
    return ExampleIndex.parse(JSON.parse(new TextDecoder().decode(stored.body)));
  }

  /** The snapshot's project of that slug, or null for any other path. */
  async function projectOf(slug: string): Promise<string | null> {
    const found = await index();
    return found?.projects.find((p) => p.slug === slug)?.slug ?? null;
  }

  return [
    {
      method: "GET",
      pattern: "/example",
      handler: async () => {
        const found = await index();
        if (found === null) return notFound();
        const projects = [];
        for (const { slug, publishedAt } of found.projects) {
          const entry = await storedEntry(deps.objects, `${EXAMPLE_PREFIX}${slug}/`);
          if (entry !== null)
            projects.push({ slug, href: `/example/${slug}/`, entry, publishedAt });
        }
        const asOf =
          found.projects
            .map((p) => p.publishedAt)
            .sort()
            .at(-1) ?? deps.now();
        const { login, displayName } = found.person;
        const body = biographyPage(deps, { login, displayName }, projects, {
          asOf,
          self: "/example",
          preview: false,
          example: true,
          ...(found.person.avatar === undefined ? {} : { avatarUrl: AVATAR_PATH }),
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
      // A slug is kebab-case, so no project's path can be this one.
      pattern: AVATAR_PATH,
      handler: async () => {
        const avatar = (await index())?.person.avatar;
        const stored =
          avatar === undefined ? null : await deps.objects.get(`${EXAMPLE_PREFIX}${avatar}`);
        if (avatar === undefined || stored === null) return notFound();
        return {
          status: 200,
          headers: { ...PUBLIC, "content-type": contentTypeFor(avatar) },
          body: stored.body,
        };
      },
    },
    {
      method: "GET",
      pattern: "/example/:slug",
      handler: async (request) => {
        const slug = await projectOf(request.params.slug ?? "");
        return slug === null ? notFound() : moved(`/example/${slug}/`);
      },
    },
    {
      method: "GET",
      pattern: "/example/:slug/*",
      handler: async (request) => {
        const slug = await projectOf(request.params.slug ?? "");
        if (slug === null) return notFound();
        const prefix = `${EXAMPLE_PREFIX}${slug}/${SITE_DIR}`;
        const file = await serveTreeFile(deps.objects, prefix, request.params["*"] ?? "");
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
      pattern: "/example/*",
      // Only `/example/` reaches here: every longer path matched a route above.
      handler: async (request) =>
        (request.params["*"] ?? "") === "" ? moved("/example") : notFound(),
    },
  ];
}
