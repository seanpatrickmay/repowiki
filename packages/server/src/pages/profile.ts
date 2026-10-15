import { madeWith } from "../render/portfolio.ts";
import { escapeHtml as e } from "./layout.ts";
import { PUBLIC_STYLE_PATH } from "./public-style.ts";

export interface ProfileEntry {
  slug: string;
  title: string;
  tagline: string;
  publishedAt: string;
}

/** `/<handle>`: the author's published projects (Contract §9), newest first. */
export function profilePage(input: {
  handle: string;
  displayName: string;
  entries: readonly ProfileEntry[];
  appOrigin: string;
}): string {
  const cards = input.entries
    .map(
      (p) =>
        `<li><a href="/${e(input.handle)}/${e(p.slug)}"><strong>${e(p.title)}</strong></a><p>${e(p.tagline)}</p><p class="meta">Published ${e(p.publishedAt.slice(0, 10))}</p></li>`,
    )
    .join("");
  const list = cards ? `<ul class="projects">${cards}</ul>` : "<p>No published projects.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(input.displayName)}</title><link rel="stylesheet" href="${PUBLIC_STYLE_PATH}"></head><body><main><h1>${e(input.displayName)}</h1><p class="meta">@${e(input.handle)}</p>${list}<p class="meta">${madeWith(input.appOrigin)}</p></main></body></html>`;
}
