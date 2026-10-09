/// <reference lib="dom" />
// Mounts the Pagefind UI (written into <base>pagefind/ at build time) and runs the header query.

import { pageBase } from "../base-path.ts";

interface PagefindUIInstance {
  triggerSearch(term: string): void;
}

export interface PagefindUIOptions {
  element: string;
  showSubResults: boolean;
  showImages: boolean;
  resetStyles: boolean;
  /** Where the index is: under the base, like every URL the site writes. */
  bundlePath: string;
  /** Prefixed to each result's URL, which Pagefind indexed relative to the site's root. */
  baseUrl: string;
}

export type PagefindUIConstructor = new (options: PagefindUIOptions) => PagefindUIInstance;

/** Mounts the search UI under the page's base, and searches for the query string's `q`. */
export function mountSearch(
  UI: PagefindUIConstructor,
  root: { dataset: { base?: string | undefined } },
  search: string,
): void {
  const base = pageBase(root);
  const ui = new UI({
    element: "#search",
    showSubResults: true,
    showImages: false,
    resetStyles: false,
    bundlePath: `${base}pagefind/`,
    baseUrl: base,
  });
  const query = new URLSearchParams(search).get("q");
  if (query !== null && query.trim() !== "") ui.triggerSearch(query);
}

declare const PagefindUI: PagefindUIConstructor;

if (typeof document !== "undefined") {
  mountSearch(PagefindUI, document.documentElement, window.location.search);
}
