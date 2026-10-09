/// <reference lib="dom" />
// Wikipedia-style page previews: hovering (or focusing) a link with data-preview shows the
// target's lead and key facts, fetched from <base>api/preview/<id>.json (a Wikipedia article's
// summary from <base>api/preview/wp/<hash>.json). Everything is precomputed at build time and
// same-origin; <base> is the path the site is served under, from the page (base-path.ts).

import { pageBase } from "../base-path.ts";

interface Preview {
  title: string;
  url: string;
  html: string;
}

/** What the script touches, so a test can stand in for the browser. */
export interface PreviewEnv {
  document: Document;
  window: Pick<Window, "setTimeout" | "clearTimeout" | "matchMedia" | "scrollX" | "scrollY">;
  fetch: (url: string) => Promise<Pick<Response, "ok" | "json">>;
}

const SHOW_DELAY_MS = 300;
const HIDE_DELAY_MS = 250;

export function installPreviews({ document, window, fetch }: PreviewEnv): void {
  const cache = new Map<string, Promise<Preview | null>>();
  const base = pageBase(document.documentElement);
  const card = document.createElement("div");
  card.className = "preview-card";
  card.id = "preview-card";
  card.setAttribute("role", "tooltip");
  card.hidden = true;
  document.body.append(card);

  let showTimer = 0;
  let hideTimer = 0;
  let anchor: HTMLAnchorElement | null = null;

  // The id comes from an attribute, so it is encoded into one path segment of a same-origin URL.
  // "wp:<hash>" names a Wikipedia article's preview, which the build wrote under /api/preview/wp/;
  // feature ids are kebab-case, so none can start with "wp:".
  function previewPath(id: string): string {
    return id.startsWith("wp:") ? `wp/${encodeURIComponent(id.slice(3))}` : encodeURIComponent(id);
  }

  function load(id: string): Promise<Preview | null> {
    let pending = cache.get(id);
    if (pending === undefined) {
      pending = fetch(`${base}api/preview/${previewPath(id)}.json`)
        .then((response) => (response.ok ? (response.json() as Promise<Preview | null>) : null))
        .catch(() => null);
      cache.set(id, pending);
    }
    return pending;
  }

  async function show(link: HTMLAnchorElement): Promise<void> {
    const id = link.dataset.preview ?? "";
    if (id === "") return;
    const preview = await load(id);
    if (preview === null || anchor !== link) return;
    const title = document.createElement("a");
    title.className = "preview-title";
    title.href = preview.url;
    title.textContent = preview.title; // plain text, never parsed as HTML
    const body = document.createElement("div");
    body.innerHTML = preview.html; // built and escaped by the site generator, same origin
    card.replaceChildren(title, body);
    card.hidden = false;
    const rect = link.getBoundingClientRect();
    const width = Math.min(352, document.documentElement.clientWidth - 16);
    card.style.width = `${width}px`;
    card.style.left = `${Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 8)) + window.scrollX}px`;
    card.style.top = `${rect.bottom + window.scrollY + 6}px`;
    link.setAttribute("aria-describedby", card.id);
  }

  function hide(): void {
    window.clearTimeout(showTimer);
    card.hidden = true;
    anchor?.removeAttribute("aria-describedby");
    anchor = null;
  }

  function previewLink(target: EventTarget | null): HTMLAnchorElement | null {
    const closest = (target as Element | null)?.closest;
    return typeof closest === "function"
      ? (target as Element).closest<HTMLAnchorElement>("a[data-preview]")
      : null;
  }

  function enter(link: HTMLAnchorElement, delay: number): void {
    window.clearTimeout(hideTimer);
    if (anchor === link) return;
    hide();
    anchor = link;
    showTimer = window.setTimeout(() => void show(link), delay);
  }

  function leave(): void {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, HIDE_DELAY_MS);
  }

  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    document.addEventListener("mouseover", (event) => {
      const link = previewLink(event.target);
      if (link !== null) enter(link, SHOW_DELAY_MS);
      else if (card.contains(event.target as Node)) window.clearTimeout(hideTimer);
    });
    document.addEventListener("mouseout", (event) => {
      if (previewLink(event.target) !== null || card.contains(event.target as Node)) leave();
    });
  }
  document.addEventListener("focusin", (event) => {
    const link = previewLink(event.target);
    if (link !== null) enter(link, 0);
  });
  document.addEventListener("focusout", (event) => {
    if (previewLink(event.target) !== null) leave();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
}

if (typeof document !== "undefined") {
  installPreviews({ document, window, fetch: (url) => window.fetch(url) });
}
