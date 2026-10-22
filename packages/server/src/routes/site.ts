import { readFileSync } from "node:fs";
import type { Deps } from "../app.ts";
import type { Route } from "../http/router.ts";
import { SITE_PAGES, SITE_STYLE, SITE_STYLE_PATH, sitePage } from "../pages/site.ts";

/** The same for every visitor, so the CDN may keep it a few minutes (ADR-0016). */
const CACHED = { "cache-control": "public, max-age=300" };
const EXAMPLE_IMAGE = readFileSync(new URL("../pages/assets/example-top.jpg", import.meta.url));

/** The public site on the pages origin (ADR-0016): its pages, style sheet and one image. */
export function siteRoutes(deps: Deps): Route[] {
  return [
    ...Object.entries(SITE_PAGES).map(
      ([path, page]): Route => ({
        method: "GET",
        pattern: path,
        handler: async () => ({
          status: 200,
          headers: { ...CACHED, "content-type": "text/html; charset=utf-8" },
          body: sitePage(deps.config, page),
        }),
      }),
    ),
    {
      method: "GET",
      pattern: SITE_STYLE_PATH,
      handler: async () => ({
        status: 200,
        headers: { ...CACHED, "content-type": "text/css; charset=utf-8" },
        body: SITE_STYLE,
      }),
    },
    {
      method: "GET",
      pattern: "/_app/example-top.jpg",
      handler: async () => ({
        status: 200,
        headers: { ...CACHED, "content-type": "image/jpeg" },
        body: EXAMPLE_IMAGE,
      }),
    },
  ];
}
